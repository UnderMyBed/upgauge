"""Raw BTS zip -> partitioned Parquet.

The transform itself is `sql/01_staging/normalize_t100_segment.sql`; this module extracts
the CSV, runs the pre-flight checks that must happen *before* filtering, and writes the
partition. Keeping the SQL in a file is what lets the server reuse the same definitions.

Pre-flight checks run on the raw extract on purpose: the rollup-class check has to see class
`K`/`V`/`Z` rows, and the filter in the SQL would have already dropped them.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import duckdb

from pipeline.fetch import T100D_SEGMENT_US, cache_path
from pipeline.invariants import (
    PASSENGER_CONFIGS,
    SCHEDULED_PASSENGER_CLASS,
    InvariantError,
    check_columns,
    check_no_rollup_classes,
)

SQL_DIR = Path(__file__).parents[1] / "sql" / "01_staging"
SQL_PATH = SQL_DIR / "normalize_t100_segment.sql"

#: Every reason the SQL can emit. Kept in sync by test_every_reason_used_is_a_known_reason.
QUARANTINE_REASONS = frozenset({"missing_carrier", "zero_seats", "load_factor_gt_1"})


class NormalizeError(InvariantError):
    """The extract could not be normalized — schema drift or a violated invariant."""


@contextmanager
def _extracted_csv(zip_path: Path) -> Iterator[Path]:
    """Yield the data CSV from a BTS zip, extracted to a temp dir.

    `data/raw/` is the audit trail and is never mutated, so extraction goes elsewhere.
    """
    with zipfile.ZipFile(zip_path) as z:
        members = [
            n
            for n in z.namelist()
            if n.lower().endswith(".csv") and "documentation" not in n.lower()
        ]
        if len(members) != 1:
            raise NormalizeError(f"{zip_path.name}: expected 1 data CSV, found {members}")
        with tempfile.TemporaryDirectory(prefix="upguage-normalize-") as tmp:
            z.extract(members[0], tmp)
            yield Path(tmp) / members[0]


def _preflight(con: duckdb.DuckDBPyConnection, csv_path: Path) -> None:
    """Checks that must run against the raw extract, before any filtering."""
    columns = [
        r[0]
        for r in con.execute(
            "DESCRIBE SELECT * FROM read_csv($p, all_varchar = true, header = true)",
            {"p": str(csv_path)},
        ).fetchall()
    ]
    try:
        check_columns(columns)
    except InvariantError as exc:
        raise NormalizeError(str(exc)) from exc

    classes = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT CLASS FROM read_csv($p, all_varchar = true, header = true)",
            {"p": str(csv_path)},
        ).fetchall()
        if r[0] is not None
    ]
    try:
        check_no_rollup_classes(classes)
    except InvariantError as exc:
        raise NormalizeError(str(exc)) from exc


def parquet_partition(out_dir: Path, year: int) -> Path:
    """Hive-style partition path, so DuckDB can prune without reading."""
    return Path(out_dir) / f"year={year}"


def _download_date(zip_path: Path) -> str:
    """Read the fetch sidecar. Its absence is an error, not a default — a guessed date
    would silently corrupt amended-filing resolution."""
    sidecar = zip_path.with_suffix(".json")
    if not sidecar.exists():
        raise NormalizeError(f"{zip_path.name}: no sidecar at {sidecar.name}; re-run the fetch")
    date = json.loads(sidecar.read_text()).get("download_date")
    if not date:
        raise NormalizeError(f"{sidecar.name}: no download_date")
    return date


def normalize_year(zip_path: Path, out_dir: Path, year: int) -> Path:
    """Normalize one raw year-zip into `out_dir/year=YYYY/`. Returns `out_dir`.

    Replaces the partition rather than appending, so a re-run can't double every row.
    """
    zip_path, out_dir = Path(zip_path), Path(out_dir)
    partition = parquet_partition(out_dir, year)
    con = duckdb.connect()

    with _extracted_csv(zip_path) as csv_path:
        _preflight(con, csv_path)

        # Write to a sibling temp dir and swap, so a failure mid-write can't leave a
        # half-written partition that later reads would treat as complete.
        staging = out_dir / f".{partition.name}.incoming"
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)

        con.execute(
            f"COPY ({SQL_PATH.read_text()}) TO '{staging / 'part.parquet'}' (FORMAT PARQUET)",
            {
                "csv_path": str(csv_path),
                "scheduled_class": SCHEDULED_PASSENGER_CLASS,
                "passenger_configs": sorted(PASSENGER_CONFIGS),
                "download_date": _download_date(zip_path),
            },
        )

        if partition.exists():
            shutil.rmtree(partition)
        staging.rename(partition)

    return out_dir


def discover_raw_years(raw_dir: Path) -> list[int]:
    """The years present in `raw_dir`, sorted. Ignores sidecars and unparseable names."""
    years = []
    for path in Path(raw_dir).glob(f"{T100D_SEGMENT_US.slug}_*.zip"):
        stem = path.stem.rsplit("_", 1)[-1]
        if stem.isdigit():
            years.append(int(stem))
    return sorted(years)


def main(argv: list[str] | None = None) -> int:
    """`make ingest` normalize step: every cached raw year -> data/parquet/."""
    import argparse
    import logging

    parser = argparse.ArgumentParser(description="Normalize raw BTS zips into Parquet.")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--out-dir", type=Path, default=Path("data/parquet/t100_segment"))
    parser.add_argument("--year", type=int, action="append", help="only these years")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    log = logging.getLogger("normalize")

    years = discover_raw_years(args.raw_dir)
    if args.year:
        years = [y for y in years if y in set(args.year)]

    if not years:
        # An empty data/raw means the fetch never ran. Doing nothing quietly would look
        # exactly like success.
        log.error("nothing to normalize in %s — run `make fetch` first", args.raw_dir)
        return 1

    failures: list[int] = []
    for year in years:
        zip_path = cache_path(args.raw_dir, T100D_SEGMENT_US, year)
        try:
            normalize_year(zip_path, args.out_dir, year)
            log.info("%s  ok", year)
        except Exception as exc:  # noqa: BLE001 — report every year, fail at the end
            log.error("%s  FAILED: %s", year, exc)
            failures.append(year)

    if failures:
        log.error("%d of %d years failed: %s", len(failures), len(years), failures)
        return 1
    log.info("ok — %d years in %s", len(years), args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
