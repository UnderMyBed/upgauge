"""Structural enforcement of the derived-measure rule.

`AVG(load_factor)` is the #1 bug in every homemade T-100 tool. The defence is that the
column does not exist to be averaged. mart_route_health is the single exception, permitted
only because it has no time grain. Four guards here, not all of them about averaging
directly:

- `test_no_fct_object_carries_a_derived_column` -- no `fct_*` object stores a derived
  column at all, so there is nothing on a fact table to average by mistake.
- `test_no_mart_derived_column_is_ever_aggregated_in_sql` -- none of mart_route_health's
  own derived columns is ever fed into `SUM`/`AVG`/`MEAN`/`MEDIAN` anywhere else in `sql/`.
  This is a source-text scan, not a semantic one: known gap below.
- `test_mart_route_health_still_has_no_time_grain` -- asserts the exception's own
  justification directly, rather than trusting that no one adds a time column later.
- `test_only_marts_are_materialized_as_tables` -- not a derived-measure test on its own,
  but the boundary these guards police is "marts may store derived columns, fct_*/dim_*
  may not," and that boundary is only meaningful if materialization also tracks the
  fct/dim vs. mart split. It additionally protects M1's byte-identical Parquet gate, which
  stops covering an object the moment it becomes a table instead of a view.

Known gap: the source-text scan matches against whitespace-collapsed text, so a
hand-wrapped `SUM(\\n  lf_delta\\n)` split across lines is caught (see
`_flatten_with_line_map`), but it is still a substring match over normalised text, not a
SQL parser -- a derived column name reused as an unrelated identifier in a different
schema, or one aggregate's closing paren landing immediately before an unrelated bare
column reference of the same name, could in principle still confuse it. No such case
exists in `sql/` today; see docs/data/model.md for the residual limitation this implies.
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb
import pytest

from pipeline.marts import build_database, mart_files
from pipeline.tests.test_marts import _warehouse

SQL_ROOT = Path(__file__).parents[2] / "sql"

DERIVED_NAMES = frozenset(
    {
        "load_factor",
        "asm",
        "rpm",
        "avg_gauge",
        "completion_factor",
        "block_hours",
        "avg_stage_length",
        "frequency",
    }
)

#: Derived columns mart_route_health is allowed to store. Aggregating any of them is the
#: exact mistake the rule exists to prevent.
MART_DERIVED_COLUMNS = frozenset(
    {
        "lf_t12",
        "lf_p12",
        "lf_delta",
        "gauge_t12",
        "gauge_p12",
        "gauge_delta",
        "capacity_delta",
        "frequency_delta",
        "completion_factor",
        "health_score",
    }
)


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("rules")
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    return duckdb.connect(str(db))


def test_no_fct_object_carries_a_derived_column(con):
    facts = [
        r[0]
        for r in con.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'fct_%'"
        ).fetchall()
    ]
    assert facts, "no fct_* objects found -- the test would pass vacuously"
    for name in facts:
        cols = {r[0].lower() for r in con.execute(f"DESCRIBE {name}").fetchall()}
        offending = cols & DERIVED_NAMES
        assert not offending, f"{name} stores derived column(s): {sorted(offending)}"


def _flatten_with_line_map(text: str) -> tuple[str, list[tuple[int, int]]]:
    """Collapse whitespace runs -- including newlines -- to a single space, so a
    hand-wrapped `SUM(\n  lf_delta\n)` reads identically to `SUM( lf_delta )`. Comment
    lines are dropped entirely rather than collapsed, so a derived column named only in a
    comment cannot trigger a match.

    Returns the flattened text plus a list of (offset, source_line_number) markers so a
    match position in the flattened text can be mapped back to an actionable line number.
    """
    parts: list[str] = []
    markers: list[tuple[int, int]] = []
    offset = 0
    for lineno, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("--"):
            continue
        collapsed = re.sub(r"\s+", " ", line).strip()
        if not collapsed:
            continue
        if parts:
            parts.append(" ")
            offset += 1
        markers.append((offset, lineno))
        parts.append(collapsed)
        offset += len(collapsed)
    return "".join(parts), markers


def _line_for_offset(markers: list[tuple[int, int]], pos: int) -> int:
    lineno = markers[0][1] if markers else 1
    for start, candidate in markers:
        if start > pos:
            break
        lineno = candidate
    return lineno


def test_no_mart_derived_column_is_ever_aggregated_in_sql(con):
    """mart_route_health has no time grain, so there is nothing to GROUP BY -- which is the
    whole justification for letting it store these columns. An aggregate over one is a sign
    that assumption has stopped holding.

    Matches against whitespace-collapsed text (see `_flatten_with_line_map`), not raw
    lines, specifically so a hand- or formatter-wrapped multi-line aggregate call cannot
    slip past a naive line-by-line regex."""
    names = "|".join(sorted(MART_DERIVED_COLUMNS))
    pattern = re.compile(
        r"\b(sum|avg|mean|median)\s*\(\s*[\w.]*\b(" + names + r")\b",
        re.IGNORECASE,
    )
    offences = []
    for path in sorted(SQL_ROOT.rglob("*.sql")):
        # The mart's own definition computes these; it does not aggregate them.
        if path.name == "200_mart_route_health.sql":
            continue
        flat, markers = _flatten_with_line_map(path.read_text())
        for match in pattern.finditer(flat):
            lineno = _line_for_offset(markers, match.start())
            snippet = flat[match.start() : match.start() + 80]
            offences.append(f"{path.relative_to(SQL_ROOT)}:{lineno}: {snippet}")
    assert not offences, "derived mart columns aggregated:\n" + "\n".join(offences)


def test_mart_route_health_still_has_no_time_grain(con):
    """The exception's justification, asserted directly. If a time column ever appears here,
    the derived columns must come back out."""
    cols = {r[0].lower() for r in con.execute("DESCRIBE mart_route_health").fetchall()}
    time_grain = {"year_month", "year", "quarter", "month"}
    assert not cols & time_grain, (
        "mart_route_health gained a time grain, which invalidates its permission to store "
        "derived columns -- see docs/data/model.md"
    )


def test_only_marts_are_materialized_as_tables():
    """Facts and dims must stay views, or M1's byte-identical Parquet gate stops covering
    them and the reproducibility story quietly shrinks."""
    tables = [m.object_name for m in mart_files() if m.materialization == "table"]
    assert tables == ["mart_route_health"], tables
