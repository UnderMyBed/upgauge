"""Invariants M4a's resolution layer depends on. Measured 2026-07-30 against the full
2015-2026 window; see docs/data/invariants.md for the numbers and what each one protects."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

DB = Path("upgauge.duckdb")
LOOKUP_SQL = Path("sql/03_queries/lookup_airport_by_code.sql")
pytestmark = pytest.mark.skipif(not DB.exists(), reason="no built catalog; run `make build`")

# NOTE for the implementer and reviewer: this skip is legitimate (the catalog is a build
# artifact, not checked in) -- but M1 shipped 12 real-data tests that skipped for FOUR
# MILESTONES because their guard condition was permanently false, and nobody noticed. So
# after running the suite you MUST confirm from pytest's output that these tests report as
# PASSED, not SKIPPED, and record the count in your report. A skipped guard is a dark guard.


@pytest.fixture(scope="module")
def con():
    return duckdb.connect(str(DB), read_only=True)


def _lookup_over_every_code() -> str:
    """The SHIPPED reverse-lookup statement, exercised over the whole `is_latest` roster
    instead of one bound pair.

    `{{IDS}}` is normally substituted with a parenthesised list of bound parameter NAMES
    (app/src/lib/resolve.ts); a parenthesised sub-SELECT is equally valid there and is what
    turns a two-code lookup into an exhaustive one. Reading the real file rather than a copy
    is the point: a copy would keep passing after someone edits the file."""
    statement = LOOKUP_SQL.read_text()
    assert statement.count("{{IDS}}") == 1, "the substitution token moved or was duplicated"
    return statement.replace("{{IDS}}", "(SELECT upper(code) FROM dim_airport WHERE is_latest)")


def test_reverse_lookup_selects_exactly_the_fact_present_current_airports(con):
    """The reverse lookup's fact-presence filter must select exactly the airports the
    correlated-EXISTS form selects.

    That form is what shipped first, and it was replaced (fix wave 3) by a hash semi-join
    against `origin_airport_id UNION dest_airport_id` because the correlated version re-scans
    3.36 M fact rows per candidate: 43-51 ms against 17 ms, on a query `proxy.ts` now runs on
    every `/route/*` request. The two are equivalent by construction --
    `EXISTS(f.origin = x OR f.dest = x)` is the definition of membership in that union, for
    NULLs too (a NULL in an `IN` list yields NULL, which `WHERE` drops exactly as `EXISTS`'s
    FALSE does) -- but "equivalent by construction" is an argument, and this is the
    measurement. It fails for ANY future rewrite of that predicate that changes which
    airports resolve, which is the whole risk of touching it.

    The reference set is written in the OTHER form deliberately: comparing the file against a
    copy of its own predicate would be a tautology."""
    only_shipped, only_reference, reference_n = con.execute(f"""
      WITH shipped AS ({_lookup_over_every_code()}),
           reference AS (
             SELECT airport_id AS id FROM dim_airport
             WHERE is_latest AND EXISTS (
                 SELECT 1 FROM fct_segment_month f
                 WHERE f.origin_airport_id = dim_airport.airport_id
                    OR f.dest_airport_id = dim_airport.airport_id))
      SELECT (SELECT count(*) FROM (SELECT id FROM shipped EXCEPT SELECT id FROM reference)),
             (SELECT count(*) FROM (SELECT id FROM reference EXCEPT SELECT id FROM shipped)),
             (SELECT count(*) FROM reference)
    """).fetchone()
    # Guards the vacuous pass: a predicate that filters EVERYTHING out also has no collisions
    # and no rows the reference lacks. 1,045 airports carry T-100 Segment traffic in-window.
    assert reference_n > 1000
    assert (only_shipped, only_reference) == (0, 0)


def test_reverse_lookup_returns_at_most_one_airport_per_code(con):
    """code -> airport_id must be a function, or `/route/AUS-SEA` silently resolves AUS to
    Robert Mueller Municipal (closed 1999, zero traffic rows) under a DATA AS OF badge.

    `WHERE is_latest` alone does not give this -- it is scoped per `airport_id`'s own seq
    chain, not per code -- which the second half measures rather than asserts from memory:
    strip the fact-presence filter and the collisions come back (36 at the time of writing).
    docs/data/invariants.md § Entity resolution holds the full accounting."""
    colliding = con.execute(f"""
      SELECT count(*) FROM (
        SELECT code FROM ({_lookup_over_every_code()}) GROUP BY 1 HAVING count(DISTINCT id) > 1)
    """).fetchone()[0]
    assert colliding == 0

    without_the_filter = con.execute("""
      SELECT count(*) FROM (
        SELECT upper(code) FROM dim_airport WHERE is_latest
        GROUP BY 1 HAVING count(DISTINCT airport_id) > 1)
    """).fetchone()[0]
    assert without_the_filter > 0


def test_dim_airport_has_exactly_one_latest_row_per_airport_id(con):
    """The is_latest filter is load-bearing: 5,033 airport_ids have more than one seq_id
    row, so a resolver that omits it fans out and MULTIPLIES result rows -- a wrong total
    under a DATA AS OF badge."""
    wrong = con.execute(
        "SELECT count(*) FROM (SELECT airport_id FROM dim_airport WHERE is_latest "
        "GROUP BY 1 HAVING count(*) <> 1)"
    ).fetchone()[0]
    assert wrong == 0

    none_latest = con.execute(
        "SELECT count(*) FROM (SELECT airport_id FROM dim_airport GROUP BY 1 "
        "HAVING sum(CASE WHEN is_latest THEN 1 ELSE 0 END) = 0)"
    ).fetchone()[0]
    assert none_latest == 0


def test_no_fact_id_is_missing_from_its_dimension(con):
    """An unresolvable id degrades to the raw id rather than erroring, but zero orphans is
    the state today and a regression means the warehouse build broke, not the display."""
    carrier = con.execute(
        "SELECT count(DISTINCT f.op_airline_id) FROM fct_segment_month f "
        "LEFT JOIN dim_carrier d ON d.airline_id = f.op_airline_id WHERE d.airline_id IS NULL"
    ).fetchone()[0]
    assert carrier == 0

    airport = con.execute(
        "SELECT count(*) FROM (SELECT DISTINCT id FROM ("
        "  SELECT origin_airport_id AS id FROM fct_segment_month"
        "  UNION SELECT dest_airport_id FROM fct_segment_month) x "
        "WHERE NOT EXISTS (SELECT 1 FROM dim_airport a WHERE a.airport_id = x.id AND a.is_latest))"
    ).fetchone()[0]
    assert airport == 0

    aircraft = con.execute(
        "SELECT count(DISTINCT f.aircraft_type) FROM fct_segment_month f "
        "LEFT JOIN dim_aircraft_type d ON d.code = f.aircraft_type WHERE d.code IS NULL"
    ).fetchone()[0]
    assert aircraft == 0


def test_no_code_collisions_among_in_window_operators(con):
    """M4b will resolve /carrier/DL and /airport/SEA back to an id. carrier_code is reused
    -- 112 codes map to >1 airline_id across all of dim_carrier -- but ZERO collide among
    the 114 carriers that actually operated in-window. This guards that future capability;
    it is NOT a guard on M4a's display path, where id -> code is a function and collisions
    are irrelevant."""
    carrier = con.execute(
        "SELECT count(*) FROM (SELECT d.carrier_code FROM dim_carrier d "
        "JOIN (SELECT DISTINCT op_airline_id FROM fct_segment_month) f "
        "  ON f.op_airline_id = d.airline_id "
        "GROUP BY 1 HAVING count(DISTINCT d.airline_id) > 1)"
    ).fetchone()[0]
    assert carrier == 0

    airport = con.execute(
        "SELECT count(*) FROM (SELECT a.code FROM dim_airport a "
        "JOIN (SELECT DISTINCT origin_airport_id AS id FROM fct_segment_month "
        "      UNION SELECT DISTINCT dest_airport_id FROM fct_segment_month) f "
        "  ON f.id = a.airport_id "
        "WHERE a.is_latest GROUP BY 1 HAVING count(DISTINCT a.airport_id) > 1)"
    ).fetchone()[0]
    assert airport == 0
