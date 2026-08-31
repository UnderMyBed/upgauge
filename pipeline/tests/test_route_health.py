"""mart_route_health -- the one materialised table, and the one derived-column exception.

The exception is safe because the grain has no time dimension: one row per (carrier,
undirected route) is both the finest and coarsest it gets, so there is no legitimate
GROUP BY of this table and nothing an AVG() could corrupt.
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.tests.test_marts import _warehouse

# ---------------------------------------------------------------------------------------------
# THE ADVERSARIAL WAREHOUSE, and why the committed fixture is not enough.
#
# `_warehouse()` is a single 2015 sample, so its mart is exactly ONE row whose prior window is
# empty -- every axis NULL at once. That shape cannot distinguish the four NULL guards from each
# other: delete any ONE of them and the other three still return NULL, the sum is still NULL, and
# every test stays green. Both `least`/`greatest` NULL-safety tests were near-vacuous on it, and
# `test_the_completion_cap_is_null_safe` was FULLY vacuous -- the fixture's one row has a
# non-NULL completion_factor, so a bare `least(completion_factor, 1.5)` leaked nothing to find.
#
# This builds a second warehouse by writing extra Parquet into the same Hive tree, so the rows go
# through the REAL normalize output schema, the REAL fct_segment_month view, the REAL
# fct_route_month rollup and the REAL mart SQL. Four carrier-route pairs, in 2014 (which becomes
# p12) and 2015 (t12):
#
#   P1, P2  fully populated CONTROLS, with DIFFERENT values on every axis. They are not padding:
#           every z-score is `stddev_samp(...) OVER ()`, which is NULL for a single value and 0
#           for identical ones -- either way `nullif(stddev, 0)` makes the whole axis NULL and
#           the fixture goes back to proving nothing. Two distinct scored rows per axis is the
#           minimum that makes any of these tests able to fail.
#   N       t12_departures_scheduled = 0, everything else known -> completion_factor alone NULL.
#   G       p12_departures_performed = 0 with p12 seats filed -> gauge_p12 and the frequency
#           ratio alone NULL (lf_p12 is still computable from seats and passengers).
#   L       no t12 passengers total -> lf_t12, and so lf_delta, alone NULL.
#   S       60 departures over 12 months flown. Clears a flat `>= 30` and fails the rate, which
#           is the ONLY shape that tells the two forms apart -- see the floor test below.
#
# WHAT THIS CANNOT ISOLATE, stated so nobody hunts for it: z_gauge and z_freq separately from
# each other. gauge_p12 and the frequency ratio share p12_departures_performed as their
# denominator, so nulling one nulls both; they are killable as a PAIR and the test says so
# rather than claiming more.
#
# z_lf IS isolable, via pair L, and an earlier revision of this comment claimed otherwise on a
# reason that was wrong twice over: lf_delta nulls when a PASSENGERS total nulls, not only a
# seats total, and the appeal to `zero_seats` did not apply here at all -- this helper writes
# Parquet straight into the Hive tree with `is_quarantined = FALSE`, so
# normalize_t100_segment.sql never runs over these rows and no quarantine rule constrains what
# they can encode.
_ADVERSARIAL = """
COPY (
    WITH m(idx) AS (SELECT * FROM generate_series(1, 12)),
    spec(airline, code, lo, hi, yr, sched, perf, seats, pax) AS (VALUES
        -- P1 control
        (99991, 'Z1', 10001, 10002, 2014, 60.0, 60.0, 6000.0, 3000.0),
        (99991, 'Z1', 10001, 10002, 2015, 60.0, 60.0, 6600.0, 3960.0),
        -- P2 control, different on every axis
        (99992, 'Z2', 10003, 10004, 2014, 60.0, 60.0, 6000.0, 3000.0),
        (99992, 'Z2', 10003, 10004, 2015, 73.0, 66.0, 7920.0, 5544.0),
        -- N: no filed schedule in t12 -> completion_factor alone is NULL
        (99993, 'Z3', 10005, 10006, 2014, 60.0, 60.0, 6000.0, 3000.0),
        (99993, 'Z3', 10005, 10006, 2015,  0.0, 60.0, 6600.0, 3300.0),
        -- G: filed a p12 schedule and flew none of it -> gauge and frequency alone are NULL
        (99994, 'Z4', 10007, 10008, 2014, 60.0,  0.0, 6000.0, 3000.0),
        (99994, 'Z4', 10007, 10008, 2015, 60.0, 60.0, 6600.0, 3300.0),
        -- L: carried no passengers total in t12 -> lf_delta alone is NULL
        (99995, 'Z5', 10009, 10010, 2014, 60.0, 60.0, 6000.0, 3000.0),
        (99995, 'Z5', 10009, 10010, 2015, 60.0, 60.0, 6600.0,   NULL),
        -- S: 60 departures over 12 months FLOWN = 5 a month. Clears a flat 30, fails the rate.
        (99996, 'Z6', 10011, 10012, 2015,  5.0,  5.0,  500.0,  250.0)
    )
    SELECT
        spec.yr || '-' || lpad(m.idx::VARCHAR, 2, '0')          AS year_month,
        spec.yr::BIGINT                                          AS year,
        (((m.idx - 1) / 3) + 1)::TINYINT                         AS quarter,
        m.idx::TINYINT                                           AS month,
        spec.airline::INTEGER                                    AS op_airline_id,
        spec.code                                                AS op_carrier_code,
        1::TINYINT                                               AS bts_carrier_group,
        spec.lo::INTEGER                                         AS origin_airport_id,
        (spec.lo * 100)::INTEGER                                 AS origin_airport_seq_id,
        (spec.lo + 20000)::INTEGER                               AS origin_city_market_id,
        'AA' || spec.lo::VARCHAR                                 AS origin_code,
        'ZZ'                                                     AS origin_state,
        spec.hi::INTEGER                                         AS dest_airport_id,
        (spec.hi * 100)::INTEGER                                 AS dest_airport_seq_id,
        (spec.hi + 20000)::INTEGER                               AS dest_city_market_id,
        'BB' || spec.hi::VARCHAR                                 AS dest_code,
        'ZZ'                                                     AS dest_state,
        spec.lo::INTEGER                                         AS route_key_low,
        spec.hi::INTEGER                                         AS route_key_high,
        '001'                                                    AS aircraft_type,
        6::SMALLINT                                              AS aircraft_group,
        1::TINYINT                                               AS aircraft_config,
        'F'                                                      AS service_class,
        3::SMALLINT                                              AS distance_group,
        spec.sched::DOUBLE                                       AS departures_scheduled,
        spec.perf::DOUBLE                                        AS departures_performed,
        spec.seats::DOUBLE                                       AS seats,
        spec.pax::DOUBLE                                         AS passengers,
        0.0::DOUBLE AS freight, 0.0::DOUBLE AS mail, 0.0::DOUBLE AS payload,
        500.0::DOUBLE AS distance, 100.0::DOUBLE AS air_time,
        120.0::DOUBLE AS ramp_to_ramp_time,
        DATE '2026-07-29'                                        AS download_date,
        NULL::VARCHAR                                            AS quarantine_reason,
        FALSE                                                    AS is_quarantined
    FROM spec CROSS JOIN m
    WHERE spec.yr = {year}
) TO '{path}' (FORMAT PARQUET)
"""


def _adversarial_warehouse(tmp_path):
    """The committed fixture plus four hand-built carrier-route pairs (see the block above)."""
    parquet = _warehouse(tmp_path)
    writer = duckdb.connect()
    try:
        for year in (2014, 2015):
            target = parquet / "t100_segment" / f"year={year}"
            target.mkdir(parents=True, exist_ok=True)
            writer.execute(
                _ADVERSARIAL.format(year=year, path=(target / "adversarial.parquet").as_posix())
            )
    finally:
        writer.close()
    return parquet


@pytest.fixture
def adversarial_con(tmp_path):
    db = tmp_path / "adversarial.duckdb"
    build_database(_adversarial_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


@pytest.fixture
def con(tmp_path):
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    return duckdb.connect(str(db))


def test_it_is_a_table_not_a_view(con):
    kind = con.execute(
        "SELECT table_type FROM information_schema.tables WHERE table_name='mart_route_health'"
    ).fetchone()[0]
    assert kind == "BASE TABLE"


def test_grain_is_undirected_and_unique(con):
    dupes = con.execute("""
        SELECT count(*) FROM (
            SELECT op_airline_id, route_key_low, route_key_high
            FROM mart_route_health GROUP BY 1, 2, 3 HAVING count(*) > 1
        )
    """).fetchone()[0]
    assert dupes == 0


def test_route_key_is_normalised(con):
    bad = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE route_key_low > route_key_high"
    ).fetchone()[0]
    assert bad == 0


def test_a_route_with_no_prior_window_gets_null_deltas(con):
    """THE trap. A brand-new route is not a route that improved infinitely -- if the prior
    window is empty the delta is unknown, not enormous."""
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE p12_months_present = 0
          AND (lf_delta IS NOT NULL OR capacity_delta IS NOT NULL
               OR gauge_delta IS NOT NULL OR frequency_delta IS NOT NULL)
    """).fetchone()[0]
    assert bad == 0


def test_new_routes_are_not_filtered_out(con):
    """A carrier-route pair present in the trailing window but absent from the prior one must
    survive as a row -- it is the Route Birth Tracker's input. Only its deltas are unknown.

    Asserted against fct_route_month rather than as `count >= 0`, which cannot fail.

    THE REFERENCE MODEL BELOW IS THE MART'S ADMISSION GATE, RE-DERIVED, and it has to track it.
    Until #148 it read `sum(departures_performed) >= 30` -- the flat trailing-12 predicate the
    rate floor replaced. Left that way it was worse than stale: its `expected` came to 606 where
    the mart holds 297, it stayed green only because the CI fixture's mart is a single row, and
    under a mutant that reverted the gate to `>= 30` it would have gone green and CERTIFIED the
    reverted rule. A reference model that survives the bug it is modelling is an anti-guard.
    """
    # Scalar subqueries, not a CROSS JOIN + any_value(): DuckDB's binder rejects an
    # aggregate (any_value) inside another aggregate's FILTER clause ("aggregate function
    # calls cannot be nested"). A scalar subquery evaluates to a constant before
    # aggregation runs, which sidesteps that restriction while asserting the exact same
    # thing -- membership judged against mart_route_health's own global window.
    expected = con.execute("""
        WITH w AS (SELECT DISTINCT t12_start_month, t12_end_month, p12_start_month,
                                   p12_end_month FROM mart_route_health)
        SELECT count(*) FROM (
            SELECT r.op_airline_id, r.route_key_low, r.route_key_high
            FROM fct_route_month r
            GROUP BY 1, 2, 3
            HAVING count(DISTINCT r.year_month) FILTER (
                       WHERE r.year_month BETWEEN (SELECT t12_start_month FROM w)
                                              AND (SELECT t12_end_month FROM w)
                         AND r.departures_performed > 0) > 0
               AND sum(r.departures_performed) FILTER (
                       WHERE r.year_month BETWEEN (SELECT t12_start_month FROM w)
                                              AND (SELECT t12_end_month FROM w))
                   >= 30 * count(DISTINCT r.year_month) FILTER (
                       WHERE r.year_month BETWEEN (SELECT t12_start_month FROM w)
                                              AND (SELECT t12_end_month FROM w)
                         AND r.departures_performed > 0)
               AND count(DISTINCT r.year_month) FILTER (
                       WHERE r.year_month BETWEEN (SELECT p12_start_month FROM w)
                                              AND (SELECT p12_end_month FROM w)) = 0
        )
    """).fetchone()[0]
    actual = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE p12_months_present = 0"
    ).fetchone()[0]
    assert actual == expected


def test_the_mart_gate_uses_the_floor_declared_in_floor_ts():
    """THE FLOOR IS DECLARED ONCE, and until now that was a claim rather than a fact.

    `app/src/lib/floor.ts` exports `DEPARTURE_FLOOR = 30`, docs/data/model.md says the rule "is
    declared once" there, and the mart's gate carried an independent literal `30` bound to it by
    nothing. That is precisely #134's shape: two declarations of one rule, in two languages,
    where editing either moves neither -- and #134 cost this repo a floor that meant three
    different things in three files. Correcting the doc to admit two declarations would have
    recorded the defect instead of closing it, so this binds them.

    Text, not execution, because the two live in different languages and there is no build step
    that could share a constant between them. The failure message says which side to change,
    since editing the SQL to match a typo'd constant is the wrong repair.
    """
    root = Path(__file__).parents[2]
    floor_ts = (root / "app" / "src" / "lib" / "floor.ts").read_text()
    declared = re.search(r"export const DEPARTURE_FLOOR = (\d+);", floor_ts)
    assert declared, "DEPARTURE_FLOOR is not declared in app/src/lib/floor.ts in the expected form"

    mart = (root / "sql" / "02_marts" / "200_mart_route_health.sql").read_text()
    gate = re.search(r"AND t12_departures_performed >= (\d+) \* t12_months_flown", mart)
    assert gate, "the mart's rate gate is not in the expected form -- re-derive this pin"
    assert gate.group(1) == declared.group(1), (
        f"the mart floors at {gate.group(1)} departures per month flown while "
        f"app/src/lib/floor.ts declares {declared.group(1)}. floor.ts is THE declaration "
        f"(docs/data/model.md); change the SQL to match it, not the other way round."
    )


def test_the_floor_is_a_rate_over_the_months_that_flew(con):
    """The floor is 30 departures per month FLOWN (#148, app/src/lib/floor.ts), never a
    trailing-12 total. This replaces an assertion on `t12_departures_performed < 30`, which
    survives the rate form unchanged -- 30 * months_flown is >= 30 for every admitted row, so
    that test could not fail for the reason its name claimed and was deletable-green.
    """
    bad = con.execute(
        "SELECT count(*) FROM mart_route_health "
        "WHERE t12_departures_performed < 30 * t12_months_flown"
    ).fetchone()[0]
    assert bad == 0


def test_a_carrier_route_that_filed_and_never_flew_is_not_admitted(con):
    """`t12_departures_performed >= 30 * t12_months_flown` is TRUE for a route that never
    flew: months_flown is 0, so the comparison reads `0 >= 0`. Without the explicit
    `t12_months_flown > 0` arm the rate floor therefore admits the sparsest row it is possible
    to file -- one that filed a schedule and performed nothing -- while looking like it
    excludes it. That is 7 extra rows on this fixture and 7 on the real warehouse.

    floor.ts:77 rules the same case the same way: `activeMonths <= 0` is BELOW floor, not a
    division to be skipped.

    The second assertion is the anti-vacuity control. If no carrier-route in the window had
    filed without flying, the first would pass under either form and prove nothing.
    """
    admitted = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE t12_months_flown = 0"
    ).fetchone()[0]
    assert admitted == 0, (
        "a carrier-route that filed and never flew is in the scored universe -- the rate "
        "floor is missing its `t12_months_flown > 0` arm and read `0 >= 0` as clearing it"
    )

    never_flew = con.execute("""
        WITH w AS (SELECT DISTINCT t12_start_month AS s, t12_end_month AS e
                   FROM mart_route_health)
        SELECT count(*) FROM (
            SELECT r.op_airline_id
            FROM fct_route_month r, w
            WHERE r.year_month BETWEEN w.s AND w.e
            GROUP BY r.op_airline_id, r.route_key_low, r.route_key_high
            HAVING count(DISTINCT r.year_month)
                       FILTER (WHERE r.departures_performed > 0) = 0
               AND sum(r.departures_performed) = 0)
    """).fetchone()[0]
    assert never_flew > 0, (
        "this warehouse has no filed-but-never-flown carrier-route, so the assertion above "
        "is vacuous -- it would pass with the guard deleted"
    )


def test_additive_sums_are_carried_alongside_the_derived_columns(con):
    """features.md requires the components be shown, not just the score."""
    cols = {r[0] for r in con.execute("DESCRIBE mart_route_health").fetchall()}
    assert {
        "t12_seats",
        "t12_passengers",
        "t12_departures_performed",
        "t12_departures_scheduled",
        "t12_months_present",
        "p12_seats",
        "p12_passengers",
        "p12_departures_performed",
        "p12_departures_scheduled",
        "p12_months_present",
    } <= cols


def test_load_factors_are_in_range(con):
    bad = con.execute(
        "SELECT count(*) FROM mart_route_health "
        "WHERE lf_t12 IS NOT NULL AND (lf_t12 < 0 OR lf_t12 > 1.0)"
    ).fetchone()[0]
    assert bad == 0


def test_lf_delta_equals_the_difference_of_the_two_ratios(con):
    """Guards against the delta being computed from averaged ratios instead of from
    summed numerators and denominators."""
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE lf_delta IS NOT NULL
          AND abs(lf_delta - (
                t12_passengers / nullif(t12_seats, 0)
              - p12_passengers / nullif(p12_seats, 0))) > 1e-9
    """).fetchone()[0]
    assert bad == 0


def test_completion_factor_is_performed_over_scheduled(con):
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE completion_factor IS NOT NULL
          AND abs(completion_factor
                  - t12_departures_performed / nullif(t12_departures_scheduled, 0)) > 1e-9
    """).fetchone()[0]
    assert bad == 0


def test_windows_are_global_and_do_not_overlap(con):
    row = con.execute(
        "SELECT DISTINCT t12_start_month, t12_end_month, p12_start_month, p12_end_month "
        "FROM mart_route_health"
    ).fetchall()
    if not row:
        pytest.skip(
            "fixture has no carrier-route pair clearing the departure rate floor; "
            "window ordering is verified against real 2015-2017 data in the task's manual step"
        )
    assert len(row) == 1, "the window must be global, not per-route"
    t12s, t12e, p12s, p12e = row[0]
    assert p12s < p12e < t12s <= t12e


def test_health_score_is_null_exactly_when_a_component_is_unknown(con):
    """Fix round 1: the original version of this test checked parity against `lf_delta`
    alone, which is FALSE on real data -- 76 of the 373 UNSCORED carrier-route pairs have a
    fully-populated prior window (so lf_delta, gauge_delta, capacity_delta and frequency_delta
    are all known)
    but `completion_factor` is NULL anyway, because they filed zero scheduled departures
    against real performed ones (on-demand/charter carriers). `lf_delta`-only parity holds
    on the small fixture purely because its single surviving row happens to have every
    component NULL at once -- it can't produce a route with a populated prior window AND
    completion_factor NULL.

    The composite is FOUR axes, not five: M6 removed capacity_delta from the score, because
    in log space it is exactly frequency + gauge (verified to 1.33e-15 over all 5,314 finite
    rows -- docs/data/model.md), so scoring it scored those two a second time. It keeps its
    column and stays on the page; it is the composite it has no place in.

    The predicate below still names all FIVE displayed components, and that is deliberate,
    not a leftover: capacity_delta is not scored, but it is NULL under the same
    data-availability conditions as the axes that are (p12_months_present = 0, or a zero p12
    denominator), so including it is redundant-but-true on the real warehouse and states the
    invariant the page actually depends on -- a row missing ANY displayed component is
    unscored, never partially scored. Synthesising a score from a subset of what it shows
    would be exactly the over-engineering features.md's "components are the insight, score is
    only a sort key" forbids."""
    bad = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE (health_score IS NULL) <> (
            lf_delta IS NULL OR gauge_delta IS NULL OR capacity_delta IS NULL
            OR frequency_delta IS NULL OR completion_factor IS NULL
        )
    """).fetchone()[0]
    assert bad == 0


def test_health_score_is_bounded_by_the_clamp(con):
    """Each axis is clamped to +/-3 and weighted 0.25, so |health_score| <= 3.0 by
    construction. Without the clamp a nine-seat aircraft's log gauge ratio reaches z = -18.91
    on the real warehouse (VD CPX-VQS) and Death Watch fills with bush operators."""
    worst = con.execute(
        "SELECT max(abs(health_score)) FROM mart_route_health WHERE health_score IS NOT NULL"
    ).fetchone()[0]
    assert worst is None or worst <= 3.0


def test_the_completion_cap_is_null_safe(adversarial_con):
    """DuckDB's least() IGNORES NULLs: least(NULL, 1.5) returns 1.5, not NULL. Written as a
    bare least(), the cap fabricates a 1.5 completion rate for every carrier-route pair that
    filed no schedule at all -- 89 of them on the real warehouse -- and each then gets a
    health_score it has no basis for.

    RUNS ON THE ADVERSARIAL WAREHOUSE BECAUSE IT HAS TO. On the committed fixture this test was
    fully vacuous: that mart's one row has a non-NULL completion_factor, so the bare-least
    mutant leaked nothing and the assertion below compared 0 to 0 under both implementations.
    Pair N (99993) files real departures against a zero t12 schedule, which is the only shape
    that makes the fabrication observable.

    The second and third assertions are the anti-vacuity controls, and they fail for different
    reasons: no NULL-completion row at all, versus a population nothing could score anyway."""
    leaked = adversarial_con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE completion_factor IS NULL AND health_score IS NOT NULL
    """).fetchone()[0]
    assert leaked == 0, "a pair with no filed schedule was scored -- least() fabricated its rate"

    unknown = adversarial_con.execute(
        "SELECT count(*) FROM mart_route_health WHERE completion_factor IS NULL"
    ).fetchone()[0]
    assert unknown > 0, "no NULL completion_factor in this warehouse -- the assertion is vacuous"

    scored = adversarial_con.execute(
        "SELECT count(health_score) FROM mart_route_health"
    ).fetchone()[0]
    assert scored >= 2, "nothing here is scoreable, so leaking a score could not show up"


def test_the_completion_clamp_alone_is_null_safe(adversarial_con):
    """WHICH clamp refuses the row, not merely that something did. Every z-score is guarded by
    its own `CASE WHEN z IS NULL THEN NULL ELSE greatest(least(z, 3), -3) END`; delete one and
    a bare clamp turns that axis's NULL into 3, because greatest(least(NULL,3),-3) is 3.

    Pair N is the discriminator: completion_factor is NULL while lf_delta, gauge_delta and
    frequency_delta are all KNOWN, so it is unscored for exactly one reason. Remove the
    z_completion CASE alone and N is scored -- this test, and only this one, goes red.

    The component assertions are the test, not setup. Without them a row that happened to be
    NULL on several axes would satisfy the score check while proving nothing about which guard
    did the work."""
    row = adversarial_con.execute("""
        SELECT lf_delta, gauge_delta, frequency_delta, completion_factor, health_score
        FROM mart_route_health WHERE op_airline_id = 99993
    """).fetchone()
    assert row is not None, "the completion-only-NULL pair is missing from the mart"
    lf_delta, gauge_delta, frequency_delta, completion_factor, health_score = row
    assert lf_delta is not None
    assert gauge_delta is not None
    assert frequency_delta is not None
    assert completion_factor is None, "this pair must be NULL on completion and nothing else"
    assert health_score is None, "the z_completion clamp let a NULL axis through as 3"


def test_the_load_factor_clamp_alone_is_null_safe(adversarial_con):
    """The z_lf isolation, which an earlier revision of this module said was unreachable.

    Pair L carries no t12 passengers total, so lf_t12 -- and with it lf_delta -- is NULL while
    gauge, frequency and completion are all known. Remove the z_lf CASE alone and L is scored:
    this test, and only this one, goes red.

    The wrong reason is worth naming because it is the kind that survives review: lf_delta was
    said to null only when a SEATS total does, guarded by `zero_seats`. It also nulls on a
    passengers total, and `zero_seats` never runs on this fixture at all -- the helper writes
    Parquet directly, so nothing in normalize_t100_segment.sql constrains these rows."""
    row = adversarial_con.execute("""
        SELECT lf_delta, gauge_delta, frequency_delta, completion_factor, health_score
        FROM mart_route_health WHERE op_airline_id = 99995
    """).fetchone()
    assert row is not None, "the lf-only-NULL pair is missing from the mart"
    lf_delta, gauge_delta, frequency_delta, completion_factor, health_score = row
    assert lf_delta is None, "this pair must be NULL on lf_delta and nothing else"
    assert gauge_delta is not None
    assert frequency_delta is not None
    assert completion_factor is not None
    assert health_score is None, "the z_lf clamp let a NULL axis through as 3"


def test_a_pair_below_the_monthly_rate_is_rejected_though_it_clears_a_flat_thirty(
    adversarial_con,
):
    """THE test the fixture could not previously carry, and the reason the floor had no
    pytest-level guard at all.

    The committed fixture admits exactly one row, and it flew 1 month -- so `30 * 1 == 30` and
    the flat and rate forms are NUMERICALLY IDENTICAL on the only row that exists. Reverting the
    mart's gate to a flat `>= 30` left 21 of 22 tests green, and the one that caught it caught it
    by matching TEXT, not behaviour: a mutant written as

        WHERE t12_months_flown > 0 AND t12_departures_performed >= 30 * t12_months_flown
           OR t12_departures_performed >= 30

    restores #134's exact leniency defect through operator precedence while preserving the
    substring the textual binding matches, and passed everything.

    Pair S is the discriminator: 60 departures over 12 months FLOWN, i.e. 5 a month. It clears a
    flat 30 and fails the rate, so it is admitted by the old form, by the `OR` mutant, and by
    anything else that stops dividing -- and rejected by the rule as written. The two assertions
    after the membership check are what make that concrete rather than asserted: without them a
    pair that failed BOTH forms would satisfy this test while proving nothing."""
    admitted = adversarial_con.execute(
        "SELECT count(*) FROM mart_route_health WHERE op_airline_id = 99996"
    ).fetchone()[0]
    assert admitted == 0, (
        "a carrier-route pair flying 5 departures a month is in the scored universe -- the gate "
        "is comparing a trailing-12 sum against a monthly floor again"
    )

    departures, months_flown = adversarial_con.execute("""
        WITH w AS (SELECT DISTINCT t12_start_month AS s, t12_end_month AS e
                   FROM mart_route_health)
        SELECT sum(r.departures_performed),
               count(DISTINCT r.year_month) FILTER (WHERE r.departures_performed > 0)
        FROM fct_route_month r, w
        WHERE r.op_airline_id = 99996 AND r.year_month BETWEEN w.s AND w.e
    """).fetchone()
    assert departures >= 30, "S no longer clears a flat 30, so it cannot tell the forms apart"
    assert departures < 30 * months_flown, "S no longer fails the rate, so this proves nothing"


def test_the_gauge_and_frequency_clamps_are_null_safe(adversarial_con):
    """The other reachable isolation, and it is a PAIR rather than two singles -- stated because
    the limit is structural, not an omission. gauge_p12 and the frequency ratio share
    p12_departures_performed as their denominator, so a window that flew nothing nulls both at
    once and neither can be isolated from the other. lf_delta cannot be isolated at all: it only
    goes NULL when a seats total does, and `zero_seats` (normalize_t100_segment.sql) quarantines
    every row with seats = 0 and departures > 0, so a flown-but-seatless window never reaches
    the mart.

    Pair G filed a p12 schedule and performed none of it, with seats and passengers on file --
    so lf_p12 is computable and completion_factor is known, while gauge and frequency are not.
    Removing BOTH clamps' CASEs scores it and reddens this test; removing either one alone
    leaves the other returning NULL and the sum NULL, which is exactly why this asserts the
    pair."""
    row = adversarial_con.execute("""
        SELECT lf_delta, gauge_delta, frequency_delta, completion_factor, health_score
        FROM mart_route_health WHERE op_airline_id = 99994
    """).fetchone()
    assert row is not None, "the gauge/frequency-NULL pair is missing from the mart"
    lf_delta, gauge_delta, frequency_delta, completion_factor, health_score = row
    assert lf_delta is not None
    assert completion_factor is not None
    assert gauge_delta is None and frequency_delta is None
    assert health_score is None, "the gauge/frequency clamps let NULL axes through as 3"


def test_the_z_clamp_is_null_safe(adversarial_con):
    """The all-axes-NULL case: a pair with no prior window at all, whose whole point is a NULL
    score. A bare clamp scores it. This is the guard the committed fixture could already
    exercise -- the two tests above are what it could not."""
    leaked = adversarial_con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE p12_months_present = 0 AND health_score IS NOT NULL
    """).fetchone()[0]
    assert leaked == 0
    present = adversarial_con.execute(
        "SELECT count(*) FROM mart_route_health WHERE p12_months_present = 0"
    ).fetchone()[0]
    assert present > 0, "no prior-windowless pair here -- the assertion above is vacuous"


def test_capacity_is_carried_but_not_scored(con):
    """capacity_delta stays a DISPLAYED component -- 'capacity down 81%' is the most legible
    cell on a Death Watch row -- but in log space it is EXACTLY frequency + gauge, so scoring
    it scores those twice. The identity below is what licenses the exclusion."""
    cols = [r[0] for r in con.execute("DESCRIBE mart_route_health").fetchall()]
    assert "capacity_delta" in cols
    residual = con.execute("""
        SELECT max(abs( ln(t12_seats / p12_seats)
                      - ln(t12_departures_performed / p12_departures_performed)
                      - ln(gauge_t12 / gauge_p12) ))
        FROM mart_route_health
        WHERE p12_seats > 0 AND t12_seats > 0
          AND p12_departures_performed > 0 AND t12_departures_performed > 0
    """).fetchone()[0]
    assert residual is None or residual < 1e-12


def test_quarantined_rows_are_carried_for_the_trailing_window(con):
    """CLAUDE.md makes surfacing the quarantine count a hard rule on every data view. The mart
    did not carry it forward, so /watch could not honour that without this column."""
    cols = [r[0] for r in con.execute("DESCRIBE mart_route_health").fetchall()]
    assert "t12_quarantined_rows" in cols
    negative = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE t12_quarantined_rows < 0"
    ).fetchone()[0]
    assert negative == 0


def test_quarantined_rows_is_bigint_not_hugeint(con):
    """DuckDB promotes sum() over a BIGINT column to HUGEINT unless explicitly cast back down.
    The brief's interface spec is `t12_quarantined_rows BIGINT`; Task 6 reads this column
    through @duckdb/node-api into TypeScript, and this repo has a documented history of DuckDB
    runtime types surfacing differently than expected -- so the type itself is the invariant,
    not just the column's presence and sign (which the previous test already covers and which
    passes under either type)."""
    dtype = con.execute("""
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'mart_route_health' AND column_name = 't12_quarantined_rows'
    """).fetchone()[0]
    assert dtype == "BIGINT"
