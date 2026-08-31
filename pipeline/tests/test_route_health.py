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


def test_the_floor_is_a_rate_over_the_months_that_flew(con):
    """The floor is 30 departures per month FLOWN (#148, app/src/lib/floor.ts), never a
    trailing-12 total. This replaces an assertion on `t12_departures_performed < 30`, which
    survives the rate form unchanged -- 30 * months_flown is >= 30 for every admitted row, so
    that test could not fail for the reason its name claimed and was deletable-green.
    """
    bad = con.execute(
        "SELECT count(*) FROM mart_route_health "
        "WHERE t12_departures_performed < 30 * t12_months_flown"
    ).fetchone()[0]
    assert bad == 0


def test_a_carrier_route_that_filed_and_never_flew_is_not_admitted(con):
    """`t12_departures_performed >= 30 * t12_months_flown` is TRUE for a route that never
    flew: months_flown is 0, so the comparison reads `0 >= 0`. Without the explicit
    `t12_months_flown > 0` arm the rate floor therefore admits the sparsest row it is possible
    to file -- one that filed a schedule and performed nothing -- while looking like it
    excludes it. That is 7 extra rows on this fixture and 7 on the real warehouse.

    floor.ts:74 rules the same case the same way: `activeMonths <= 0` is BELOW floor, not a
    division to be skipped.

    The second assertion is the anti-vacuity control. If no carrier-route in the window had
    filed without flying, the first would pass under either form and prove nothing.
    """
    admitted = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE t12_months_flown = 0"
    ).fetchone()[0]
    assert admitted == 0, (
        "a carrier-route that filed and never flew is in the scored universe -- the rate "
        "floor is missing its `t12_months_flown > 0` arm and read `0 >= 0` as clearing it"
    )

    never_flew = con.execute("""
        WITH w AS (SELECT DISTINCT t12_start_month AS s, t12_end_month AS e
                   FROM mart_route_health)
        SELECT count(*) FROM (
            SELECT r.op_airline_id
            FROM fct_route_month r, w
            WHERE r.year_month BETWEEN w.s AND w.e
            GROUP BY r.op_airline_id, r.route_key_low, r.route_key_high
            HAVING count(DISTINCT r.year_month)
                       FILTER (WHERE r.departures_performed > 0) = 0
               AND sum(r.departures_performed) = 0)
    """).fetchone()[0]
    assert never_flew > 0, (
        "this warehouse has no filed-but-never-flown carrier-route, so the assertion above "
        "is vacuous -- it would pass with the guard deleted"
    )


def test_additive_sums_are_carried_alongside_the_derived_columns(con):
    """features.md requires the components be shown, not just the score."""
    cols = {r[0] for r in con.execute("DESCRIBE mart_route_health").fetchall()}
    assert {
        "t12_seats",
        "t12_passengers",
        "t12_departures_performed",
        "t12_departures_scheduled",
        "t12_months_present",
        "p12_seats",
        "p12_passengers",
        "p12_departures_performed",
        "p12_departures_scheduled",
        "p12_months_present",
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
            "fixture has no carrier-route pair clearing the departure rate floor; "
            "window ordering is verified against real 2015-2017 data in the task's manual step"
        )
    assert len(row) == 1, "the window must be global, not per-route"
    t12s, t12e, p12s, p12e = row[0]
    assert p12s < p12e < t12s <= t12e


def test_health_score_is_null_exactly_when_a_component_is_unknown(con):
    """Fix round 1: the original version of this test checked parity against `lf_delta`
    alone, which is FALSE on real data -- 76 of the 5,238 scored carrier-route pairs have a
    fully-populated prior window (so lf_delta, gauge_delta, capacity_delta and frequency_delta
    are all known)
    but `completion_factor` is NULL anyway, because they filed zero scheduled departures
    against real performed ones (on-demand/charter carriers). `lf_delta`-only parity holds
    on the small fixture purely because its single surviving row happens to have every
    component NULL at once -- it can't produce a route with a populated prior window AND
    completion_factor NULL.

    The composite is FOUR axes, not five: M6 removed capacity_delta from the score, because
    in log space it is exactly frequency + gauge (verified to 1.33e-15 over all 5,314 finite
    rows -- docs/data/model.md), so scoring it scored those two a second time. It keeps its
    column and stays on the page; it is the composite it has no place in.

    The predicate below still names all FIVE displayed components, and that is deliberate,
    not a leftover: capacity_delta is not scored, but it is NULL under the same
    data-availability conditions as the axes that are (p12_months_present = 0, or a zero p12
    denominator), so including it is redundant-but-true on the real warehouse and states the
    invariant the page actually depends on -- a row missing ANY displayed component is
    unscored, never partially scored. Synthesising a score from a subset of what it shows
    would be exactly the over-engineering features.md's "components are the insight, score is
    only a sort key" forbids."""
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE (health_score IS NULL) <> (
            lf_delta IS NULL OR gauge_delta IS NULL OR capacity_delta IS NULL
            OR frequency_delta IS NULL OR completion_factor IS NULL
        )
    """).fetchone()[0]
    assert bad == 0


def test_health_score_is_bounded_by_the_clamp(con):
    """Each axis is clamped to +/-3 and weighted 0.25, so |health_score| <= 3.0 by
    construction. Without the clamp a nine-seat aircraft's log gauge ratio reaches z = -18.91
    on the real warehouse (VD CPX-VQS) and Death Watch fills with bush operators."""
    worst = con.execute(
        "SELECT max(abs(health_score)) FROM mart_route_health WHERE health_score IS NOT NULL"
    ).fetchone()[0]
    assert worst is None or worst <= 3.0


def test_the_completion_cap_is_null_safe(con):
    """DuckDB's least() IGNORES NULLs: least(NULL, 1.5) returns 1.5, not NULL. Written as a
    bare least(), the cap fabricates a 1.5 completion rate for every route that filed no
    schedule at all -- 89 of them on the real warehouse -- and each then gets a health_score
    it has no basis for."""
    leaked = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE completion_factor IS NULL AND health_score IS NOT NULL
    """).fetchone()[0]
    assert leaked == 0


def test_the_z_clamp_is_null_safe(con):
    """Same trap on the other guard. least(NULL,3) returns 3 (DuckDB's least/greatest treat
    NULL as absent, not as the smallest/largest value), so greatest(least(NULL,3),-3) returns
    3, not -3 -- a bare clamp scores EVERY row, including the new routes whose whole point is
    a NULL score. Same wrong evidence this docstring itself carried until now was already
    corrected in docs/data/model.md and in 200_mart_route_health.sql's own comment (M6 Task 2
    review round 1); this copy was missed."""
    leaked = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE p12_months_present = 0 AND health_score IS NOT NULL
    """).fetchone()[0]
    assert leaked == 0


def test_capacity_is_carried_but_not_scored(con):
    """capacity_delta stays a DISPLAYED component -- 'capacity down 81%' is the most legible
    cell on a Death Watch row -- but in log space it is EXACTLY frequency + gauge, so scoring
    it scores those twice. The identity below is what licenses the exclusion."""
    cols = [r[0] for r in con.execute("DESCRIBE mart_route_health").fetchall()]
    assert "capacity_delta" in cols
    residual = con.execute("""
        SELECT max(abs( ln(t12_seats / p12_seats)
                      - ln(t12_departures_performed / p12_departures_performed)
                      - ln(gauge_t12 / gauge_p12) ))
        FROM mart_route_health
        WHERE p12_seats > 0 AND t12_seats > 0
          AND p12_departures_performed > 0 AND t12_departures_performed > 0
    """).fetchone()[0]
    assert residual is None or residual < 1e-12


def test_quarantined_rows_are_carried_for_the_trailing_window(con):
    """CLAUDE.md makes surfacing the quarantine count a hard rule on every data view. The mart
    did not carry it forward, so /watch could not honour that without this column."""
    cols = [r[0] for r in con.execute("DESCRIBE mart_route_health").fetchall()]
    assert "t12_quarantined_rows" in cols
    negative = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE t12_quarantined_rows < 0"
    ).fetchone()[0]
    assert negative == 0


def test_quarantined_rows_is_bigint_not_hugeint(con):
    """DuckDB promotes sum() over a BIGINT column to HUGEINT unless explicitly cast back down.
    The brief's interface spec is `t12_quarantined_rows BIGINT`; Task 6 reads this column
    through @duckdb/node-api into TypeScript, and this repo has a documented history of DuckDB
    runtime types surfacing differently than expected -- so the type itself is the invariant,
    not just the column's presence and sign (which the previous test already covers and which
    passes under either type)."""
    dtype = con.execute("""
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'mart_route_health' AND column_name = 't12_quarantined_rows'
    """).fetchone()[0]
    assert dtype == "BIGINT"
