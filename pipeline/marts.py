"""Run sql/02_marts/ in order -> upgauge.duckdb.

Each .sql file declares its own object name and materialization in a header directive, so the
directory is self-describing and there is no manifest to fall out of sync with it.

The only SQL in this module is the DDL wrapper. Query logic stays in .sql, same as
normalize.py's COPY wrapper.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

MARTS_DIR = Path(__file__).parents[1] / "sql" / "02_marts"
PARQUET_ROOT_TOKEN = "{{PARQUET_ROOT}}"
MATERIALIZATIONS = frozenset({"view", "table"})

_DIRECTIVE = re.compile(r"^--\s*(upgauge|object)\s*:\s*(\S+)\s*$")  # note: no MULTILINE


class MartError(Exception):
    """A mart file is malformed, or its SQL failed."""


@dataclass(frozen=True)
class MartFile:
    path: Path
    object_name: str
    materialization: str
    body: str


def parse_mart_file(path: Path) -> MartFile:
    """Parse one mart file's header directives.

    Directives are read ONLY from the leading comment block, and a repeated directive is
    an error. Scanning the whole file would let a stray `-- object:` line in the SQL body
    -- a leftover from copy-pasting a template -- silently win and rename the object,
    which is the same class of silent-wrong-answer this module's loud failures exist to
    prevent.
    """
    path = Path(path)
    text = path.read_text()

    found: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue  # blank lines inside the header are fine
        if not stripped.startswith("--"):
            break  # header block ends at the first line of real SQL
        match = _DIRECTIVE.match(stripped)
        if match is None:
            continue
        key, value = match.group(1), match.group(2)
        if key in found:
            raise MartError(f"{path.name}: duplicate `-- {key}:` directive in the header")
        found[key] = value

    if "object" not in found:
        raise MartError(f"{path.name}: no `-- object:` directive")
    if "upgauge" not in found:
        raise MartError(f"{path.name}: no `-- upgauge:` materialization directive")
    if found["upgauge"] not in MATERIALIZATIONS:
        raise MartError(
            f"{path.name}: unknown materialization {found['upgauge']!r} "
            f"(expected one of {sorted(MATERIALIZATIONS)})"
        )
    return MartFile(path, found["object"], found["upgauge"], text)


def mart_files(marts_dir: Path = MARTS_DIR) -> list[MartFile]:
    """Every mart, in filename order. Numeric prefixes are the ordering mechanism."""
    return [parse_mart_file(p) for p in sorted(Path(marts_dir).glob("*.sql"))]


def build_database(parquet_dir: Path, db_path: Path, marts_dir: Path = MARTS_DIR) -> list[str]:
    """Build upgauge.duckdb. Returns the object names created, in order.

    `parquet_dir` is substituted verbatim and deliberately NOT resolved: DuckDB resolves
    relative paths against the process CWD, so a relative root works in CI and in Docker
    while an absolute one silently fails every read inside the container.

    Builds into a staging file and renames on success, mirroring `normalize_year`. DuckDB
    DDL auto-commits, so building in place would mean a failure on mart 3 of 5 leaves a
    database that opens fine and silently contains only marts 1-2 -- after having already
    deleted the working one. In M6 that is the monthly cron clobbering a good database with
    a partial one while the site keeps serving.
    """
    db_path = Path(db_path)
    staging = db_path.with_name(db_path.name + ".incoming")
    for p in (staging, Path(str(staging) + ".wal")):
        p.unlink(missing_ok=True)

    con = duckdb.connect(str(staging))
    con.execute("SET threads TO 1")

    created: list[str] = []
    try:
        for mart in mart_files(marts_dir):
            body = mart.body.replace(PARQUET_ROOT_TOKEN, str(parquet_dir))
            kind = "VIEW" if mart.materialization == "view" else "TABLE"
            try:
                con.execute(f"CREATE OR REPLACE {kind} {mart.object_name} AS {body}")
            except Exception as exc:
                raise MartError(f"{mart.path.name}: {exc}") from exc
            created.append(mart.object_name)
    except Exception:
        con.close()
        staging.unlink(missing_ok=True)
        Path(str(staging) + ".wal").unlink(missing_ok=True)
        raise
    con.close()

    # Only now is the old database expendable.
    Path(str(db_path) + ".wal").unlink(missing_ok=True)
    staging.replace(db_path)
    return created


def _digest_object(con: duckdb.DuckDBPyConnection, name: str, out_dir: Path) -> str:
    """sha256 of one object, exported with the same threads = 1 setting the writer uses.

    The .duckdb file itself is NEVER hashed. Measured in Task 1: it is not byte-stable even
    single-threaded -- three identical builds produced three different digests, reproducibly.
    Exporting each object through a Parquet write that IS byte-stable is the only content
    guarantee available. See docs/data/invariants.md.

    Deliberate exception to "all Parquet writes go through _writer_connection()": the export
    has to run on the connection that holds the objects, so it cannot use a fresh connection.
    It applies the same `SET threads TO 1` that makes _writer_connection byte-stable -- the
    caller sets it. If that SET is ever dropped, this gate reports false failures.
    """
    import hashlib

    target = Path(out_dir) / f"{name}.parquet"
    con.execute(f"COPY (SELECT * FROM {name}) TO '{target}' (FORMAT PARQUET)")
    return hashlib.sha256(target.read_bytes()).hexdigest()


@dataclass
class DatabaseReport:
    objects: int = 0
    differing: list[str] = field(default_factory=list)

    @property
    def reproducible(self) -> bool:
        return not self.differing


def verify_database(parquet_dir: Path, work_dir: Path | None = None) -> DatabaseReport:
    """Build upgauge.duckdb twice and compare every object's contents.

    Reports rather than raises, so a drifting object is named.
    """
    import shutil
    import tempfile

    owned = work_dir is None
    work_dir = Path(work_dir or tempfile.mkdtemp(prefix="upguage-verify-db-"))
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        digests: list[dict[str, str]] = []
        for run in ("a", "b"):
            out = work_dir / run
            if out.exists():
                shutil.rmtree(out)
            out.mkdir(parents=True)
            names = build_database(parquet_dir, out / "upgauge.duckdb")
            con = duckdb.connect(str(out / "upgauge.duckdb"))
            con.execute("SET threads TO 1")
            try:
                digests.append({n: _digest_object(con, n, out) for n in names})
            finally:
                con.close()

        a, b = digests
        differing = sorted(set(a) ^ set(b) | {n for n in set(a) & set(b) if a[n] != b[n]})
        return DatabaseReport(objects=len(a), differing=differing)
    finally:
        if owned:
            shutil.rmtree(work_dir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    """`make build`."""
    import argparse
    import logging

    parser = argparse.ArgumentParser(description="Build upgauge.duckdb from sql/02_marts/.")
    parser.add_argument("--parquet-dir", type=Path, default=Path("data/parquet"))
    parser.add_argument("--db", type=Path, default=Path("upgauge.duckdb"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    log = logging.getLogger("build")
    for name in build_database(args.parquet_dir, args.db):
        log.info("  %s", name)
    log.info("ok -> %s", args.db)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
