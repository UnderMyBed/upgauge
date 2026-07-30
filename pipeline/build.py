"""Build the whole warehouse from `data/raw/`, and prove the build is reproducible.

`verify_reproducible` is the M1 exit criterion: build everything twice from identical raw
inputs and compare every artifact byte-for-byte. If that fails, M2's "reproducible from
scratch via make" guarantee is already broken, and the failure is much cheaper to find here
than after a mart disagrees with itself.
"""

from __future__ import annotations

import hashlib
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from pipeline.dims import (
    build_aircraft_type_dim,
    build_airport_dim,
    build_carrier_dim,
    build_city_market_dim,
    build_mainline_map,
)
from pipeline.fetch import T100D_SEGMENT_US, Table, latest_raw
from pipeline.lookups import AIRCRAFT_TYPES, CARRIER_DECODE, MASTER_COORDINATE
from pipeline.normalize import NormalizeError, discover_raw_years, normalize_year

FACTS_SUBDIR = "t100_segment"
DIMS_SUBDIR = "dims"


def _require(raw_dir: Path, table: Table) -> Path:
    """The latest download for a reference table, or a loud failure.

    Building a warehouse without one of these would silently orphan every join that uses it,
    which is worse than not building at all.
    """
    path = latest_raw(raw_dir, table)
    if path is None:
        raise NormalizeError(
            f"no raw download for {table.slug} — run `make fetch-reference` "
            f"(expected {table.slug}_YYYYMMDD.zip in {raw_dir})"
        )
    return path


def build_all(raw_dir: Path, out_dir: Path) -> list[Path]:
    """Normalize every cached fact year and build all five dimensions.

    Returns the artifacts written. Raises if anything required is missing.
    """
    raw_dir, out_dir = Path(raw_dir), Path(out_dir)

    years = discover_raw_years(raw_dir)
    if not years:
        raise NormalizeError(f"no fact years in {raw_dir} — run `make fetch` first")

    # Fail on missing references before doing any work, so a broken run doesn't leave a
    # half-populated warehouse behind.
    sources = {
        "airport": _require(raw_dir, MASTER_COORDINATE),
        "carrier": _require(raw_dir, CARRIER_DECODE),
        "aircraft_type": _require(raw_dir, AIRCRAFT_TYPES),
    }

    written: list[Path] = []
    facts = out_dir / FACTS_SUBDIR
    for year in years:
        # latest_raw, not any download: superseded ones are audit-only.
        zip_path = latest_raw(raw_dir, T100D_SEGMENT_US, year)
        normalize_year(zip_path, facts, year)
        written.append(facts / f"year={year}")

    dims = out_dir / DIMS_SUBDIR
    written.append(build_airport_dim(sources["airport"], dims))
    written.append(build_city_market_dim(sources["airport"], dims))
    written.append(build_carrier_dim(sources["carrier"], dims))
    written.append(build_aircraft_type_dim(sources["aircraft_type"], dims))
    written.append(build_mainline_map(dims))
    return written


@dataclass
class ReproducibilityReport:
    artifacts: int = 0
    differing: list[str] = field(default_factory=list)

    @property
    def reproducible(self) -> bool:
        return not self.differing


def _digest_tree(root: Path) -> dict[str, str]:
    """sha256 of every Parquet file, keyed by path relative to `root`."""
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(Path(root).rglob("*.parquet"))
    }


def verify_reproducible(raw_dir: Path, work_dir: Path | None = None) -> ReproducibilityReport:
    """Build twice from the same raw inputs and compare every artifact byte-for-byte.

    Reports rather than raises: a drifting build should name the offending artifact, not
    just fail.
    """
    raw_dir = Path(raw_dir)
    owned = work_dir is None
    work_dir = Path(work_dir or tempfile.mkdtemp(prefix="upguage-verify-"))
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        first, second = work_dir / "build-a", work_dir / "build-b"
        for target in (first, second):
            if target.exists():
                shutil.rmtree(target)
            build_all(raw_dir, target)

        a, b = _digest_tree(first), _digest_tree(second)
        differing = sorted(
            set(a) ^ set(b) | {name for name in set(a) & set(b) if a[name] != b[name]}
        )
        return ReproducibilityReport(artifacts=len(a), differing=differing)
    finally:
        if owned:
            shutil.rmtree(work_dir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    """`make verify`."""
    import argparse
    import logging

    parser = argparse.ArgumentParser(description="Build the warehouse and verify reproducibility.")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--out-dir", type=Path, default=Path("data/parquet"))
    parser.add_argument(
        "--verify", action="store_true", help="build twice and compare instead of building once"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    log = logging.getLogger("build")

    if not args.verify:
        for path in build_all(args.raw_dir, args.out_dir):
            log.info("  %s", path)
        return 0

    report = verify_reproducible(args.raw_dir)
    if not report.reproducible:
        log.error("NOT reproducible — %d Parquet artifact(s) differ:", len(report.differing))
        for name in report.differing:
            log.error("    %s", name)
        return 1
    log.info("parquet: %d artifacts byte-identical across two builds", report.artifacts)

    from pipeline.marts import verify_database

    db_report = verify_database(args.out_dir)
    if not db_report.reproducible:
        log.error("NOT reproducible — %d database object(s) differ:", len(db_report.differing))
        for name in db_report.differing:
            log.error("    %s", name)
        return 1
    log.info("database: %d objects identical across two builds", db_report.objects)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
