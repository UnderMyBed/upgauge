"""The either-endpoint filter, asserted against the real warehouse.

`/airport/<code>` must report an airport as BOTH endpoints. Through M6 that was assembled
arithmetically from three pivots (origin, dest, their overlap) because the pivot vocabulary
had no way to express `origin = X OR dest = X`. M7 Tasks 1-2 added a first-class
`endpoint_airport_id` filter (filter_only, filter_mode='either') that compiles to exactly that
OR. This test is what licenses collapsing `/airport` onto it (Task 3): the new single-pivot
query must reproduce the number the three-pivot inclusion-exclusion has committed since M4d.

Expected counts are recorded in docs/data/invariants.md and CLAUDE.md. If BTS amends a filing
these can legitimately move; a change here is a signal to re-read the data, not to edit the
number until it passes.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from pipeline import pivot

DB = Path("upgauge.duckdb")
pytestmark = pytest.mark.skipif(not DB.exists(), reason="no built catalog; run `make build`")

SEA_AIRPORT_ID = 14747
T12_FROM, T12_TO = "2025-05", "2026-04"


@pytest.fixture(scope="module")
def warehouse_con():
    return duckdb.connect(str(DB), read_only=True)


def _seats_total(con: duckdb.DuckDBPyConnection, filter_key: str, filter_value: str) -> int:
    q = pivot.PivotQuery(
        grain="segment",
        dimensions=["op_airline_id"],
        measures=["seats"],
        time_from=T12_FROM,
        time_to=T12_TO,
        filters=[(filter_key, [filter_value])],
        sort="seats",
        sort_desc=True,
        limit=5000,
        grouping="operating",
    )
    sql, params = pivot.render_pivot(q, con)
    return sum(r[1] for r in con.execute(sql, params).fetchall())


def test_either_endpoint_filter_reproduces_the_committed_sea_figures(warehouse_con):
    """Catches: the OR diverging from the inclusion-exclusion it replaces.

    53,373,806 is the number endpoints.ts has committed since M4d. An origin-only
    query reads 26,710,000 and looks perfectly correct -- every row renders, only
    the totals are half. Adding the two halves without subtracting the overlap
    reads 53,386,452. All three are plausible; only one is right.
    """
    total = _seats_total(warehouse_con, "endpoint_airport_id", str(SEA_AIRPORT_ID))
    assert total == 53_373_806


def test_same_airport_rows_are_counted_once_not_twice(warehouse_con):
    """Catches: an either-filter that double-counts SEA->SEA rows.

    18 rows / 12,646 seats at SEA over the trailing 12. Counting them twice gives
    53,386,452 -- the exact figure invariants.md records for the naive two-half sum.
    """
    either_total = _seats_total(warehouse_con, "endpoint_airport_id", str(SEA_AIRPORT_ID))
    origin_total = _seats_total(warehouse_con, "origin_airport_id", str(SEA_AIRPORT_ID))
    dest_total = _seats_total(warehouse_con, "dest_airport_id", str(SEA_AIRPORT_ID))
    naive_total = origin_total + dest_total

    assert naive_total == 53_386_452
    assert naive_total - either_total == 12_646
