"""fct_route_month -- the directed route rollup.

Two things make this more than a GROUP BY: quarantined rows must leave the aggregate but
stay countable, and `distance` is not additive.
"""

from __future__ import annotations

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.tests.test_marts import _warehouse


@pytest.fixture
def con(tmp_path):
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    return duckdb.connect(str(db))


def test_grain_has_no_duplicates(con):
    dupes = con.execute("""
        SELECT count(*) FROM (
            SELECT year_month, op_airline_id, origin_airport_id, dest_airport_id
            FROM fct_route_month GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
        )
    """).fetchone()[0]
    assert dupes == 0


def test_additive_measures_match_the_segment_fact(con):
    """The rollup must conserve seats and passengers exactly, over non-quarantined rows."""
    seg = con.execute(
        "SELECT sum(seats), sum(passengers), sum(departures_performed) "
        "FROM fct_segment_month WHERE NOT is_quarantined"
    ).fetchone()
    route = con.execute(
        "SELECT sum(seats), sum(passengers), sum(departures_performed) FROM fct_route_month"
    ).fetchone()
    assert seg == route


def test_quarantined_rows_are_excluded_from_measures_but_counted(con):
    """Excluding them silently would hide the dirt; including them would corrupt the
    aggregate. Both are wrong, so the count is carried separately."""
    cols = {r[0] for r in con.execute("DESCRIBE fct_route_month").fetchall()}
    assert "quarantined_rows" in cols
    total_q = con.execute(
        "SELECT count(*) FROM fct_segment_month WHERE is_quarantined"
    ).fetchone()[0]
    carried = con.execute("SELECT sum(quarantined_rows) FROM fct_route_month").fetchone()[0]
    assert (carried or 0) == total_q


def test_no_derived_measure_columns(con):
    cols = {r[0].lower() for r in con.execute("DESCRIBE fct_route_month").fetchall()}
    assert not cols & {"load_factor", "asm", "rpm", "avg_gauge", "completion_factor"}


def test_distance_is_not_summed(con):
    """SUM(distance) across aircraft types is meaningless. Whatever branch Task 1's
    measurement chose, the rollup's distance must never exceed the segment maximum for
    that route-month."""
    bad = con.execute("""
        WITH seg AS (
            SELECT year_month, origin_airport_id, dest_airport_id, max(distance) AS d
            FROM fct_segment_month WHERE NOT is_quarantined GROUP BY 1, 2, 3
        )
        SELECT count(*) FROM fct_route_month r
        JOIN seg USING (year_month, origin_airport_id, dest_airport_id)
        WHERE r.distance > seg.d + 0.001
    """).fetchone()[0]
    assert bad == 0


def test_undirected_key_is_carried_for_the_mart(con):
    """mart_route_health aggregates on this pair, so it has to survive the rollup."""
    cols = {r[0] for r in con.execute("DESCRIBE fct_route_month").fetchall()}
    assert {"route_key_low", "route_key_high"} <= cols
    bad = con.execute(
        "SELECT count(*) FROM fct_route_month WHERE route_key_low > route_key_high"
    ).fetchone()[0]
    assert bad == 0


def test_load_factor_computed_from_the_rollup_is_sane(con):
    """The point of the whole rule: ratio from summed numerator and denominator."""
    lf = con.execute(
        "SELECT SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0) FROM fct_route_month"
    ).fetchone()[0]
    assert 0.0 < lf <= 1.0
