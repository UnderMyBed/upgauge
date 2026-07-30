"""The Explorer's vocabulary, as catalog objects.

Curated, not introspected: which dimensions we OFFER is a product decision, not a schema
fact. But every offered column must exist, or the Explorer silently loses a dimension --
so a drift test cross-checks the curated list against duckdb_columns().
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.pivot import QUERIES_DIR
from pipeline.tests.test_marts import _warehouse


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("allowlist")
    db = tmp_path / "u.duckdb"
    build_database(_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


def test_all_fourteen_dimensions_are_offered(con):
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


def test_every_sum_is_quarantine_filtered(con):
    """Direct recurrence guard for a Task 4 defect: without `FILTER (WHERE NOT
    is_quarantined)` on EVERY `SUM(...)`, quarantined rows silently re-enter the aggregate --
    a bare `WHERE` in the template can't do this job instead, because it would remove
    quarantined rows before `count(*) FILTER (WHERE is_quarantined)` could still count them
    (see 301_meta_pivot_measures.sql's header). Whole-branch review found this guarded for
    only 4 of the 12 measures (the ones a golden or real-data test happened to touch); this
    checks the full catalog structurally, one `SUM(` at a time, so a new measure added
    without the FILTER fails here instead of shipping unguarded.
    """
    for key, expr in con.execute("SELECT key, expr FROM meta_pivot_measures").fetchall():
        sums = list(re.finditer(r"SUM\([^()]*\)", expr))
        assert sums, f"{key}: no SUM( found in expr: {expr}"
        for m in sums:
            tail = expr[m.end() :].lstrip()
            assert tail.startswith("FILTER (WHERE NOT is_quarantined)"), (
                f"{key}: {m.group()!r} is not immediately FILTERed by "
                f"NOT is_quarantined: {expr}"
            )


def test_asm_and_rpm_multiply_before_summing(con):
    """SUM(seats) * distance is correct only within one route and silently wrong across a
    pivot that groups several. The expression must multiply per row."""
    exprs = dict(con.execute("SELECT key, expr FROM meta_pivot_measures").fetchall())
    assert "sum(seats * distance)" in exprs["asm"].lower().replace("  ", " ")
    assert "sum(passengers * distance)" in exprs["rpm"].lower().replace("  ", " ")


def test_load_allowlist_reads_its_sql_from_files_not_string_literals():
    """CLAUDE.md: all query logic lives in .sql files, never inline string literals.

    The server reads these same two files from TypeScript, which is the reason the rule
    exists -- one definition, two runtimes. A grep guard is cheap and catches the
    regression at the moment someone reintroduces a convenient inline SELECT.
    """
    source = (Path(__file__).resolve().parents[1] / "pivot.py").read_text()
    assert "SELECT * FROM meta_pivot_dimensions" not in source
    assert "SELECT * FROM meta_pivot_measures" not in source

    for name in ("catalog_dimensions", "catalog_measures", "data_as_of"):
        path = QUERIES_DIR / f"{name}.sql"
        assert path.exists(), f"{name}.sql is missing"
        assert "SELECT" in path.read_text().upper()
