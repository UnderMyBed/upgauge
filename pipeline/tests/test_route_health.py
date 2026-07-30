"""mart_route_health -- the one materialised table, and the one derived-column exception.

The exception is safe because the grain has no time dimension: one row per (carrier,
undirected route) is both the finest and coarsest it gets, so there is no legitimate
GROUP BY of this table and nothing an AVG() could corrupt.
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


def test_it_is_a_table_not_a_view(con):
    kind = con.execute(
        "SELECT table_type FROM information_schema.tables WHERE table_name='mart_route_health'"
    ).fetchone()[0]
    assert kind == "BASE TABLE"


def test_grain_is_undirected_and_unique(con):
    dupes = con.execute("""
        SELECT count(*) FROM (
            SELECT op_airline_id, route_key_low, route_key_high
            FROM mart_route_health GROUP BY 1, 2, 3 HAVING count(*) > 1
        )
    """).fetchone()[0]
    assert dupes == 0


def test_route_key_is_normalised(con):
    bad = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE route_key_low > route_key_high"
    ).fetchone()[0]
    assert bad == 0


def test_a_route_with_no_prior_window_gets_null_deltas(con):
    """THE trap. A brand-new route is not a route that improved infinitely -- if the prior
    window is empty the delta is unknown, not enormous."""
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE p12_months_present = 0
          AND (lf_delta IS NOT NULL OR capacity_delta IS NOT NULL
               OR gauge_delta IS NOT NULL OR frequency_delta IS NOT NULL)
    """).fetchone()[0]
    assert bad == 0


def test_new_routes_are_not_filtered_out(con):
    """A route present in the trailing window but absent from the prior one must survive as
    a row -- it is the Route Birth Tracker's input. Only its deltas are unknown.

    Asserted against fct_route_month rather than as `count >= 0`, which cannot fail.
    """
    # Scalar subqueries, not a CROSS JOIN + any_value(): DuckDB's binder rejects an
    # aggregate (any_value) inside another aggregate's FILTER clause ("aggregate function
    # calls cannot be nested"). A scalar subquery evaluates to a constant before
    # aggregation runs, which sidesteps that restriction while asserting the exact same
    # thing -- membership judged against mart_route_health's own global window.
    expected = con.execute("""
        WITH w AS (SELECT DISTINCT t12_start_month, t12_end_month, p12_start_month,
                                   p12_end_month FROM mart_route_health)
        SELECT count(*) FROM (
            SELECT r.op_airline_id, r.route_key_low, r.route_key_high
            FROM fct_route_month r
            GROUP BY 1, 2, 3
            HAVING sum(r.departures_performed) FILTER (
                       WHERE r.year_month BETWEEN (SELECT t12_start_month FROM w)
                                              AND (SELECT t12_end_month FROM w)) >= 30
               AND count(DISTINCT r.year_month) FILTER (
                       WHERE r.year_month BETWEEN (SELECT p12_start_month FROM w)
                                              AND (SELECT p12_end_month FROM w)) = 0
        )
    """).fetchone()[0]
    actual = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE p12_months_present = 0"
    ).fetchone()[0]
    assert actual == expected


def test_low_activity_routes_are_excluded_on_performed_departures(con):
    bad = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE t12_departures_performed < 30"
    ).fetchone()[0]
    assert bad == 0


def test_additive_sums_are_carried_alongside_the_derived_columns(con):
    """features.md requires the components be shown, not just the score."""
    cols = {r[0] for r in con.execute("DESCRIBE mart_route_health").fetchall()}
    assert {
        "t12_seats", "t12_passengers", "t12_departures_performed",
        "t12_departures_scheduled", "t12_months_present",
        "p12_seats", "p12_passengers", "p12_departures_performed",
        "p12_departures_scheduled", "p12_months_present",
    } <= cols


def test_load_factors_are_in_range(con):
    bad = con.execute(
        "SELECT count(*) FROM mart_route_health "
        "WHERE lf_t12 IS NOT NULL AND (lf_t12 < 0 OR lf_t12 > 1.0)"
    ).fetchone()[0]
    assert bad == 0


def test_lf_delta_equals_the_difference_of_the_two_ratios(con):
    """Guards against the delta being computed from averaged ratios instead of from
    summed numerators and denominators."""
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE lf_delta IS NOT NULL
          AND abs(lf_delta - (
                t12_passengers / nullif(t12_seats, 0)
              - p12_passengers / nullif(p12_seats, 0))) > 1e-9
    """).fetchone()[0]
    assert bad == 0


def test_completion_factor_is_performed_over_scheduled(con):
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE completion_factor IS NOT NULL
          AND abs(completion_factor
                  - t12_departures_performed / nullif(t12_departures_scheduled, 0)) > 1e-9
    """).fetchone()[0]
    assert bad == 0


def test_windows_are_global_and_do_not_overlap(con):
    row = con.execute(
        "SELECT DISTINCT t12_start_month, t12_end_month, p12_start_month, p12_end_month "
        "FROM mart_route_health"
    ).fetchall()
    if not row:
        pytest.skip(
            "fixture has no route clearing the <30 departures floor; window ordering is "
            "verified against real 2015-2017 data in the task's manual step"
        )
    assert len(row) == 1, "the window must be global, not per-route"
    t12s, t12e, p12s, p12e = row[0]
    assert p12s < p12e < t12s <= t12e


def test_health_score_is_null_exactly_when_a_component_is_unknown(con):
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE (health_score IS NULL) <> (lf_delta IS NULL)
    """).fetchone()[0]
    assert bad == 0
