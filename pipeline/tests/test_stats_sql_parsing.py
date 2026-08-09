"""`pipeline.stats.measures_sql`'s parser, exercised against text fixtures instead of the real
warehouse. Deliberately NOT skip-guarded on `upgauge.duckdb` -- unlike test_stats.py, these are
pure text parsing and must run on a fresh clone and in CI without a built catalog.

Two authoring mistakes the parser must refuse rather than swallow:

1. A duplicate `-- name:` marker. The naive split-and-build loop lets the second block silently
   overwrite the first in the output dict, so a copy-pasted template block that keeps the old
   name loses a measure with zero signal.
2. An embedded `;` inside a measure body. Confirmed against DuckDB:
   `con.execute("SELECT 1; SELECT 2;").fetchall()` returns `[(2,)]` -- a stray second statement
   silently executes and its result is reported under the first statement's name. The `_SCALAR`
   guard in `collect()` only checks the returned SHAPE (one row, one column), and a second
   `count(...)`-shaped statement passes that shape check, so this has no other line of defense.
"""

from __future__ import annotations

import pytest

from pipeline.stats import measures_sql


def test_duplicate_marker_raises(tmp_path):
    sql = tmp_path / "dup.sql"
    sql.write_text("-- name: foo\nSELECT 1;\n\n-- name: foo\nSELECT 2;\n")
    with pytest.raises(ValueError, match="foo"):
        measures_sql(sql)


def test_embedded_semicolon_raises(tmp_path):
    sql = tmp_path / "semi.sql"
    sql.write_text("-- name: foo\nSELECT 1; SELECT 2;\n")
    with pytest.raises(ValueError, match="foo"):
        measures_sql(sql)


def test_happy_path_parses_expected_names(tmp_path):
    sql = tmp_path / "ok.sql"
    sql.write_text("-- name: foo\nSELECT 1;\n\n-- name: bar\nSELECT 2;\n")
    assert measures_sql(sql) == {"foo": "SELECT 1", "bar": "SELECT 2"}


def test_trailing_statement_without_semicolon_still_parses(tmp_path):
    """Pinned so it stays working: the last block in a file need not end with `;` (DuckDB
    doesn't require one), and that must keep parsing rather than becoming collateral damage of
    the embedded-`;` guard above."""
    sql = tmp_path / "no_trailing_semicolon.sql"
    sql.write_text("-- name: foo\nSELECT 1\n")
    assert measures_sql(sql) == {"foo": "SELECT 1"}
