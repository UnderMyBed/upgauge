"""Invariants M4a's resolution layer depends on. Measured 2026-07-30 against the full
2015-2026 window; see docs/data/invariants.md for the numbers and what each one protects."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

DB = Path("upgauge.duckdb")
pytestmark = pytest.mark.skipif(not DB.exists(), reason="no built catalog; run `make build`")

# NOTE for the implementer and reviewer: this skip is legitimate (the catalog is a build
# artifact, not checked in) -- but M1 shipped 12 real-data tests that skipped for FOUR
# MILESTONES because their guard condition was permanently false, and nobody noticed. So
# after running the suite you MUST confirm from pytest's output that these tests report as
# PASSED, not SKIPPED, and record the count in your report. A skipped guard is a dark guard.


@pytest.fixture(scope="module")
def con():
    return duckdb.connect(str(DB), read_only=True)


def test_dim_airport_has_exactly_one_latest_row_per_airport_id(con):
    """The is_latest filter is load-bearing: 5,033 airport_ids have more than one seq_id
    row, so a resolver that omits it fans out and MULTIPLIES result rows -- a wrong total
    under a DATA AS OF badge."""
    wrong = con.execute(
        "SELECT count(*) FROM (SELECT airport_id FROM dim_airport WHERE is_latest "
        "GROUP BY 1 HAVING count(*) <> 1)"
    ).fetchone()[0]
    assert wrong == 0

    none_latest = con.execute(
        "SELECT count(*) FROM (SELECT airport_id FROM dim_airport GROUP BY 1 "
        "HAVING sum(CASE WHEN is_latest THEN 1 ELSE 0 END) = 0)"
    ).fetchone()[0]
    assert none_latest == 0


def test_no_fact_id_is_missing_from_its_dimension(con):
    """An unresolvable id degrades to the raw id rather than erroring, but zero orphans is
    the state today and a regression means the warehouse build broke, not the display."""
    carrier = con.execute(
        "SELECT count(DISTINCT f.op_airline_id) FROM fct_segment_month f "
        "LEFT JOIN dim_carrier d ON d.airline_id = f.op_airline_id WHERE d.airline_id IS NULL"
    ).fetchone()[0]
    assert carrier == 0

    airport = con.execute(
        "SELECT count(*) FROM (SELECT DISTINCT id FROM ("
        "  SELECT origin_airport_id AS id FROM fct_segment_month"
        "  UNION SELECT dest_airport_id FROM fct_segment_month) x "
        "WHERE NOT EXISTS (SELECT 1 FROM dim_airport a WHERE a.airport_id = x.id AND a.is_latest))"
    ).fetchone()[0]
    assert airport == 0

    aircraft = con.execute(
        "SELECT count(DISTINCT f.aircraft_type) FROM fct_segment_month f "
        "LEFT JOIN dim_aircraft_type d ON d.code = f.aircraft_type WHERE d.code IS NULL"
    ).fetchone()[0]
    assert aircraft == 0


def test_no_code_collisions_among_in_window_operators(con):
    """M4b will resolve /carrier/DL and /airport/SEA back to an id. carrier_code is reused
    -- 112 codes map to >1 airline_id across all of dim_carrier -- but ZERO collide among
    the 114 carriers that actually operated in-window. This guards that future capability;
    it is NOT a guard on M4a's display path, where id -> code is a function and collisions
    are irrelevant."""
    carrier = con.execute(
        "SELECT count(*) FROM (SELECT d.carrier_code FROM dim_carrier d "
        "JOIN (SELECT DISTINCT op_airline_id FROM fct_segment_month) f "
        "  ON f.op_airline_id = d.airline_id "
        "GROUP BY 1 HAVING count(DISTINCT d.airline_id) > 1)"
    ).fetchone()[0]
    assert carrier == 0

    airport = con.execute(
        "SELECT count(*) FROM (SELECT a.code FROM dim_airport a "
        "JOIN (SELECT DISTINCT origin_airport_id AS id FROM fct_segment_month "
        "      UNION SELECT DISTINCT dest_airport_id FROM fct_segment_month) f "
        "  ON f.id = a.airport_id "
        "WHERE a.is_latest GROUP BY 1 HAVING count(DISTINCT a.airport_id) > 1)"
    ).fetchone()[0]
    assert airport == 0
