"""Derived measures, recomputed independently against the real warehouse.

The pivot's arithmetic is the product's credibility. Every measure here is recomputed from
the fact table by a second, independent query and compared -- not asserted to be "sane".
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from pipeline.pivot import PivotQuery, render_pivot

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


def test_load_factor_matches_an_independent_recomputation(con):
    sql, params = render_pivot(PivotQuery(
        grain="segment", dimensions=("op_airline_id",), measures=("load_factor",),
        time_from="2019-01", time_to="2019-12", limit=1000), con)
    got = {r[0]: r[1] for r in con.execute(sql, params).fetchall()}
    expected = {r[0]: r[1] for r in con.execute("""
        SELECT op_airline_id, SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)
        FROM fct_segment_month
        WHERE year_month BETWEEN '2019-01' AND '2019-12' AND NOT is_quarantined
        GROUP BY 1""").fetchall()}
    assert got == pytest.approx(expected)


def test_asm_differs_from_the_naive_form_across_routes(con):
    """THE trap. SUM(seats)*distance is correct within one route and wrong across several.
    If these two agree, the pivot is not actually multiplying per row."""
    row = con.execute("""
        SELECT SUM(seats * distance) AS correct,
               SUM(seats) * MAX(distance) AS naive
        FROM fct_segment_month
        WHERE year_month = '2019-06' AND NOT is_quarantined
    """).fetchone()
    assert row[0] != row[1], "single-route month? pick a month spanning many routes"
    ratio = row[1] / row[0]
    assert ratio > 2, f"naive form only {ratio:.2f}x off — the test is not discriminating"


def test_pivot_asm_uses_the_correct_form(con):
    sql, params = render_pivot(PivotQuery(
        grain="segment", dimensions=("year",), measures=("asm",),
        time_from="2019-01", time_to="2019-12"), con)
    got = con.execute(sql, params).fetchone()[1]
    expected = con.execute("""
        SELECT SUM(seats * distance) FROM fct_segment_month
        WHERE year_month BETWEEN '2019-01' AND '2019-12' AND NOT is_quarantined
    """).fetchone()[0]
    assert got == pytest.approx(expected)


def test_pivot_route_grain_shares_the_measure_catalog_correctly(con):
    """meta_pivot_measures.expr is ONE string, shared verbatim by both pivot_segment.sql and
    pivot_route.sql -- so its FILTER (WHERE NOT is_quarantined) must resolve at route grain
    too. fct_route_month has no per-row is_quarantined (its stored sums are already clean --
    100_fct_route_month.sql filters at rollup time), so it exposes a structural
    `FALSE AS is_quarantined` for exactly this. Executed against real data rather than a
    synthetic fixture: a missing column here is a 500 at request time, not a validation
    error, and no earlier test (real-data or synthetic) actually executed a route-grain
    pivot's SQL."""
    sql, params = render_pivot(PivotQuery(
        grain="route", dimensions=("year",), measures=("seats", "asm"),
        time_from="2019-01", time_to="2019-12"), con)
    got_seats, got_asm = con.execute(sql, params).fetchone()[1:3]
    expected_seats, expected_asm = con.execute("""
        SELECT SUM(seats), SUM(seats * distance) FROM fct_route_month
        WHERE year_month BETWEEN '2019-01' AND '2019-12'
    """).fetchone()
    assert got_seats == pytest.approx(expected_seats)
    assert got_asm == pytest.approx(expected_asm)


def test_quarantined_rows_are_reported_not_hidden(con):
    sql, params = render_pivot(PivotQuery(
        grain="segment", dimensions=("year",), measures=("seats",),
        time_from="2020-01", time_to="2020-12"), con)
    rows = con.execute(sql, params).fetchall()
    cols = [d[0] for d in con.execute(sql, params).description]
    qi = cols.index("quarantined_rows")
    expected = con.execute("""
        SELECT count(*) FROM fct_segment_month
        WHERE year_month BETWEEN '2020-01' AND '2020-12' AND is_quarantined
    """).fetchone()[0]
    assert sum(r[qi] for r in rows) == expected


def _carrier_total(con, airline_id, month, grouping):
    sql, params = render_pivot(PivotQuery(
        grain="segment", dimensions=("op_airline_id",), measures=("seats",),
        time_from=month, time_to=month, grouping=grouping, limit=5000), con)
    return {r[0]: r[1] for r in con.execute(sql, params).fetchall()}


def test_virgin_america_rolls_up_from_its_effective_month(con):
    """2016-12 is the acquisition month. 2016-11 must NOT roll up."""
    before = _carrier_total(con, 21171, "2016-11", "mainline")
    after = _carrier_total(con, 21171, "2016-12", "mainline")
    assert 21171 in before, "VX should still be its own carrier in 2016-11"
    assert 21171 not in after, "VX should have rolled into AS from 2016-12"
    assert 19930 in after


def test_virgin_america_stops_rolling_up_after_its_thru_month(con):
    """effective_to = '2018-04' is EXCLUSIVE. Asserts the MAPPING itself at both sides of the
    boundary, via the actual join fragment production renders -- NOT on real VX traffic.

    An earlier version of this test filtered fct_segment_month to VX at/after 2018-04 and
    asserted zero matching rows had a parent. That is VACUOUS: VX has ZERO
    fct_segment_month rows on or after 2018-04 (its last real filing is 2018-03, consistent
    with the brand retiring), so the WHERE clause matched no fact rows at all -- the count
    was 0 regardless of the join's boundary operator, because there was nothing on the left
    side of the LEFT JOIN to begin with. Confirmed by mutating the production join from `<`
    to `<=` and watching the old version of this test stay green. This version uses a
    synthetic probe row instead of real traffic, so it can actually fail."""
    join_sql = Path("sql/03_queries/pivot_mainline_join.sql").read_text()
    rows = con.execute(f"""
        WITH f(op_airline_id, year_month) AS (VALUES (21171, '2018-03'), (21171, '2018-04'))
        SELECT f.year_month, m.parent_airline_id
        FROM f
        {join_sql}
        ORDER BY f.year_month
    """).fetchall()
    result = dict(rows)
    assert result["2018-03"] == 19930, "2018-03 is still within the range, must roll up"
    assert result["2018-04"] is None, "2018-04 is on/after the exclusive thru month"


def test_hawaiian_rolls_up_from_2024_09_and_not_2024_08(con):
    before = _carrier_total(con, 19690, "2024-08", "mainline")
    after = _carrier_total(con, 19690, "2024-09", "mainline")
    assert 19690 in before, "HA should be its own carrier in 2024-08"
    assert 19690 not in after, "HA should have rolled into AS from 2024-09"


def test_shared_regionals_never_roll_up(con):
    """SkyWest flies for several mainlines on the same day. No date range fixes that, so it
    must not appear in the map at all."""
    mapped = {r[0] for r in con.execute(
        "SELECT carrier_code FROM map_mainline_group").fetchall()}
    assert not mapped & {"OO", "YX", "YV"}


def test_mainline_filter_does_not_coalesce_like_the_dimension_does(con):
    """Pins a KNOWN, DELIBERATELY UNCHANGED gap (see pivot_mainline_join.sql's header):
    under grouping='mainline', the op_airline_id dimension is coalesced to the parent
    airline_id, but a filter on op_airline_id is not -- it still matches the raw column, so
    filtering a mainline-grouped pivot to a parent excludes the rows its wholly-owned
    subsidiaries contribute to that same, already-rolled-up row. Measured on 2017-01: the
    unfiltered mainline row for 19930 (Alaska) is 3,842,350 seats; filtered to
    op_airline_id:19930 it drops to 2,336,210 -- Horizon and Virgin America are folded into
    the row but excluded by the filter. This is a regression pin, not an endorsement --
    whether the filter SHOULD target the coalesced expression is a product decision left to
    a human, not something this test authorizes changing silently."""
    unfiltered = _carrier_total(con, 19930, "2017-01", "mainline")
    sql, params = render_pivot(
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2017-01", time_to="2017-01", grouping="mainline",
            filters=(("op_airline_id", ("19930",)),),
        ),
        con,
    )
    filtered = {r[0]: r[1] for r in con.execute(sql, params).fetchall()}
    assert unfiltered[19930] == pytest.approx(3_842_350)
    assert filtered[19930] == pytest.approx(2_336_210)
    assert filtered[19930] < unfiltered[19930], (
        "if this ever becomes equal, the filter now coalesces like the dimension does -- "
        "update this test to reflect the (deliberate) behaviour change, don't just widen it"
    )


def test_operating_grouping_leaves_carriers_alone(con):
    """The default must not silently roll anything up."""
    after = _carrier_total(con, 19690, "2024-09", "operating")
    assert 19690 in after


def test_composite_route_filter_excludes_self_routes_the_naive_form_matches(con):
    """least()/greatest() vs the naive `route_key_low IN (...) AND route_key_high IN (...)`
    this task exists to replace -- both are syntactically valid SQL that execute without
    raising, so a test that only asserts "does not raise" cannot tell them apart (that was
    this test's earlier, non-discriminating form). This asserts the actual ROW COUNT
    differs: the naive form additionally matches route_key_low = route_key_high self-route
    filings at EACH endpoint airport, which least()/greatest() correctly excludes.

    Measured against upgauge.duckdb, JFK-LAX (12478-12892), 2015-01..2020-12, NOT
    is_quarantined: the composite filter renders exactly 1 group -- (12478, 12892), 21,104,715
    seats. The naive IN/IN form additionally matches (12478, 12478) (204 seats) and
    (12892, 12892) (2,386 seats) -- 2 extra self-route groups, 2,590 seats of inflation.
    """
    sql, params = render_pivot(
        PivotQuery(
            grain="segment", dimensions=("route",), measures=("seats",),
            time_from="2015-01", time_to="2020-12",
            filters=(("route", ("12478-12892",)),),
        ),
        con,
    )
    correct_rows = con.execute(sql, params).fetchall()

    # Deliberately NOT derived from `sql` by string substitution: this must fail if the
    # implementation itself regresses to the naive form, which it would not if it merely
    # echoed back whatever `sql` already contains.
    naive_sql = """
        SELECT route_key_low, route_key_high,
               SUM(seats) FILTER (WHERE NOT is_quarantined) AS seats
        FROM fct_segment_month
        WHERE year_month BETWEEN $time_from AND $time_to
          AND route_key_low IN ($a, $b)
          AND route_key_high IN ($a, $b)
        GROUP BY route_key_low, route_key_high
    """
    naive_rows = con.execute(
        naive_sql, {"time_from": "2015-01", "time_to": "2020-12", "a": 12478, "b": 12892}
    ).fetchall()

    assert len(correct_rows) != len(naive_rows), (
        "row counts are equal -- the composite filter is no longer discriminating self-routes "
        "from the naive IN/IN form"
    )
    assert len(naive_rows) > len(correct_rows), (
        f"correct={len(correct_rows)} rows, naive={len(naive_rows)} rows -- the naive form "
        "should match strictly MORE rows (it also matches route_key_low=route_key_high "
        "self-routes at both endpoint airports), so it should never be the smaller count"
    )
