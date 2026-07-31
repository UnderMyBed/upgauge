"""Invariants M4a's resolution layer depends on. Measured 2026-07-30 against the full
2015-2026 window; see docs/data/invariants.md for the numbers and what each one protects."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

DB = Path("upgauge.duckdb")
LOOKUP_SQL = Path("sql/03_queries/lookup_airport_by_code.sql")
CARRIER_LOOKUP_SQL = Path("sql/03_queries/lookup_carrier_by_code.sql")
AIRCRAFT_LOOKUP_SQL = Path("sql/03_queries/lookup_aircraft_by_name.sql")
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
    return _over_every(LOOKUP_SQL, "SELECT upper(code) FROM dim_airport WHERE is_latest")


def _over_every(sql_path: Path, roster: str) -> str:
    """The same trick, generalised for M4d's two new reverse lookups: read the SHIPPED file
    and substitute a sub-SELECT over the whole slug roster for the bound-parameter list."""
    statement = sql_path.read_text()
    assert statement.count("{{IDS}}") == 1, f"{sql_path}: token moved or was duplicated"
    return statement.replace("{{IDS}}", f"({roster})")


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


# ---------------------------------------------------------------------------------------
# M4d: the carrier and aircraft reverse lookups. Same shape as the airport ones above, and
# for the same reason -- but the aircraft one lands on a different answer, which is the point
# of measuring both rather than assuming the airport result generalises.
# ---------------------------------------------------------------------------------------


def _carrier_lookup_over_every_code() -> str:
    return _over_every(CARRIER_LOOKUP_SQL, "SELECT upper(carrier_code) FROM dim_carrier")


def _aircraft_lookup_over_every_name() -> str:
    return _over_every(
        AIRCRAFT_LOOKUP_SQL, "SELECT upper(short_name) FROM dim_aircraft_type"
    )


def test_carrier_reverse_lookup_returns_at_most_one_airline_per_code(con):
    """carrier_code -> airline_id must be a function, or /carrier/VX resolves to Aces
    Airlines -- a defunct Colombian carrier with zero filed rows -- instead of Virgin America.

    dim_carrier has no `is_latest` analogue to lean on (v0 collapses Carrier Decode to one row
    per airline_id), so the fact-presence filter is the ONLY thing making a code a key here.
    The second half measures that rather than asserting it from memory: unscoped, 112 codes
    map to more than one airline_id."""
    resolved_n, colliding = con.execute(f"""
      WITH shipped AS ({_carrier_lookup_over_every_code()})
      SELECT (SELECT count(*) FROM shipped),
             (SELECT count(*) FROM (
                SELECT code FROM shipped GROUP BY 1 HAVING count(DISTINCT id) > 1))
    """).fetchone()
    # Guards the vacuous pass: a predicate filtering EVERYTHING out also has no collisions.
    # 114 airlines filed a T-100 Segment row over 2015-2026.
    assert resolved_n == 114
    assert colliding == 0

    without_the_filter = con.execute("""
      SELECT count(*) FROM (
        SELECT upper(carrier_code) FROM dim_carrier
        GROUP BY 1 HAVING count(DISTINCT airline_id) > 1)
    """).fetchone()[0]
    assert without_the_filter > 0


def test_aircraft_reverse_lookup_collides_on_exactly_the_known_CE_180_pair(con):
    """The alarm for a NEW aircraft slug collision.

    This is where the airport result does NOT generalise, and the whole reason the fail-loud
    guard in app/src/lib/resolve.ts is the defence rather than the SQL filter. For airports,
    fact-presence takes collisions 36 -> 0. For aircraft it takes 12 -> 1: `CE-180` names code
    030 (CESSNA 180) AND code 031 (CESSNA 180A/B), both with real filed traffic, so no scoping
    resolves it and neither answer is right.

    Pinning the colliding set EXACTLY -- rather than asserting `<= 1` or excluding CE-180 --
    is deliberate. A future BTS refresh that introduces a second ambiguous short_name would
    pass any weaker assertion silently, and the resulting /aircraft/<slug> would 500 in
    production with nobody having decided that was acceptable. Failing here instead is the
    "impossible to miss" half of this milestone's collision decision."""
    colliding = con.execute(f"""
      WITH shipped AS ({_aircraft_lookup_over_every_name()})
      SELECT code, list(id ORDER BY id) FROM shipped GROUP BY 1 HAVING count(DISTINCT id) > 1
    """).fetchall()
    assert colliding == [("CE-180", ["030", "031"])]

    # Vacuity guard, and the counterpart to the carrier count above: 112 aircraft types filed
    # a row over 2015-2026, mapping to 111 distinct short names -- the difference IS CE-180.
    resolved_n, distinct_names = con.execute(f"""
      WITH shipped AS ({_aircraft_lookup_over_every_name()})
      SELECT count(*), count(DISTINCT code) FROM shipped
    """).fetchone()
    assert (resolved_n, distinct_names) == (112, 111)

    without_the_filter = con.execute("""
      SELECT count(*) FROM (
        SELECT upper(short_name) FROM dim_aircraft_type
        GROUP BY 1 HAVING count(DISTINCT code) > 1)
    """).fetchone()[0]
    assert without_the_filter == 12


def test_new_reverse_lookups_select_exactly_the_fact_present_entities(con):
    """Both new fact-presence clauses must select exactly what a correlated EXISTS selects.

    Same instrument as `test_reverse_lookup_selects_exactly_the_fact_present_current_airports`
    above, and the same risk: the clause is written as a semi-join for speed (correlated
    EXISTS measured 15 ms carrier / 23 ms aircraft against 4 ms for the shipped form), and any
    future rewrite of it must not change WHICH entities resolve. The reference set is written
    in the other form on purpose -- comparing the file against a copy of its own predicate
    would be a tautology."""
    carrier_extra, carrier_missing = con.execute(f"""
      WITH shipped AS ({_carrier_lookup_over_every_code()}),
           reference AS (
             SELECT airline_id AS id FROM dim_carrier WHERE EXISTS (
                 SELECT 1 FROM fct_segment_month f
                 WHERE f.op_airline_id = dim_carrier.airline_id))
      SELECT (SELECT count(*) FROM (SELECT id FROM shipped EXCEPT SELECT id FROM reference)),
             (SELECT count(*) FROM (SELECT id FROM reference EXCEPT SELECT id FROM shipped))
    """).fetchone()
    assert (carrier_extra, carrier_missing) == (0, 0)

    aircraft_extra, aircraft_missing = con.execute(f"""
      WITH shipped AS ({_aircraft_lookup_over_every_name()}),
           reference AS (
             SELECT code AS id FROM dim_aircraft_type WHERE EXISTS (
                 SELECT 1 FROM fct_segment_month f
                 WHERE f.aircraft_type = dim_aircraft_type.code))
      SELECT (SELECT count(*) FROM (SELECT id FROM shipped EXCEPT SELECT id FROM reference)),
             (SELECT count(*) FROM (SELECT id FROM reference EXCEPT SELECT id FROM shipped))
    """).fetchone()
    assert (aircraft_extra, aircraft_missing) == (0, 0)


def test_aircraft_short_names_survive_a_url_path_segment(con):
    """16 fact-present short names carry a `/` or a space -- `A321/LR`, `MAX 8`, `FLT/AMPH` --
    so `/aircraft/<short_name>` is not expressible as a single path segment for them.

    This is a Task 1 finding recorded where the fix has to live, not a Task 1 fix: the slug
    scheme is the entity page's decision. What this pins is the measurement that decision
    needs -- replacing `/` and ` ` with `-` is INJECTIVE over the 111 fact-present short names
    (0 collisions), so it is a safe scheme, and this test fails the day a BTS refresh makes it
    unsafe. See docs/data/invariants.md § Entity resolution."""
    awkward, slug_collisions = con.execute("""
      WITH present AS (
        SELECT DISTINCT short_name FROM dim_aircraft_type
        WHERE code IN (SELECT DISTINCT aircraft_type FROM fct_segment_month))
      SELECT (SELECT count(*) FROM present WHERE regexp_matches(short_name, '[^A-Z0-9-]')),
             (SELECT count(*) FROM (
                SELECT upper(replace(replace(short_name, '/', '-'), ' ', '-')) AS slug
                FROM present GROUP BY 1 HAVING count(*) > 1))
    """).fetchone()
    assert awkward == 16
    assert slug_collisions == 0
