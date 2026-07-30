"""The Explorer's vocabulary, as catalog objects.

Curated, not introspected: which dimensions we OFFER is a product decision, not a schema
fact. But every offered column must exist, or the Explorer silently loses a dimension --
so a drift test cross-checks the curated list against duckdb_columns().
"""

from __future__ import annotations

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.tests.test_marts import _warehouse


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("allowlist")
    db = tmp_path / "u.duckdb"
    build_database(_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


def test_all_twelve_dimensions_are_offered(con):
    keys = {r[0] for r in con.execute("SELECT key FROM meta_pivot_dimensions").fetchall()}
    assert keys == {
        "year_month",
        "quarter",
        "year",
        "op_airline_id",
        "origin_airport_id",
        "dest_airport_id",
        "route",
        "origin_city_market_id",
        "dest_city_market_id",
        "origin_state",
        "dest_state",
        "aircraft_type",
        "aircraft_group",
        "distance_group",
    }


def test_every_offered_dimension_column_actually_exists(con):
    """The drift guard. A renamed fact column must fail loudly here, not silently drop a
    dimension from the Explorer.

    Asserts EVERY referenced token resolves, not merely that one does -- `route`'s expr is
    `route_key_low, route_key_high`, so a heuristic that passes when *any* token matches
    would miss one of the pair being renamed.
    """
    for key, expr, grain in con.execute(
        "SELECT key, column_expr, grain FROM meta_pivot_dimensions"
    ).fetchall():
        targets = (
            ["fct_segment_month", "fct_route_month"] if grain == "both" else [f"fct_{grain}_month"]
        )
        referenced = {t.strip() for t in expr.split(",") if t.strip()}
        assert referenced, f"{key}: empty column_expr"
        for obj in targets:
            cols = {r[0] for r in con.execute(f"DESCRIBE {obj}").fetchall()}
            missing = referenced - cols
            assert not missing, f"{key}: {sorted(missing)} not on {obj}"


def test_exactly_the_five_segment_only_dimensions_are_marked_segment(con):
    """Measured against the built catalog: fct_route_month carries NONE of these five.
    Offering any of them at route grain renders SQL that fails at execution rather than at
    validation, which is a 500 instead of a clear rejection."""
    segment_only = {
        r[0]
        for r in con.execute(
            "SELECT key FROM meta_pivot_dimensions WHERE grain = 'segment'"
        ).fetchall()
    }
    assert segment_only == {
        "origin_state",
        "dest_state",
        "aircraft_type",
        "aircraft_group",
        "distance_group",
    }
    route_cols = {r[0] for r in con.execute("DESCRIBE fct_route_month").fetchall()}
    assert not (segment_only & route_cols), "a segment-only dimension exists at route grain"


def test_every_both_grain_dimension_exists_at_both_grains(con):
    """The other direction: a dimension marked 'both' must really be on fct_route_month."""
    route_cols = {r[0] for r in con.execute("DESCRIBE fct_route_month").fetchall()}
    for key, expr in con.execute(
        "SELECT key, column_expr FROM meta_pivot_dimensions WHERE grain = 'both'"
    ).fetchall():
        referenced = {t.strip() for t in expr.split(",")}
        assert referenced <= route_cols, (
            f"{key} marked 'both' but {referenced - route_cols} missing"
        )


def test_measures_split_additive_from_derived(con):
    rows = dict(con.execute("SELECT key, is_additive FROM meta_pivot_measures").fetchall())
    assert rows["seats"] is True
    assert rows["passengers"] is True
    assert rows["load_factor"] is False
    assert rows["asm"] is False


def test_no_measure_expression_averages_a_ratio(con):
    """The #1 bug in every homemade T-100 tool, asserted against the vocabulary itself."""
    for key, expr in con.execute("SELECT key, expr FROM meta_pivot_measures").fetchall():
        lowered = expr.lower()
        assert "avg(" not in lowered, f"{key} averages: {expr}"
        assert "mean(" not in lowered, f"{key} averages: {expr}"


def test_asm_and_rpm_multiply_before_summing(con):
    """SUM(seats) * distance is correct only within one route and silently wrong across a
    pivot that groups several. The expression must multiply per row."""
    exprs = dict(con.execute("SELECT key, expr FROM meta_pivot_measures").fetchall())
    assert "sum(seats * distance)" in exprs["asm"].lower().replace("  ", " ")
    assert "sum(passengers * distance)" in exprs["rpm"].lower().replace("  ", " ")
