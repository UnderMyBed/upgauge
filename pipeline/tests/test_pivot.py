"""Pivot SQL rendering: validation, substitution, injection.

Only identifiers are substituted, and only after allowlist validation. Values are always
bound params. Request input never reaches a substitution slot un-validated.
"""

from __future__ import annotations

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.pivot import PivotError, PivotQuery, render_pivot
from pipeline.tests.test_marts import _warehouse


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("pivot")
    db = tmp_path / "u.duckdb"
    build_database(_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


def q(**kw):
    base = dict(
        grain="segment",
        dimensions=("op_airline_id",),
        measures=("seats",),
        time_from="2015-01",
        time_to="2015-12",
    )
    base.update(kw)
    return PivotQuery(**base)


def test_renders_and_executes(con):
    sql, params = render_pivot(q(), con)
    rows = con.execute(sql, params).fetchall()
    assert rows


def test_values_are_bound_never_interpolated(con):
    sql, params = render_pivot(q(), con)
    assert "2015-01" not in sql, "time range leaked into the SQL text"
    assert params["time_from"] == "2015-01"


def test_unknown_dimension_is_rejected(con):
    with pytest.raises(PivotError, match="dimension"):
        render_pivot(q(dimensions=("not_a_dimension",)), con)


def test_unknown_measure_is_rejected(con):
    with pytest.raises(PivotError, match="measure"):
        render_pivot(q(measures=("profit",)), con)


def test_sql_injection_via_dimension_is_rejected(con):
    """The whole point of the allowlist. This must raise, never substitute."""
    with pytest.raises(PivotError):
        render_pivot(q(dimensions=("op_airline_id; DROP TABLE fct_segment_month--",)), con)


def test_sql_injection_via_sort_is_rejected(con):
    with pytest.raises(PivotError, match="sort"):
        render_pivot(q(sort="seats; DELETE FROM dim_carrier--"), con)


def test_unknown_filter_key_is_rejected(con):
    """A filter key goes through the SAME `_validate_dimension` gate as the dimension list
    (see its docstring) -- so an unknown key must be rejected exactly like an unknown
    dimension, not silently substituted into the WHERE clause."""
    with pytest.raises(PivotError, match="dimension"):
        render_pivot(q(filters=(("not_a_dimension", ("x",)),)), con)


def test_sql_injection_via_filter_key_is_rejected(con):
    """The filter key reaches a WHERE-clause identifier slot (`{columns[0]} IN (...)`) just
    like a dimension key reaches a SELECT/GROUP BY slot. This must raise, never substitute --
    same as test_sql_injection_via_dimension_is_rejected above, but for the filter loop."""
    with pytest.raises(PivotError):
        render_pivot(q(filters=(("op_airline_id; DROP TABLE fct_segment_month--", ("x",)),)), con)


def test_segment_only_dimension_rejected_at_route_grain(con):
    """aircraft_type does not exist on fct_route_month; offering it would render SQL that
    fails at execution rather than validation."""
    with pytest.raises(PivotError, match="grain"):
        render_pivot(q(grain="route", dimensions=("aircraft_type",)), con)


def test_quarantined_rows_are_excluded_and_reported(con):
    """Renamed from `_are_excluded_but_counted`: the original version only asserted the
    `quarantined_rows` COLUMN is present, which cannot detect a broken exclusion -- a FILTER
    silently stripped from a measure's expr (the Task 4 defect this branch's whole-branch
    review found recurring on 8 of 12 measures) would leave that column present and this
    test green regardless. This recomputes `departures_performed` independently from the raw
    fact rows and confirms the pivot's sum actually EXCLUDES the quarantined ones."""
    sql, params = render_pivot(q(measures=("departures_performed",)), con)
    cols = [d[0] for d in con.execute(sql, params).description]
    assert "quarantined_rows" in cols, "the UI must be able to surface the dirt"

    dep_idx = cols.index("departures_performed")
    # A group whose only rows are quarantined sums to NULL (FILTER (WHERE NOT
    # is_quarantined) matches nothing) -- correct (see 301_meta_pivot_measures.sql), and
    # equivalent to 0 for this recomputed total.
    got = sum(row[dep_idx] or 0 for row in con.execute(sql, params).fetchall())

    total_including_quarantined, quarantined_only = con.execute(
        """
        SELECT
            SUM(departures_performed),
            SUM(departures_performed) FILTER (WHERE is_quarantined)
        FROM fct_segment_month
        WHERE year_month BETWEEN '2015-01' AND '2015-12'
        """
    ).fetchone()
    assert quarantined_only, "fixture has no quarantined rows in range -- test can't discriminate"
    assert got == pytest.approx(total_including_quarantined - quarantined_only)


def test_limit_is_bound_and_enforced(con):
    sql, params = render_pivot(q(dimensions=("origin_airport_id",), limit=3), con)
    assert len(con.execute(sql, params).fetchall()) <= 3


def test_derived_measure_is_computed_not_averaged(con):
    sql, _ = render_pivot(q(measures=("load_factor",)), con)
    assert "AVG(" not in sql.upper()
    # Each SUM carries its own quarantine FILTER (see 301_meta_pivot_measures.sql) -- the
    # numerator and denominator are summed from raw rows, never from an averaged ratio.
    assert "NULLIF(SUM(seats) FILTER (WHERE NOT is_quarantined), 0)" in sql


def test_filters_bind_their_values(con):
    sql, params = render_pivot(q(filters=(("op_airline_id", ("19790",)),)), con)
    assert "19790" not in sql
    assert "19790" in str(params.values())


def test_empty_dimensions_is_rejected(con):
    """An empty dimension list renders a stray-comma SELECT that fails at the DuckDB parser,
    not at validation. Deselecting every dimension is a plausible Explorer UI state."""
    with pytest.raises(PivotError, match="dimension"):
        render_pivot(q(dimensions=()), con)


def test_empty_measures_is_rejected(con):
    with pytest.raises(PivotError, match="measure"):
        render_pivot(q(measures=()), con)


def test_non_integer_limit_is_rejected(con):
    with pytest.raises(PivotError, match="limit"):
        render_pivot(q(limit=1.5), con)


def test_negative_limit_is_rejected(con):
    with pytest.raises(PivotError, match="limit"):
        render_pivot(q(limit=-1), con)


def test_zero_limit_is_rejected(con):
    with pytest.raises(PivotError, match="limit"):
        render_pivot(q(limit=0), con)


def test_empty_filter_values_is_rejected(con):
    """A filter with no values renders `IN ()`, invalid SQL -- and a filter with an empty
    value list is not a meaningful request in the first place."""
    with pytest.raises(PivotError, match="filter"):
        render_pivot(q(filters=(("op_airline_id", ()),)), con)


def test_unknown_grouping_is_rejected(con):
    """grouping is documented as "operating" | "mainline" -- anything else must not silently
    fall through to operating semantics, which would render the wrong query without error."""
    with pytest.raises(PivotError, match="grouping"):
        render_pivot(q(grouping="Mainline"), con)


def test_sort_by_carrier_dimension_works_under_operating_grouping(con):
    sql, params = render_pivot(q(sort="op_airline_id", grouping="operating"), con)
    con.execute(sql, params).fetchall()


def test_sort_by_carrier_dimension_works_under_mainline_grouping(con):
    """Regression: under grouping='mainline', op_airline_id's GROUP BY expression becomes
    coalesce(m.parent_airline_id, f.op_airline_id), but ORDER BY was still pointing at the
    bare column name -- which is no longer in the GROUP BY list, so DuckDB's binder rejects
    it. Clicking a column header to sort by carrier is the most natural Explorer interaction
    there is."""
    sql, params = render_pivot(q(sort="op_airline_id", grouping="mainline"), con)
    con.execute(sql, params).fetchall()


def test_sort_desc_normalizes_to_true_when_sort_is_none():
    """`sort_desc` only matters once a sort key exists -- with sort=None, render_pivot reads
    it for the DEFAULT sort's direction, so sort=None/sort_desc=False is not a no-op, it
    renders ASC instead of DESC. But the URL codec's `s=` key only ever carries a direction
    alongside a sort key (`pipeline/urlstate.py`'s `encode`), so that combination has no URL
    representation. Constructing it must normalize rather than silently produce a PivotQuery
    the codec cannot round-trip."""
    normalized = PivotQuery(
        grain="segment",
        dimensions=("op_airline_id",),
        measures=("seats",),
        time_from="2015-01",
        time_to="2015-12",
        sort=None,
        sort_desc=False,
    )
    assert normalized.sort_desc is True
    assert normalized == PivotQuery(
        grain="segment",
        dimensions=("op_airline_id",),
        measures=("seats",),
        time_from="2015-01",
        time_to="2015-12",
        sort=None,
        sort_desc=True,
    )


def test_composite_dimension_filter_emits_least_greatest(con):
    sql, params = render_pivot(q(filters=(("route", ("12478-12892",)),)), con)
    assert (
        "(least(route_key_low, route_key_high) = $f0_0a "
        "AND greatest(route_key_low, route_key_high) = $f0_0b)"
    ) in sql
    assert params["f0_0a"] == "12478"
    assert params["f0_0b"] == "12892"


def test_composite_filter_values_are_or_joined(con):
    """Multiple values keep the IN-list semantics every other dimension has: either route."""
    sql, params = render_pivot(q(filters=(("route", ("12478-12892", "10140-14747")),)), con)
    assert " OR " in sql
    assert "$f0_1a" in sql and "$f0_1b" in sql
    assert params["f0_1a"] == "10140"
    assert params["f0_1b"] == "14747"


def test_composite_filter_rejects_a_malformed_pair(con):
    with pytest.raises(PivotError, match="two ids joined by"):
        render_pivot(q(filters=(("route", ("12478",)),)), con)


def test_composite_filter_rejects_a_non_numeric_pair(con):
    """'JFK-LAX' has two non-empty dash-separated parts, so the length/non-empty check alone
    let it through to a bound string param -- DuckDB then threw an unhandled Conversion Error
    deep inside execution, which the TypeScript call sites only guarded PivotError against.
    Fails if the digit check is dropped, or narrowed to reject only non-ASCII digits."""
    with pytest.raises(PivotError, match="two ids joined by"):
        render_pivot(q(filters=(("route", ("JFK-LAX",)),)), con)


def test_composite_filter_strips_ascii_whitespace(con):
    """Pins the ASCII whitespace set app/src/lib/pivot/render.ts's stripAsciiWhitespace
    mirrors -- not bare .strip()/.trim(), which disagree on non-ASCII whitespace (documented,
    not asserted here: no golden exercises that edge)."""
    _, params = render_pivot(q(filters=(("route", (" 12478 - 12892\t",)),)), con)
    assert params["f0_0a"] == "12478"
    assert params["f0_0b"] == "12892"


def test_single_column_filter_is_unchanged(con):
    """The existing IN-list path must not move -- 17 goldens depend on it."""
    sql, params = render_pivot(q(filters=(("origin_state", ("OR", "WA")),)), con)
    assert "origin_state IN ($f0_0, $f0_1)" in sql
    assert params["f0_0"] == "OR" and params["f0_1"] == "WA"


def test_output_column_names_match_across_grouping_modes(con):
    """A client (including M3b's TypeScript port) must be able to key a pivot's results by
    column name regardless of which grouping mode was requested."""
    op_sql, op_params = render_pivot(q(grouping="operating"), con)
    ml_sql, ml_params = render_pivot(q(grouping="mainline"), con)
    op_cols = [d[0] for d in con.execute(op_sql, op_params).description]
    ml_cols = [d[0] for d in con.execute(ml_sql, ml_params).description]
    assert op_cols == ml_cols


# M7 Task 2: endpoint_airport_id also spans two columns, but unlike route -- ONE route pair,
# least()/greatest() equality -- its two columns are ALTERNATIVES, compiled to an OR.
# filter_only is the other half of the same catalog row: accepted in a filter, rejected as a
# grouping dimension, since grouping by it would double-count every segment row into both its
# origin's group and its dest's group.
def test_either_mode_filter_compiles_to_an_or_across_both_columns(con):
    """Catches: compiling `either` through the single-column branch (origin only), which is
    the SILENT half of an airport query -- SEA reads 26,710,000 seats instead of 53,373,806
    and every row still renders perfectly."""
    sql, params = render_pivot(q(filters=(("endpoint_airport_id", ("14747",)),)), con)
    assert "(origin_airport_id IN ($f0_0) OR dest_airport_id IN ($f0_0))" in sql
    assert params["f0_0"] == "14747"


def test_either_mode_filter_ors_multiple_values_inside_each_side(con):
    sql, params = render_pivot(q(filters=(("endpoint_airport_id", ("14747", "13930")),)), con)
    assert "(origin_airport_id IN ($f0_0, $f0_1) OR dest_airport_id IN ($f0_0, $f0_1))" in sql
    assert params["f0_0"] == "14747"
    assert params["f0_1"] == "13930"


def test_filter_only_dimension_rejected_as_a_grouping_dimension(con):
    """Catches: allowing endpoint_airport_id in `dimensions`, which double-counts every row."""
    with pytest.raises(PivotError, match="cannot be grouped by; it is filter-only"):
        render_pivot(q(dimensions=("endpoint_airport_id",)), con)


def test_route_still_compiles_as_a_least_greatest_pair_not_an_or(con):
    """Catches: the new `either` branch swallowing `pair` -- which would make a route filter
    match same-airport rows again (18,895 seats on JFK-LAX)."""
    sql, params = render_pivot(q(filters=(("route", ("12478-12892",)),)), con)
    assert "least(route_key_low, route_key_high) = $f0_0a" in sql
    assert " OR dest_airport_id IN " not in sql
