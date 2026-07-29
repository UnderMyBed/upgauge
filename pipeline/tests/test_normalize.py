"""Tests for raw zip -> partitioned Parquet.

The fixture is 106 *real* rows pulled from the 2015 extract, curated so every edge case the
invariants care about is present: carrier-less rows, flown-but-seatless legs, load factor
over 1, no-service filings, combi, seaplane, freighters, zero-padded type codes, and the
carriers whose rollup behaviour differs.

Assertions go through DuckDB against the written Parquet rather than through a DataFrame —
the Parquet schema is the artifact that matters, and pandas' nullable-int coercion would
obscure it. It also keeps pandas/numpy out of the dependency set.
"""

from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path

import duckdb
import pytest

from pipeline.normalize import (
    QUARANTINE_REASONS,
    NormalizeError,
    normalize_year,
    parquet_partition,
)

FIXTURE = Path(__file__).parent / "fixtures" / "t100d_segment_sample_2015.zip"


@pytest.fixture
def out_dir(tmp_path):
    return tmp_path / "parquet"


@pytest.fixture
def seg(out_dir):
    """A connection with the normalized output available as `seg`."""
    normalize_year(FIXTURE, out_dir, year=2015)
    con = duckdb.connect()
    con.execute(f"CREATE VIEW seg AS SELECT * FROM read_parquet('{out_dir}/**/*.parquet')")
    return con


def one(con=None, sql: str = "", *, seg=None):
    return (con or seg).execute(sql).fetchone()[0]


def _rewrite_fixture(dest: Path, mutate) -> Path:
    """Copy the fixture zip with `mutate` applied to its parsed rows.

    Goes through the csv module rather than str.split(',') — ORIGIN_CITY_NAME and
    DEST_CITY_NAME are quoted and contain commas, so naive splitting misaligns every field
    after them (45 header fields vs 47 apparent row fields).
    """
    with zipfile.ZipFile(FIXTURE) as z:
        name = next(n for n in z.namelist() if "Documentation" not in n)
        reader = csv.DictReader(io.StringIO(z.read(name).decode()))
        fields = reader.fieldnames
        rows = mutate(list(reader))

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    with zipfile.ZipFile(dest, "w") as z:
        z.writestr(name, buf.getvalue())
    dest.with_suffix(".json").write_text('{"download_date": "2026-07-29"}')
    return dest


def col_types(con) -> dict[str, str]:
    return {r[0]: r[1].upper() for r in con.execute("DESCRIBE SELECT * FROM seg").fetchall()}


# ------------------------------------------------------------------ layout


def test_writes_a_year_partition(out_dir):
    normalize_year(FIXTURE, out_dir, year=2015)
    assert parquet_partition(out_dir, 2015).exists()


def test_partition_is_hive_style(out_dir):
    """`year=YYYY/` so DuckDB can prune partitions without reading them."""
    assert parquet_partition(out_dir, 2015).name == "year=2015"


def test_leaves_no_staging_directory_behind(out_dir):
    normalize_year(FIXTURE, out_dir, year=2015)
    assert [p.name for p in out_dir.iterdir() if p.name.startswith(".")] == []


# ------------------------------------------------------------------ typing


def test_zero_padded_aircraft_type_stays_a_string(seg):
    """`079` int-parsed becomes `79` and the dim join breaks silently."""
    assert col_types(seg)["aircraft_type"] == "VARCHAR"
    padded = one(seg, "SELECT count(*) FROM seg WHERE aircraft_type LIKE '0%'")
    assert padded > 0, "fixture should contain zero-padded type codes"
    assert one(seg, "SELECT count(*) FROM seg WHERE length(aircraft_type) <> 3") == 0


def test_ids_are_integers(seg):
    """Join keys. Strings would work but defeat pruning and invite silent mismatches."""
    types = col_types(seg)
    for name in (
        "op_airline_id",
        "origin_airport_id",
        "dest_airport_id",
        "origin_city_market_id",
        "dest_city_market_id",
    ):
        assert "INT" in types[name], (name, types[name])


def test_year_month_is_a_sortable_string(seg):
    assert col_types(seg)["year_month"] == "VARCHAR"
    assert one(seg, "SELECT count(*) FROM seg WHERE year_month NOT SIMILAR TO '\\d{4}-\\d{2}'") == 0


def test_month_is_zero_padded_so_it_sorts(seg):
    """'2015-9' would sort after '2015-10'. Every time-series in the product depends on this."""
    assert one(seg, "SELECT count(*) FROM seg WHERE length(year_month) <> 7") == 0


# ------------------------------------------------------------------ filtering


def test_only_scheduled_passenger_service_survives(seg):
    """Class G (scheduled cargo) and L (charter) are in the fixture and must be dropped."""
    assert one(seg, "SELECT count(DISTINCT service_class) FROM seg") == 1
    assert one(seg, "SELECT count(*) FROM seg WHERE service_class <> 'F'") == 0
    assert one(seg, "SELECT count(*) FROM seg WHERE aircraft_config NOT IN (1,3,4)") == 0


@pytest.mark.parametrize("config", [3, 4])
def test_combi_and_seaplane_rows_survive(seg, config):
    """The whole reason the filter is IN (1,3,4) rather than = 1."""
    assert one(seg, f"SELECT count(*) FROM seg WHERE aircraft_config = {config}") > 0


# ------------------------------------------------------------------ quarantine


def test_quarantine_flag_and_reason_agree(seg):
    assert (
        one(seg, "SELECT count(*) FROM seg WHERE is_quarantined AND quarantine_reason IS NULL") == 0
    )
    assert (
        one(
            seg,
            "SELECT count(*) FROM seg WHERE NOT is_quarantined AND quarantine_reason IS NOT NULL",
        )
        == 0
    )


def test_every_reason_used_is_a_known_reason(seg):
    used = {
        r[0] for r in seg.execute("SELECT DISTINCT quarantine_reason FROM seg").fetchall() if r[0]
    }
    assert used <= QUARANTINE_REASONS, f"unknown reason: {used - QUARANTINE_REASONS}"


@pytest.mark.parametrize("reason", ["zero_seats", "load_factor_gt_1"])
def test_each_quarantine_reason_fires_on_real_rows(seg, reason):
    """The fixture contains real rows for both, so a missing one means a broken rule.

    `missing_carrier` is not here on purpose — see the next test.
    """
    assert one(seg, f"SELECT count(*) FROM seg WHERE quarantine_reason = '{reason}'") > 0


def test_no_carrier_less_rows_reach_the_ingested_subset(seg):
    """All 158 carrier-less rows in 2015 are CLASS='L' (charter), which v0 does not ingest.

    So on real data the service filter removes them before quarantine ever applies. Asserted
    rather than assumed: if a carrier-less *scheduled* row ever appears, the rule below
    catches it, and this test tells us the situation changed.
    """
    assert one(seg, "SELECT count(*) FROM seg WHERE op_airline_id IS NULL") == 0


def test_a_carrier_less_scheduled_row_would_be_quarantined(tmp_path, out_dir):
    """The defensive case. Constructed, because real data has no such row today."""

    def blank_the_carrier(rows):
        for row in rows:
            if row["CLASS"] == "F" and row["AIRCRAFT_CONFIG"] == "1":
                for field in ("AIRLINE_ID", "UNIQUE_CARRIER", "UNIQUE_CARRIER_NAME"):
                    row[field] = ""
                break
        return rows

    zip_path = _rewrite_fixture(tmp_path / "orphan.zip", blank_the_carrier)
    normalize_year(zip_path, out_dir, year=2015)
    con = duckdb.connect()
    con.execute(f"CREATE VIEW seg AS SELECT * FROM read_parquet('{out_dir}/**/*.parquet')")
    assert (
        one(seg=con, sql="SELECT count(*) FROM seg WHERE quarantine_reason = 'missing_carrier'")
        == 1
    )


def test_load_factor_over_one_is_not_clamped(seg):
    """Quarantine, never clamp — clamping invents a plausible number."""
    assert (
        one(
            seg,
            "SELECT count(*) FROM seg WHERE quarantine_reason = 'load_factor_gt_1' "
            "AND passengers <= seats",
        )
        == 0
    )


def test_no_service_rows_are_not_quarantined(seg):
    """Zero departures + zero seats is an ordinary empty filing, not an anomaly."""
    total = one(seg, "SELECT count(*) FROM seg WHERE departures_performed = 0 AND seats = 0")
    assert total > 0, "fixture should contain no-service rows"
    assert (
        one(
            seg,
            "SELECT count(*) FROM seg WHERE departures_performed = 0 AND seats = 0"
            " AND is_quarantined",
        )
        == 0
    )


def test_quarantine_stays_a_small_minority(seg):
    """It is surfaced in the UI as a trust signal, so it must not fire on ordinary data."""
    rate = one(seg, "SELECT count(*) FILTER (WHERE is_quarantined)::DOUBLE / count(*) FROM seg")
    assert rate < 0.2, f"{rate:.1%} quarantined in a fixture deliberately dense with edge cases"


# ------------------------------------------------------------------ derived columns


def test_no_derived_measure_is_stored(seg):
    """Structural enforcement: can't average what doesn't exist."""
    forbidden = {"load_factor", "asm", "rpm", "avg_gauge", "completion_factor"}
    assert forbidden.isdisjoint(col_types(seg))


def test_undirected_route_key_is_stored_sorted(seg):
    assert one(seg, "SELECT count(*) FROM seg WHERE route_key_low > route_key_high") == 0


def test_directional_and_undirected_keys_both_exist(seg):
    assert {
        "origin_airport_id",
        "dest_airport_id",
        "route_key_low",
        "route_key_high",
    } <= set(col_types(seg))


def test_city_market_ids_are_carried(seg):
    """D1 resolved: city market is in. Free at ingest, expensive to retrofit."""
    assert one(seg, "SELECT count(*) FROM seg WHERE origin_city_market_id IS NULL") == 0


def test_download_date_is_stamped_from_the_sidecar(seg):
    """Drives amended-filing resolution — latest download_date wins."""
    assert one(seg, "SELECT count(DISTINCT download_date) FROM seg") == 1
    assert str(one(seg, "SELECT max(download_date) FROM seg")) == "2026-07-29"


# ------------------------------------------------------------------ failure modes


def test_rejects_an_extract_with_the_wrong_column_count(tmp_path, out_dir):
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("T_T100D_SEGMENT_US_CARRIER_ONLY.csv", "A,B,C\n1,2,3\n")
    bad.with_suffix(".json").write_text('{"download_date": "2026-07-29"}')
    with pytest.raises(NormalizeError, match="column"):
        normalize_year(bad, out_dir, year=2015)


def test_rejects_an_extract_containing_a_rollup_service_class(tmp_path, out_dir):
    """K = F+G. Summing across classes would double-count.

    Caught in pre-flight against the *raw* extract — the service filter would otherwise
    drop the K row before anything could notice it.
    """

    def set_rollup_class(rows):
        rows[0]["CLASS"] = "K"
        return rows

    bad = _rewrite_fixture(tmp_path / "rollup.zip", set_rollup_class)
    with pytest.raises(NormalizeError, match="K"):
        normalize_year(bad, out_dir, year=2015)


def test_rejects_an_extract_with_no_sidecar(tmp_path, out_dir):
    """A guessed download_date would silently corrupt amended-filing resolution."""
    orphan = tmp_path / "no_sidecar.zip"
    orphan.write_bytes(FIXTURE.read_bytes())
    with pytest.raises(NormalizeError, match="sidecar"):
        normalize_year(orphan, out_dir, year=2015)


# ------------------------------------------------------------------ reproducibility


def test_rerunning_produces_identical_content(tmp_path):
    """M2 requires rebuilds be reproducible from scratch."""
    a = tmp_path / "a"
    b = tmp_path / "b"
    normalize_year(FIXTURE, a, year=2015)
    normalize_year(FIXTURE, b, year=2015)
    con = duckdb.connect()
    diff = con.execute(
        f"""
        SELECT count(*) FROM (
            SELECT * FROM read_parquet('{a}/**/*.parquet')
            EXCEPT ALL
            SELECT * FROM read_parquet('{b}/**/*.parquet')
        )
        """
    ).fetchone()[0]
    assert diff == 0


def test_rerunning_over_an_existing_partition_replaces_it(out_dir):
    """Not appends — a re-run must not double every row."""
    normalize_year(FIXTURE, out_dir, year=2015)
    con = duckdb.connect()
    q = f"SELECT count(*) FROM read_parquet('{out_dir}/**/*.parquet')"
    first = con.execute(q).fetchone()[0]
    normalize_year(FIXTURE, out_dir, year=2015)
    assert con.execute(q).fetchone()[0] == first
