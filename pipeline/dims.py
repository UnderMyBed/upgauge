"""Reference tables -> dimension Parquet.

Each dimension is a `.sql` file in `sql/01_staging/` run against the extracted CSV, for the
same reason as normalize: the definitions have to be shareable with the server.

`map_mainline_group` is different — its source is the checked-in
`pipeline/reference/mainline_group.csv`, which is validated on load rather than transformed.
"""

from __future__ import annotations

from pathlib import Path

import duckdb

from pipeline.mainline_map import load_mainline_map
from pipeline.normalize import SQL_DIR, NormalizeError, _extracted_csv


def _build(zip_path: Path, out_dir: Path, sql_name: str, out_name: str) -> Path:
    """Run one staging SQL file against a reference zip, writing a single Parquet file."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{out_name}.parquet"
    sql = (SQL_DIR / sql_name).read_text()

    con = duckdb.connect()
    with _extracted_csv(Path(zip_path)) as csv_path:
        staging = out_dir / f".{out_name}.incoming.parquet"
        con.execute(f"COPY ({sql}) TO '{staging}' (FORMAT PARQUET)", {"csv_path": str(csv_path)})
        staging.replace(target)
    return target


def build_airport_dim(zip_path: Path, out_dir: Path) -> Path:
    """Master Coordinate -> dim_airport. Keeps every seq id, including closed airports."""
    return _build(zip_path, out_dir, "dim_airport.sql", "dim_airport")


def build_carrier_dim(zip_path: Path, out_dir: Path) -> Path:
    """Carrier Decode -> dim_carrier, one row per airline_id."""
    return _build(zip_path, out_dir, "dim_carrier.sql", "dim_carrier")


def build_aircraft_type_dim(zip_path: Path, out_dir: Path) -> Path:
    """AircraftTypes -> dim_aircraft_type. Codes stay strings."""
    return _build(zip_path, out_dir, "dim_aircraft_type.sql", "dim_aircraft_type")


def build_mainline_map(out_dir: Path, csv_path: Path | None = None) -> Path:
    """Materialize the checked-in rollup map.

    `load_mainline_map` validates it (no overlapping ranges, no parent mapped as a child)
    and raises if it is incoherent, so an invalid map can never reach the warehouse.

    Open-ended ranges stay NULL rather than a sentinel — a `9999-12` in stored data would
    eventually leak into the UI.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "map_mainline_group.parquet"

    mapping = load_mainline_map(csv_path)
    if not mapping.entries:
        raise NormalizeError("mainline_group.csv produced no rows")

    rows = [
        (
            e.airline_id,
            e.carrier_code,
            e.parent_airline_id,
            e.parent_code,
            e.effective_from,
            e.effective_to,
            e.note,
        )
        for e in mapping.entries
    ]
    con = duckdb.connect()
    con.execute(
        """
        CREATE TABLE m (
            airline_id INTEGER, carrier_code VARCHAR,
            parent_airline_id INTEGER, parent_code VARCHAR,
            effective_from VARCHAR, effective_to VARCHAR, note VARCHAR
        )
        """
    )
    con.executemany("INSERT INTO m VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
    con.execute(f"COPY (SELECT * FROM m ORDER BY airline_id) TO '{target}' (FORMAT PARQUET)")
    return target
