"""Run sql/02_marts/ in order -> upgauge.duckdb.

Each .sql file declares its own object name and materialization in a header directive, so the
directory is self-describing and there is no manifest to fall out of sync with it.

The only SQL in this module is the DDL wrapper. Query logic stays in .sql, same as
normalize.py's COPY wrapper.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import duckdb

MARTS_DIR = Path(__file__).parents[1] / "sql" / "02_marts"
PARQUET_ROOT_TOKEN = "{{PARQUET_ROOT}}"
MATERIALIZATIONS = frozenset({"view", "table"})

_DIRECTIVE = re.compile(r"^--\s*(upgauge|object)\s*:\s*(\S+)\s*$", re.MULTILINE)


class MartError(Exception):
    """A mart file is malformed, or its SQL failed."""


@dataclass(frozen=True)
class MartFile:
    path: Path
    object_name: str
    materialization: str
    body: str


def parse_mart_file(path: Path) -> MartFile:
    path = Path(path)
    text = path.read_text()
    found = {k: v for k, v in _DIRECTIVE.findall(text)}

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
    """
    db_path = Path(db_path)
    db_path.unlink(missing_ok=True)
    Path(str(db_path) + ".wal").unlink(missing_ok=True)

    con = duckdb.connect(str(db_path))
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
    finally:
        con.close()
    return created


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
