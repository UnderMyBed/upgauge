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
    base = dict(grain="segment", dimensions=("op_airline_id",), measures=("seats",),
                time_from="2015-01", time_to="2015-12")
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


def test_segment_only_dimension_rejected_at_route_grain(con):
    """aircraft_type does not exist on fct_route_month; offering it would render SQL that
    fails at execution rather than validation."""
    with pytest.raises(PivotError, match="grain"):
        render_pivot(q(grain="route", dimensions=("aircraft_type",)), con)


def test_quarantined_rows_are_excluded_but_counted(con):
    sql, params = render_pivot(q(), con)
    cols = [d[0] for d in con.execute(sql, params).description]
    assert "quarantined_rows" in cols, "the UI must be able to surface the dirt"


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
    sql, params = render_pivot(
        q(filters=(("op_airline_id", ("19790",)),)), con)
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
