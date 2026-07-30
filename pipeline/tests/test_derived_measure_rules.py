"""Structural enforcement of the derived-measure rule.

`AVG(load_factor)` is the #1 bug in every homemade T-100 tool. The defence is that the
column does not exist to be averaged. mart_route_health is the single exception, permitted
only because it has no time grain -- so these two tests police the boundary of that
exception rather than trusting a convention.
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


def test_no_mart_derived_column_is_ever_aggregated_in_sql(con):
    """mart_route_health has no time grain, so there is nothing to GROUP BY -- which is the
    whole justification for letting it store these columns. An aggregate over one is a sign
    that assumption has stopped holding."""
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
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if line.lstrip().startswith("--"):
                continue
            if pattern.search(line):
                offences.append(f"{path.relative_to(SQL_ROOT)}:{n}: {line.strip()}")
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


def test_every_mart_file_declares_a_known_materialization():
    """A typo'd directive must not silently skip an object."""
    for mart in mart_files():
        assert mart.materialization in {"view", "table"}


def test_only_marts_are_materialized_as_tables():
    """Facts and dims must stay views, or M1's byte-identical Parquet gate stops covering
    them and the reproducibility story quietly shrinks."""
    tables = [m.object_name for m in mart_files() if m.materialization == "table"]
    assert tables == ["mart_route_health"], tables
