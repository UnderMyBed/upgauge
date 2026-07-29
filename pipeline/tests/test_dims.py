"""Tests for the dimension tables.

Fixtures are real rows from the BTS support tables (Master Coordinate, Carrier Decode,
AircraftTypes), curated to include multi-seq airports, closed airports, zero-padded codes,
and every carrier whose rollup behaviour differs.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from pipeline.dims import (
    build_aircraft_type_dim,
    build_airport_dim,
    build_carrier_dim,
    build_mainline_map,
)

FIXTURES = Path(__file__).parent / "fixtures"
AIRPORTS = FIXTURES / "master_coordinate_sample.zip"
CARRIERS = FIXTURES / "carrier_decode_sample.zip"
TYPES = FIXTURES / "aircraft_types_sample.zip"


def view(path: Path, name: str):
    con = duckdb.connect()
    con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{path}')")
    return con


def one(con, sql):
    return con.execute(sql).fetchone()[0]


def types_of(con, name):
    return {r[0]: r[1].upper() for r in con.execute(f"DESCRIBE SELECT * FROM {name}").fetchall()}


# ----------------------------------------------------------------- dim_airport


@pytest.fixture
def airports(tmp_path):
    return view(build_airport_dim(AIRPORTS, tmp_path), "dim_airport")


def test_airport_dim_is_keyed_on_seq_id(airports):
    """airport_seq_id is the point-in-time key; airport_id is identity."""
    rows = one(airports, "SELECT count(*) FROM dim_airport")
    distinct = one(airports, "SELECT count(DISTINCT airport_seq_id) FROM dim_airport")
    assert rows == distinct > 0


def test_one_airport_id_can_have_many_seq_ids(airports):
    """The whole reason both columns exist — attributes change over time."""
    assert (
        one(
            airports,
            "SELECT max(n) FROM (SELECT count(*) n FROM dim_airport GROUP BY airport_id)",
        )
        > 1
    )


def test_airport_ids_are_integers(airports):
    t = types_of(airports, "dim_airport")
    assert "INT" in t["airport_id"] and "INT" in t["airport_seq_id"]


def test_airport_codes_stay_strings(airports):
    """`01A` is a real airport code. Int-parsing loses the leading zero."""
    assert types_of(airports, "dim_airport")["code"] == "VARCHAR"
    assert one(airports, "SELECT count(*) FROM dim_airport WHERE code LIKE '0%'") > 0


def test_lat_lon_are_numeric_and_plausible(airports):
    t = types_of(airports, "dim_airport")
    assert "DOUBLE" in t["lat"] and "DOUBLE" in t["lon"]
    assert one(airports, "SELECT count(*) FROM dim_airport WHERE lat NOT BETWEEN -90 AND 90") == 0
    assert one(airports, "SELECT count(*) FROM dim_airport WHERE lon NOT BETWEEN -180 AND 180") == 0


def test_airport_effective_range_is_present(airports):
    """Joins must be date-ranged — airport attributes change."""
    assert one(airports, "SELECT count(*) FROM dim_airport WHERE effective_from IS NULL") == 0


def test_closed_airports_are_kept_and_flagged(airports):
    """Dropping them would break historical joins for routes that used to exist."""
    assert one(airports, "SELECT count(*) FROM dim_airport WHERE is_closed") > 0


def test_city_market_id_is_carried(airports):
    """D1: city market is in."""
    assert one(airports, "SELECT count(*) FROM dim_airport WHERE city_market_id IS NULL") == 0


# ----------------------------------------------------------------- dim_carrier


@pytest.fixture
def carriers(tmp_path):
    return view(build_carrier_dim(CARRIERS, tmp_path), "dim_carrier")


def test_carrier_dim_is_keyed_on_airline_id(carriers):
    rows = one(carriers, "SELECT count(*) FROM dim_carrier")
    distinct = one(carriers, "SELECT count(DISTINCT airline_id) FROM dim_carrier")
    assert rows == distinct > 0


def test_carrier_ids_are_integers(carriers):
    assert "INT" in types_of(carriers, "dim_carrier")["airline_id"]


def test_raw_carrier_code_is_reused_across_airlines(carriers):
    """The evidence for keying on airline_id: 135 of 1,825 CARRIER codes in the full
    Carrier Decode map to more than one AIRLINE_ID."""
    assert (
        one(
            carriers,
            "SELECT count(*) FROM (SELECT carrier_code FROM dim_carrier "
            "GROUP BY carrier_code HAVING count(DISTINCT airline_id) > 1)",
        )
        > 0
    )


def test_unique_carrier_code_does_not_collide(carriers):
    """BTS disambiguates UNIQUE_CARRIER with suffixes like `2T (1)` — 119 such values.

    So UNIQUE_CARRIER is safe as an identifier but ugly for display, and its suffix can
    shift if BTS re-disambiguates. airline_id remains the key.
    """
    assert (
        one(
            carriers,
            "SELECT count(*) FROM (SELECT unique_carrier_code FROM dim_carrier "
            "GROUP BY unique_carrier_code HAVING count(DISTINCT airline_id) > 1)",
        )
        == 0
    )


def test_both_carrier_codes_are_carried(carriers):
    """`carrier_code` for display, `unique_carrier_code` because it is collision-free."""
    assert {"carrier_code", "unique_carrier_code"} <= set(types_of(carriers, "dim_carrier"))


def test_bts_carrier_group_is_named_to_avoid_the_collision(carriers):
    """Ours is mainline_group; theirs is bts_carrier_group. Never `carrier_group`."""
    cols = set(types_of(carriers, "dim_carrier"))
    assert "bts_carrier_group" in cols
    assert "carrier_group" not in cols
    assert "mainline_group" not in cols


def test_the_rollup_subjects_are_all_present(carriers):
    """Endeavor, Envoy, PSA, Piedmont, Horizon, Virgin America, Hawaiian."""
    ids = {r[0] for r in carriers.execute("SELECT airline_id FROM dim_carrier").fetchall()}
    assert {20363, 20398, 20397, 20427, 19687, 21171, 19690} <= ids


@pytest.mark.parametrize(
    ("airline_id", "expected_code", "stale_code"),
    [
        (19687, "QX", "HOZ"),  # Horizon: HOZ until 1984, QX since
        (20304, "OO", "SEA"),  # SkyWest: SEA until 2002, OO since
    ],
)
def test_carrier_code_is_the_current_one_not_a_historical_one(
    carriers, airline_id, expected_code, stale_code
):
    """Carrier Decode has several rows per airline with different CARRIER values.

    START_DATE_SOURCE is a string like '1/1/1960 12:00:00 AM', so ordering it lexically
    picks 1960 over 2011 and surfaces a dead code — a carrier page reading 'HOZ' instead
    of 'QX'. The date has to be parsed, not string-sorted.
    """
    code = one(carriers, f"SELECT carrier_code FROM dim_carrier WHERE airline_id = {airline_id}")
    assert code == expected_code, f"got the stale code {code!r}"
    assert code != stale_code


def test_unique_carrier_code_is_stable_where_carrier_code_is_not(carriers):
    """Horizon's CARRIER changed HOZ -> QX while UNIQUE_CARRIER stayed QX throughout.

    More evidence that UNIQUE_CARRIER is the steadier identifier of the two.
    """
    assert (
        one(carriers, "SELECT unique_carrier_code FROM dim_carrier WHERE airline_id = 19687")
        == "QX"
    )
    assert (
        one(carriers, "SELECT unique_carrier_code FROM dim_carrier WHERE airline_id = 20304")
        == "OO"
    )


def test_effective_from_is_parsed_to_a_real_date(carriers):
    """Stored as a DATE so nothing downstream can string-sort it by accident."""
    assert "DATE" in types_of(carriers, "dim_carrier")["effective_from"]


# ----------------------------------------------------------------- dim_aircraft_type


@pytest.fixture
def types_dim(tmp_path):
    return view(build_aircraft_type_dim(TYPES, tmp_path), "dim_aircraft_type")


def test_aircraft_type_code_stays_a_string(types_dim):
    """`007`/`079` int-parsed becomes 7/79 and the fact-table join breaks silently."""
    assert types_of(types_dim, "dim_aircraft_type")["code"] == "VARCHAR"
    assert one(types_dim, "SELECT count(*) FROM dim_aircraft_type WHERE code LIKE '0%'") > 0


def test_aircraft_type_codes_are_all_three_characters(types_dim):
    assert one(types_dim, "SELECT count(*) FROM dim_aircraft_type WHERE length(code) <> 3") == 0


def test_aircraft_type_is_keyed_on_code(types_dim):
    rows = one(types_dim, "SELECT count(*) FROM dim_aircraft_type")
    distinct = one(types_dim, "SELECT count(DISTINCT code) FROM dim_aircraft_type")
    assert rows == distinct > 0


def test_aircraft_type_carries_manufacturer_and_name(types_dim):
    """The gauge story is the differentiator, so the type dimension has to be usable."""
    assert one(types_dim, "SELECT count(*) FROM dim_aircraft_type WHERE name IS NULL") == 0
    assert one(types_dim, "SELECT count(DISTINCT manufacturer) FROM dim_aircraft_type") > 5


def test_no_seats_typical_is_stored(types_dim):
    """Seats-per-departure is derived from the facts. A nominal value on the dim would
    invite averaging it."""
    assert "seats_typical" not in types_of(types_dim, "dim_aircraft_type")


# ----------------------------------------------------------------- map_mainline_group


@pytest.fixture
def mapping(tmp_path):
    return view(build_mainline_map(tmp_path), "map_mainline_group")


def test_map_is_materialized_from_the_checked_in_csv(mapping):
    assert one(mapping, "SELECT count(*) FROM map_mainline_group") == 7


def test_map_carries_date_ranges(mapping):
    assert one(mapping, "SELECT count(*) FROM map_mainline_group WHERE effective_from IS NULL") == 0


def test_hawaiian_range_starts_september_2024(mapping):
    assert (
        one(mapping, "SELECT effective_from FROM map_mainline_group WHERE airline_id = 19690")
        == "2024-09"
    )


def test_open_ended_ranges_stay_null_not_sentinel(mapping):
    """A sentinel like 9999-12 in the stored data would leak into the UI."""
    assert one(mapping, "SELECT count(*) FROM map_mainline_group WHERE effective_to IS NULL") > 0


def test_shared_regionals_are_absent(mapping):
    """SkyWest, Republic, Mesa. Never rolled up, at any date."""
    ids = {r[0] for r in mapping.execute("SELECT airline_id FROM map_mainline_group").fetchall()}
    assert ids.isdisjoint({20304, 20452, 20378})
