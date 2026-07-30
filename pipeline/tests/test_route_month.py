"""fct_route_month -- the directed route rollup.

Three things make this more than a GROUP BY: quarantined rows must leave the aggregate but
stay countable (and their absence must yield NULL, never a coalesced 0), `distance` is not
additive, and the any_value() picks for origin/dest city market id rest on a measured -- not
assumed -- constancy within the grain.
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
    that route-month -- and `max()` is only a safe way to carry it as a route attribute if
    distance doesn't actually vary within the grain in the first place. A `<= max` check
    alone is satisfied by construction (max() always equals the max), so it cannot catch a
    route-month where distance genuinely disagrees across rows -- e.g. 100.0 and 500.0 --
    it would just silently carry 500.0 with zero offences reported. The
    `count(DISTINCT distance) > 1` check below is what actually guards the assumption,
    same shape as `test_city_market_ids_are_constant_within_the_route_month_grain` below,
    which polices the structurally identical question for city market ids. Measured 0 of
    274,824 non-quarantined route-months varying, over the full 2015-2017 warehouse -- see
    the `distance is not additive` section of docs/data/model.md.
    """
    bad = con.execute("""
        WITH seg AS (
            SELECT year_month, origin_airport_id, dest_airport_id,
                   max(distance) AS d,
                   count(DISTINCT distance) AS n_distinct
            FROM fct_segment_month WHERE NOT is_quarantined GROUP BY 1, 2, 3
        )
        SELECT count(*) FROM fct_route_month r
        JOIN seg USING (year_month, origin_airport_id, dest_airport_id)
        WHERE r.distance > seg.d + 0.001
           OR seg.n_distinct > 1
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


def test_fully_quarantined_route_month_has_null_measures_not_zero(con):
    """A route-month whose every contributing row is quarantined must yield NULL measures,
    not a coalesced 0 -- a real 0 (the route filed, and genuinely carried nothing) and an
    untrustworthy 0 (the route filed nothing WE TRUST) must stay distinguishable. The
    fixture already contains such route-months naturally (e.g. seaplane/charter legs whose
    sole contributing row trips `load_factor_gt_1`), so this is measuring the real behaviour,
    not a constructed edge case."""
    rows = con.execute("""
        SELECT seats, passengers, quarantined_rows
        FROM fct_route_month
        WHERE quarantined_rows > 0
    """).fetchall()
    fully_quarantined = [r for r in rows if r[0] is None]
    assert fully_quarantined, "fixture should contain at least one fully-quarantined route-month"
    for seats, passengers, quarantined_rows in fully_quarantined:
        assert seats is None
        assert passengers is None
        assert quarantined_rows > 0


def test_fct_route_month_carries_year_quarter_month_as_group_by_keys_not_any_value(con):
    """`year`/`quarter`/`month` must be real GROUP BY keys, not `any_value()` aggregate
    output, or DuckDB's optimizer cannot push a `WHERE year = ...` predicate through this
    view into fct_segment_month's Hive-partitioned scan -- `any_value()` output is opaque
    to predicate pushdown, GROUP BY key output is not. Measured against the real
    2015-2017 warehouse (docs/data/invariants.md): `WHERE year = 2017` through this view
    read `Total Files Read: 3` with no `File Filters` when year/quarter/month were
    any_value()'d, versus `Scanning Files: 1/3` with `File Filters: (year = 2017)` once
    they became GROUP BY keys -- same 494,508-row `fct_route_month` and 7,336-row
    `mart_route_health` either way.

    This does NOT itself prove pruning happens at runtime -- same honest-style pair as
    `test_fct_segment_month_view_sets_hive_partitioning_for_pruning` in test_marts.py. The
    committed CI fixture has only one fact year, so there is nothing to prune, and
    EXPLAIN ANALYZE's `File Filters`/`Scanning Files` text is a debug rendering, not a
    stable public API. This only pins the structural precondition: the compiled view text
    groups by year/quarter/month directly rather than collapsing them with any_value().
    The actual I/O measurement lives in docs/data/invariants.md, against the real
    warehouse, not the fixture.
    """
    sql = con.execute(
        "SELECT sql FROM duckdb_views() WHERE view_name = 'fct_route_month'"
    ).fetchone()[0]
    flat = sql.replace('"', "")
    assert "any_value(year)" not in flat
    assert "any_value(quarter)" not in flat
    assert "any_value(month)" not in flat
    group_by_clause = flat.split("GROUP BY", 1)[1]
    assert group_by_clause.split(",")[:4] == [
        " year_month",
        " year",
        " quarter",
        " month",
    ]


def test_city_market_ids_are_constant_within_the_route_month_grain(con):
    """`any_value(origin_city_market_id)` / `any_value(dest_city_market_id)` are safe ONLY
    because these ids are constant within the route-month grain -- unlike year/quarter/month
    or route_key_low/high, they are not a pure function of columns the grain already fixes:
    they are copied per filed row from raw.ORIGIN_CITY_MARKET_ID / DEST_CITY_MARKET_ID, and
    an airport genuinely can be reassigned between city markets over time. Measured 0 of
    494,451 non-quarantined (year_month, op_airline_id, origin_airport_id, dest_airport_id)
    groups varying, over the full 2015-2017 warehouse -- see docs/data/invariants.md.

    This also pins fct_route_month's any_value() picks to the segment fact's actual values,
    so a column swap (origin/dest) or a dropped join key surfaces here too.
    """
    bad = con.execute("""
        WITH seg AS (
            SELECT
                year_month, op_airline_id, origin_airport_id, dest_airport_id,
                count(DISTINCT origin_city_market_id) AS n_origin,
                count(DISTINCT dest_city_market_id)   AS n_dest,
                any_value(origin_city_market_id)       AS origin_cm,
                any_value(dest_city_market_id)         AS dest_cm
            FROM fct_segment_month
            WHERE NOT is_quarantined
            GROUP BY 1, 2, 3, 4
        )
        SELECT count(*) FROM fct_route_month r
        JOIN seg USING (year_month, op_airline_id, origin_airport_id, dest_airport_id)
        WHERE seg.n_origin > 1 OR seg.n_dest > 1
           OR r.origin_city_market_id IS DISTINCT FROM seg.origin_cm
           OR r.dest_city_market_id   IS DISTINCT FROM seg.dest_cm
    """).fetchone()[0]
    assert bad == 0
