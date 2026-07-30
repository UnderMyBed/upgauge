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
