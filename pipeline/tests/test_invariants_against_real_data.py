"""Run the invariants against a real BTS extract.

Skips when `data/raw/` has no extract, so CI and a fresh clone stay green — but locally,
after `make fetch`, this is what proves the rules hold on real filings rather than on
values I made up.

The expected counts are the ones recorded in docs/data/invariants.md. If BTS amends a
filing these can legitimately move; a change here is a signal to re-read the data, not to
edit the number until it passes.
"""

from __future__ import annotations

import csv
import io
import zipfile
from collections import Counter
from pathlib import Path

import duckdb
import pytest

from pipeline.fetch import T100D_SEGMENT_US, latest_raw
from pipeline.invariants import (
    check_columns,
    check_no_rollup_classes,
    is_passenger_service,
    quarantine_reason,
)

RAW_DIR = Path("data/raw")
# Append-only: filenames carry the download date (t100d_segment_us_2015_20260729.zip), so
# there is no fixed name to check for existence. latest_raw finds the newest download for
# this (table, year) the same way build_all does -- see test_reproducibility.py, which
# already got this right.
EXTRACT = latest_raw(RAW_DIR, T100D_SEGMENT_US, 2015)

pytestmark = pytest.mark.skipif(
    EXTRACT is None,
    reason="no 2015 extract under data/raw — run `make fetch --start 2015 --end 2015`",
)


@pytest.fixture(scope="module")
def rows():
    with zipfile.ZipFile(EXTRACT) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv") and "Documentation" not in n)
        with z.open(name) as fh:
            return list(csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace")))


def test_real_extract_has_the_expected_columns(rows):
    check_columns(list(rows[0].keys()))


def test_real_extract_has_no_rollup_service_classes(rows):
    check_no_rollup_classes(r["CLASS"] for r in rows)


def test_real_extract_contains_only_the_four_observed_classes(rows):
    """F/G/L/P. A new class appearing is a signal to re-read the lookup, not to widen this."""
    assert set(r["CLASS"] for r in rows) == {"F", "G", "L", "P"}


def test_row_count_matches_the_documented_measurement(rows):
    assert len(rows) == 367_360


def test_passenger_filter_keeps_combi_and_seaplane(rows):
    """The documented reason config 3 and 4 must be included."""
    kept = [r for r in rows if is_passenger_service(r["CLASS"], r["AIRCRAFT_CONFIG"])]
    by_config = Counter(r["AIRCRAFT_CONFIG"] for r in kept)
    assert by_config["3"] > 0, "combi rows dropped"
    assert by_config["4"] > 0, "seaplane rows dropped"

    config_1_only = sum(1 for r in kept if r["AIRCRAFT_CONFIG"] == "1")
    assert len(kept) - config_1_only > 100, "filtering to config 1 would lose material volume"


def _reason(row):
    return quarantine_reason(
        seats=float(row["SEATS"] or 0),
        passengers=float(row["PASSENGERS"] or 0),
        aircraft_config=row["AIRCRAFT_CONFIG"] or 0,
        departures_performed=float(row["DEPARTURES_PERFORMED"] or 0),
        airline_id=row["AIRLINE_ID"],
    )


def test_quarantine_stays_rare_on_real_data(rows):
    """Quarantine is surfaced in the UI as a trust signal, so it has to stay rare.

    Measured 0.06% on 2015. An earlier rule reported 2.03% by flagging every "no service
    this month" row — the reason this assertion is tight rather than generous.
    """
    kept = [r for r in rows if is_passenger_service(r["CLASS"], r["AIRCRAFT_CONFIG"] or 0)]
    flagged = sum(1 for r in kept if _reason(r))
    assert flagged / len(kept) < 0.001, f"{flagged}/{len(kept)} quarantined — rule too broad"


def test_no_service_rows_are_not_quarantined(rows):
    """5,713 zero-seat rows in 2015 simply never flew. Ordinary, not anomalous."""
    no_service = [
        r
        for r in rows
        if is_passenger_service(r["CLASS"], r["AIRCRAFT_CONFIG"] or 0)
        and float(r["SEATS"] or 0) == 0
        and float(r["DEPARTURES_PERFORMED"] or 0) == 0
    ]
    assert len(no_service) > 1000, "expected many no-service rows"
    assert all(_reason(r) is None for r in no_service)


def test_flown_legs_reporting_zero_seats_are_caught(rows):
    """The genuine anomaly the rule exists for — 4 rows in 2015."""
    anomalies = [
        r
        for r in rows
        if is_passenger_service(r["CLASS"], r["AIRCRAFT_CONFIG"] or 0)
        and float(r["SEATS"] or 0) == 0
        and float(r["DEPARTURES_PERFORMED"] or 0) > 0
        and r["AIRLINE_ID"].strip()
    ]
    assert anomalies, "expected some flown-but-seatless rows"
    assert all(_reason(r) == "zero_seats" for r in anomalies)


def test_rows_with_no_carrier_identity_are_quarantined(rows):
    """158 rows in 2015 have every carrier field blank yet report real traffic."""
    orphans = [r for r in rows if not r["AIRLINE_ID"].strip()]
    assert orphans, "expected carrier-less rows"
    assert all(_reason(r) == "missing_carrier" for r in orphans)
    # They are not empty filings — they carry traffic, which is why silently dropping
    # them would be wrong and quarantining them (visibly) is right.
    assert any(float(r["DEPARTURES_PERFORMED"] or 0) > 0 for r in orphans)


def test_zero_seat_freighters_are_not_quarantined(rows):
    """They're filtered by the service filter; flagging them would pollute the count."""
    freighters = [
        r
        for r in rows
        if r["AIRCRAFT_CONFIG"] == "2" and float(r["SEATS"] or 0) == 0 and r["AIRLINE_ID"].strip()
    ]
    assert freighters, "no zero-seat freighters found — fixture may be wrong"
    assert all(_reason(r) is None for r in freighters)


def test_aircraft_type_codes_retain_leading_zeros(rows):
    """`079` int-parsed becomes `79` and the dim join breaks silently."""
    padded = {r["AIRCRAFT_TYPE"] for r in rows if r["AIRCRAFT_TYPE"].startswith("0")}
    assert padded, "expected zero-padded aircraft type codes"
    assert all(len(c) == 3 for c in padded)


def test_carrier_less_rows_stay_a_tiny_minority(rows):
    """They exist (158 in 2015) and are quarantined, but a spike would mean BTS changed
    something about how carriers are reported."""
    orphans = sum(1 for r in rows if not r["AIRLINE_ID"].strip())
    assert 0 < orphans / len(rows) < 0.001


# `distance` licenses `max(distance)` as a route attribute on `fct_route_month` only because
# it is (almost) constant per (origin, dest) per month -- see docs/data/model.md, "distance
# is not additive". That measurement needs the full multi-year Parquet warehouse, not just
# the 2015 raw extract `rows` above reads, so it is skip-gated separately.
PARQUET_DIR = Path("data/parquet/t100_segment")


@pytest.mark.skipif(
    not PARQUET_DIR.exists() or not any(PARQUET_DIR.glob("year=*")),
    reason=f"no built Parquet warehouse under {PARQUET_DIR} — run `make warehouse`",
)
def test_distance_variance_stays_within_bound():
    """`max(distance)` on `fct_route_month` is a representative filed value, not a true
    invariant: M3a Task 1 measured 37 of 1,082,147 non-quarantined route-months (0.0034%)
    genuinely disagreeing on DISTANCE over the full 2015-2026 window, max spread 8.0 miles,
    concentrated in 2022-2023 around airport 15887/WWT (Newtok, AK, which physically
    relocated to Mertarvik in 2023). The ruling recorded in docs/data/model.md is that
    max(distance) stays because the variance is bounded and tiny -- this test is what
    enforces "bounded": it must fail if the variance grows past what was ruled acceptable,
    not stay silently green while it quietly drifts further.
    """
    con = duckdb.connect()
    total, varying, max_spread = con.execute(f"""
        WITH per_route AS (
            SELECT year_month, origin_airport_id, dest_airport_id,
                   count(DISTINCT distance) AS n, max(distance) - min(distance) AS spread
            FROM read_parquet('{PARQUET_DIR}/**/*.parquet')
            WHERE NOT is_quarantined
            GROUP BY 1, 2, 3
        )
        SELECT count(*), sum((n > 1)::INT), max(spread) FROM per_route
    """).fetchone()
    pct_varying = 100.0 * varying / total
    assert pct_varying < 0.01, (
        f"{varying}/{total} route-months vary ({pct_varying:.4f}%) -- exceeds the ruled bound"
    )
    assert max_spread < 20.0, f"max spread {max_spread} miles exceeds the ruled bound"
