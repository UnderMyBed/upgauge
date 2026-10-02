"""Reference tables -> dimension Parquet.

Each dimension is a `.sql` file in `sql/01_staging/` run against the extracted CSV, for the
same reason as normalize: the definitions have to be shareable with the server.

`map_mainline_group` is not here: it is a function of the checked-in
`pipeline/reference/mainline_group.csv`, not of BTS, so `make build` materializes it into the
database (`sql/02_marts/024_map_mainline_group.sql`) rather than the warehouse writing it.
"""

from __future__ import annotations

from pathlib import Path

from pipeline.normalize import SQL_DIR, _extracted_csv, _writer_connection


def _build(zip_path: Path, out_dir: Path, sql_name: str, out_name: str) -> Path:
    """Run one staging SQL file against a reference zip, writing a single Parquet file."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{out_name}.parquet"
    sql = (SQL_DIR / sql_name).read_text()

    con = _writer_connection()
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


def build_city_market_dim(zip_path: Path, out_dir: Path) -> Path:
    """Master Coordinate -> dim_city_market, one row per city_market_id.

    Same zip as dim_airport, so this costs no extra fetch.
    """
    return _build(zip_path, out_dir, "dim_city_market.sql", "dim_city_market")


def build_aircraft_type_dim(zip_path: Path, out_dir: Path) -> Path:
    """AircraftTypes -> dim_aircraft_type. Codes stay strings."""
    return _build(zip_path, out_dir, "dim_aircraft_type.sql", "dim_aircraft_type")
