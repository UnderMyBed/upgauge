"""The handoff artifact. Consumes sql/03_queries/goldens/{pivot,urlstate}.json.

Those two files are DATA, not SQL -- they pin `render_pivot`'s rendered SQL/params and
`pipeline.urlstate`'s encode/decode contract beside the templates and codec they describe, so
M3b's TypeScript is a verification exercise against fixed bytes rather than a second,
drifting port of this module's semantics. See each JSON file's own `_data_not_sql` header.

Regenerate ONLY via `make goldens` (`python -m pipeline.pivot --write-goldens`), and read the
diff by eye before committing -- a golden file is only as good as its first generation; if
the SQL in it is wrong, every future run of this test cheerfully confirms the wrong thing.

This test intentionally does NOT regenerate before comparing. A golden suite that regenerates
its own fixture and then compares against itself tests nothing -- see the M3a SDD report for
the mutation that proves it: editing `301_meta_pivot_measures.sql`'s `load_factor` expression
and re-running this file (without `make goldens`) must FAIL, naming the case.
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.pivot import query_from_jsonable, render_pivot
from pipeline.tests.test_marts import _warehouse
from pipeline.urlstate import decode, encode

GOLDENS_DIR = Path(__file__).parents[2] / "sql" / "03_queries" / "goldens"
PIVOT_GOLDENS = GOLDENS_DIR / "pivot.json"
URLSTATE_GOLDENS = GOLDENS_DIR / "urlstate.json"


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("goldens")
    db = tmp_path / "u.duckdb"
    build_database(_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def test_pivot_goldens_file_exists():
    assert PIVOT_GOLDENS.exists(), (
        f"{PIVOT_GOLDENS} is missing -- run `make goldens` to generate it"
    )


def test_urlstate_goldens_file_exists():
    assert URLSTATE_GOLDENS.exists(), (
        f"{URLSTATE_GOLDENS} is missing -- run `make goldens` to generate it"
    )


def _pivot_cases() -> list[tuple[str, dict]]:
    if not PIVOT_GOLDENS.exists():
        return []
    data = _load(PIVOT_GOLDENS)
    return [(c["name"], c) for c in data["cases"]]


def _urlstate_cases() -> list[tuple[str, dict]]:
    if not URLSTATE_GOLDENS.exists():
        return []
    data = _load(URLSTATE_GOLDENS)
    return [(c["name"], c) for c in data["cases"]]


@pytest.mark.parametrize("name,case", _pivot_cases(), ids=[n for n, _ in _pivot_cases()])
def test_pivot_case_renders_to_the_pinned_sql_and_params(con, name, case):
    query = query_from_jsonable(case["query"])
    sql, params = render_pivot(query, con)
    assert sql == case["sql"], f"{name}: rendered SQL no longer matches the pinned golden"
    assert params == case["params"], f"{name}: bound params no longer match the pinned golden"


@pytest.mark.parametrize("name,case", _pivot_cases(), ids=[n for n, _ in _pivot_cases()])
def test_pivot_case_sql_actually_executes(con, name, case):
    """A golden that pins SQL DuckDB can't run would be worthless -- it would keep confirming
    a query nobody could actually use."""
    query = query_from_jsonable(case["query"])
    sql, params = render_pivot(query, con)
    con.execute(sql, params).fetchall()


@pytest.mark.parametrize("name,case", _urlstate_cases(), ids=[n for n, _ in _urlstate_cases()])
def test_urlstate_case_encodes_to_the_pinned_url(name, case):
    query = query_from_jsonable(case["query"])
    assert encode(query) == case["url"], f"{name}: encode() no longer matches the pinned URL"


@pytest.mark.parametrize("name,case", _urlstate_cases(), ids=[n for n, _ in _urlstate_cases()])
def test_urlstate_case_decodes_back_to_the_query(con, name, case):
    query = query_from_jsonable(case["query"])
    assert decode(case["url"], con) == query, (
        f"{name}: decode() of the pinned URL no longer reproduces the pinned query"
    )


def test_pivot_goldens_cover_the_required_cases():
    """The minimum case list the M3a plan requires -- a golden file that quietly loses a case
    (someone editing the JSON by hand, or a bad regeneration) is exactly what byte-for-byte
    parity depends on catching."""
    names = {n for n, _ in _pivot_cases()}
    required = {
        "single_dimension_segment",
        "multi_dimension_segment",
        "route_grain",
        "derived_measure_load_factor",
        "filtered_by_carrier",
        "mainline_grouped",
        "ascending_sort",
        "sort_by_carrier_under_mainline_grouping",
    }
    assert required <= names, f"missing required pivot cases: {required - names}"


def test_urlstate_goldens_cover_the_required_cases():
    names = {n for n, _ in _urlstate_cases()}
    required = {
        "route_grain",
        "mainline_grouping",
        "filter_value_reserved_characters",
    }
    assert required <= names, f"missing required urlstate cases: {required - names}"
