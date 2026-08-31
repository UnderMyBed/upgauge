"""The composite, asserted against the real warehouse.

The synthetic fixture in test_route_health.py proves the SQL is NULL-safe and bounded. Only
the real warehouse can prove the thing the fix exists for: that all four axes actually carry
comparable weight. The shipped composite passed every structural test while one component
contributed 1.6% of its nominal 20%.

Expected counts are recorded in docs/data/model.md. If BTS amends a filing these can
legitimately move; a change here is a signal to re-read the data, not to edit the number
until it passes.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

DB = Path("upgauge.duckdb")
pytestmark = pytest.mark.skipif(not DB.exists(), reason="no built catalog; run `make build`")

# NOTE: M1 shipped 12 real-data tests that skipped for FOUR MILESTONES because their guard was
# permanently false. After running the suite you MUST confirm from pytest's output that these
# report PASSED, not SKIPPED, and record the count in your task report.


@pytest.fixture(scope="module")
def con():
    return duckdb.connect(str(DB), read_only=True)


# completion_capped mirrors 200_mart_route_health.sql's own CASE guard, not a bare least():
# DuckDB's least(NULL, 1.5) returns 1.5 (ignores NULL rather than propagating it), which
# fabricates a completion rate for the 89 carrier-route pairs with no filed schedule -- the
# same NULL trap the mart SQL's comment on `completion_capped` documents. A bare least() here
# would pollute this axis's population avg/stddev with 89 fabricated 1.5s before the outer
# `WHERE health_score IS NOT NULL` ever drops those rows (they are dropped too late --
# the window functions already ran over the polluted population). Confirmed: this guarded
# form reconstructs the stored health_score to within 1.58e-14 over every scored row;
# the unguarded form does not.
COMPLETION_CAPPED = (
    "CASE WHEN completion_factor IS NULL THEN NULL ELSE least(completion_factor,1.5) END"
)
# Factored out for line length and to keep the two z_gauge/z_freq occurrences (AXES and
# Z_COLUMNS below) textually identical.
GAUGE_LOG = "ln(nullif(gauge_t12,0)/nullif(gauge_p12,0))"
FREQ_LOG = "ln(nullif(t12_departures_performed,0)/nullif(p12_departures_performed,0))"

AXES = f"""
    SELECT
        avg(abs(greatest(least(z_lf,         3), -3))) AS lf,
        avg(abs(greatest(least(z_gauge,      3), -3))) AS gauge,
        avg(abs(greatest(least(z_freq,       3), -3))) AS freq,
        avg(abs(greatest(least(z_completion, 3), -3))) AS completion
    FROM (
        SELECT
            (lf_delta - avg(lf_delta) OVER ()) / stddev_samp(lf_delta) OVER () AS z_lf,
            ({GAUGE_LOG} - avg({GAUGE_LOG}) OVER ())
              / stddev_samp({GAUGE_LOG}) OVER () AS z_gauge,
            ({FREQ_LOG} - avg({FREQ_LOG}) OVER ())
              / stddev_samp({FREQ_LOG}) OVER () AS z_freq,
            ({COMPLETION_CAPPED} - avg({COMPLETION_CAPPED}) OVER ())
              / stddev_samp({COMPLETION_CAPPED}) OVER () AS z_completion,
            health_score
        FROM mart_route_health
    )
    WHERE health_score IS NOT NULL
"""


def test_all_four_axes_carry_comparable_weight(con):
    """Verifies a property of the DATA under this axis choice, recomputed independently from
    raw stored columns (lf_delta, gauge_t12/gauge_p12, t12_departures_performed/
    p12_departures_performed, completion_factor) -- not a property of the mart's own SQL. It
    passes identically whether sql/02_marts/200_mart_route_health.sql computes z_gauge/z_freq
    correctly or is badly broken, because it never reads those stored columns (Task 2 review
    finding). The shipped five-axis composite's components ranged from 0.575 to 0.023 mean |z|
    -- a 25.0x spread on nominally equal weights, because three were unbounded ratios whose own
    outliers inflated their own denominators; re-deriving the same computation from raw columns
    under the four-axis, logged choice shows the spread holds at 1.55x. For the guarantee that
    the MART'S OWN SQL actually implements this axis choice, see
    test_health_score_reconstructs_from_its_own_axes below."""
    lf, gauge, freq, completion = con.execute(AXES).fetchone()
    contributions = [lf, gauge, freq, completion]
    assert max(contributions) / min(contributions) <= 2.0, contributions


def test_the_three_null_reasons_keep_their_measured_sizes(con):
    """docs/product/features.md carries a standing UI requirement that a NULL health_score
    never render as 'unhealthy', because all three groups are NULL for data-availability
    reasons. The sizes are what tell us the model still holds."""
    total, scored, no_prior, no_schedule, neither = con.execute("""
        SELECT
            count(*),
            count(health_score),
            count(*) FILTER (WHERE health_score IS NULL AND p12_months_present = 0),
            count(*) FILTER (WHERE health_score IS NULL AND completion_factor IS NULL),
            count(*) FILTER (WHERE health_score IS NULL
                             AND p12_months_present <> 0 AND completion_factor IS NOT NULL)
        FROM mart_route_health
    """).fetchone()
    assert (total, scored) == (5611, 5238)
    assert (no_prior, no_schedule) == (297, 89)
    assert neither == 0  # every NULL has one of the two live reasons
    assert no_prior + no_schedule - (total - scored) == 13  # the documented overlap


Z_COLUMNS = f"""
    SELECT
        (lf_delta - avg(lf_delta) OVER ()) / stddev_samp(lf_delta) OVER () AS z_lf,
        ({GAUGE_LOG} - avg({GAUGE_LOG}) OVER ())
          / stddev_samp({GAUGE_LOG}) OVER () AS z_gauge,
        ({FREQ_LOG} - avg({FREQ_LOG}) OVER ())
          / stddev_samp({FREQ_LOG}) OVER () AS z_freq,
        ({COMPLETION_CAPPED} - avg({COMPLETION_CAPPED}) OVER ())
          / stddev_samp({COMPLETION_CAPPED}) OVER () AS z_completion,
        health_score
    FROM mart_route_health
"""


def test_the_clamp_binds_on_a_real_minority(con):
    """Same caveat as test_all_four_axes_carry_comparable_weight above: this recomputes
    clamped z-scores from raw stored columns independently of the mart's own `scored` CTE, so
    it verifies the clamp THRESHOLD's effect on the data, not that the mart's SQL applies any
    clamp at all -- it passes unchanged even if the mart's clamp is deleted entirely (Task 2
    review finding; test_health_score_reconstructs_from_its_own_axes below is the one coupled
    to the mart). 289 of 5,238 is the measured middle: a clamp that fires on zero rows would be
    decoration, one that fires on all of them would be a rank transform wearing a z-score's
    name."""
    clamped = con.execute(f"""
        SELECT count(*) FROM ({Z_COLUMNS})
        WHERE health_score IS NOT NULL
          AND (abs(z_lf) > 3 OR abs(z_gauge) > 3 OR abs(z_freq) > 3 OR abs(z_completion) > 3)
    """).fetchone()[0]
    assert clamped == 289


def test_no_axis_survives_the_clamp_unbounded(con):
    """The observed maximum |health_score| is 2.33977 against a construction bound of 3.0
    (four axes, each clamped to 3, weighted 0.25). Unclamped, VD CPX-VQS reaches z_gauge
    -18.91 on this warehouse."""
    worst = con.execute(
        "SELECT max(abs(health_score)) FROM mart_route_health WHERE health_score IS NOT NULL"
    ).fetchone()[0]
    assert worst <= 3.0
    assert worst == pytest.approx(2.33977, abs=1e-4)


def test_health_score_reconstructs_from_its_own_axes(con):
    """THE test coupled to the mart's own SQL, unlike the two above. It reads the STORED
    `health_score` column and asserts it equals the CASE-guarded, ±3-clamped, 0.25-weighted sum
    of the same four axes recomputed here from raw columns -- so it goes red if
    sql/02_marts/200_mart_route_health.sql stops matching that formula, whether the break is in
    which columns feed an axis (e.g. reverting to raw capacity_delta/frequency_delta instead of
    the logged ratios) or in whether the clamp is applied at all. Measured max |residual|
    1.58e-14 across all 5,238 scored rows -- floating-point noise, not a near-match."""
    max_residual = con.execute(f"""
        SELECT max(abs(health_score - 0.25 * (
              greatest(least(z_lf,         3), -3)
            + greatest(least(z_gauge,      3), -3)
            + greatest(least(z_freq,       3), -3)
            + greatest(least(z_completion, 3), -3)
        )))
        FROM ({Z_COLUMNS})
        WHERE health_score IS NOT NULL
    """).fetchone()[0]
    assert max_residual < 1e-9, max_residual


def test_death_watch_leads_with_routes_that_are_actually_dying(con):
    """The shipped composite's single worst route was NK BNA-CLT, whose capacity was UP 6,190%.
    Asserting 'the worst row has a negative score' would pass on that. Asserting its capacity
    moved the RIGHT WAY is what distinguishes them."""
    worst = con.execute("""
        SELECT capacity_delta, lf_delta FROM mart_route_health
        WHERE health_score IS NOT NULL AND route_key_low <> route_key_high
          AND gauge_t12 >= 50
        ORDER BY health_score ASC NULLS LAST LIMIT 1
    """).fetchone()
    capacity_delta, lf_delta = worst
    assert capacity_delta < 0, capacity_delta
    assert lf_delta < 0, lf_delta


def test_the_gauge_floor_excludes_the_bush_and_sightseeing_operators(con):
    """THE reason Empty Planes needs a floor. Without gauge_t12 >= 50 the leaderboard is
    Alaska bush freight and a Grand Canyon sightseeing operator flying 4-to-6-seat aircraft --
    GCH 1G4-BLD leads at LF 0.0000 on gauge 5.98. The preset is billed as the hook; it implies
    a mainline wasting capacity and delivers cargo runs.

    Asserting 'the top row has a low load factor' passes on the BROKEN version too. Asserting
    the top row is real airliner metal is what distinguishes them.

    Both queries mirror watch_empty_planes.sql, which since #148 carries NO departures predicate
    of its own: the mart's rate floor is the only departure floor in play and it is applied to
    the whole table before this query runs."""
    gauge, dep = con.execute("""
        SELECT gauge_t12, t12_departures_performed FROM mart_route_health
        WHERE route_key_low <> route_key_high
          AND lf_t12 IS NOT NULL
          AND gauge_t12 >= 50
        ORDER BY lf_t12 ASC LIMIT 1
    """).fetchone()
    assert gauge >= 50, gauge
    assert dep >= 30, dep

    unfloored = con.execute("""
        SELECT gauge_t12 FROM mart_route_health
        WHERE route_key_low <> route_key_high
          AND lf_t12 IS NOT NULL
        ORDER BY lf_t12 ASC LIMIT 1
    """).fetchone()[0]
    assert unfloored < 50, "the floor is a no-op on this warehouse -- the test proves nothing"


def test_same_airport_rows_are_excluded_from_the_presets(con):
    """6 of 5,611 mart rows are same-airport, and 3 of the 5 rows at lf_t12 = 0 are among
    them. The filings are real, but a ROUTE leaderboard listing ATW-ATW reads as a bug."""
    same = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE route_key_low = route_key_high"
    ).fetchone()[0]
    assert same == 6, "the exclusion in every watch_*.sql is what this count justifies"


# --------------------------------------------------------------------------------------------
# The departure floor is a RATE (#148). These three are real-data tests because the CI fixture
# structurally cannot carry them: it yields a mart of exactly one row whose t12_months_present
# and t12_months_flown are BOTH 1, so no assertion over it can tell the two denominators apart.
# --------------------------------------------------------------------------------------------


def test_the_floor_is_a_monthly_rate_not_a_trailing_12_sum(con):
    """THE bug this change exists to kill: `t12_departures_performed >= 30` compared a
    twelve-month SUM against a per-month floor, so a carrier-route flying 2.5 departures a
    month cleared it -- the most lenient surviving instance of the defect #134 closed
    everywhere else.

    Named witness, not a count: `20330 10241-10304` filed 30 departures across 12 months
    flown, exactly 2.5 a month. It is the single most lenient row the old gate admitted.
    Reverting the gate to `>= 30` puts it back and reddens THIS test.

    The dense control is not decoration -- it is what stops the assertion from passing on a
    mart that admits nothing at all, which a broken floor could easily produce. `20455
    10299-11555` runs 18,071 departures over 11 months (1,643 a month) and must survive any
    floor that deserves the name.
    """
    sparse = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE op_airline_id = 20330 AND route_key_low = 10241 AND route_key_high = 10304
    """).fetchone()[0]
    assert sparse == 0, (
        "20330 10241-10304 flew 30 departures over 12 months (2.5/month) and is admitted -- "
        "the gate is comparing a trailing-12 sum against a monthly floor"
    )
    dense = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE op_airline_id = 20455 AND route_key_low = 10299 AND route_key_high = 11555
    """).fetchone()[0]
    assert dense == 1, "the densest row in the warehouse is missing -- the floor rejects everything"


def test_the_floor_divides_by_months_flown_not_months_filed(con):
    """`t12_months_present` counts months FILED; the floor's denominator is months FLOWN --
    `active_months`'s definition (sql/03_queries/pivot_route.sql). Wiring the wrong one here
    would put a second, subtly different definition of "active months" in the tree, which is
    the defect #134 exists to close, reintroduced by its own fix.

    Two named witnesses, because exactly two carrier-routes in the warehouse have an admission
    OUTCOME that differs between the two denominators -- a fixture drawn anywhere else cannot
    tell them apart:

      20253 12478-13541   filed 12 months, FLEW 7,  296 departures.  296 >= 30*7 but < 30*12
      20253 10721-11615   filed  9 months, FLEW 3,  148 departures.  148 >= 30*3 but < 30*9

    Both are real seasonal operations running at four to six times the floor while they ran.
    Swapping `t12_months_flown` for `t12_months_present` in the gate drops both and reddens
    THIS test.
    """
    found = con.execute("""
        SELECT count(*) FROM mart_route_health
        WHERE (op_airline_id, route_key_low, route_key_high) IN (
            (20253, 12478, 13541), (20253, 10721, 11615))
    """).fetchone()[0]
    assert found == 2, (
        "a seasonal carrier-route running above the rate floor over the months it flew was "
        "excluded -- the gate is dividing by months FILED, not months FLOWN"
    )


def test_months_flown_counts_only_months_that_performed_departures(con):
    """The stored denominator must equal the same count `active_months` emits, re-derived here
    from fct_route_month rather than read back from the column it is checking.

    A month that filed a schedule and performed nothing DID NOT FLY. Relaxing the predicate to
    `departures_performed >= 0` (or dropping it, leaving "a row exists") counts those months
    and understates the rate, marking real operations sparse.

    The second assertion is what stops the first from being vacuous. If no mart row had
    months_flown different from months_present, the comparison would pass under either
    definition and prove nothing about which one is stored.
    """
    mismatched = con.execute("""
        WITH w AS (SELECT DISTINCT t12_start_month AS s, t12_end_month AS e
                   FROM mart_route_health),
        flown AS (
            SELECT r.op_airline_id, r.route_key_low, r.route_key_high,
                   count(DISTINCT r.year_month)
                       FILTER (WHERE r.departures_performed > 0) AS months_flown
            FROM fct_route_month r, w
            WHERE r.year_month BETWEEN w.s AND w.e
            GROUP BY 1, 2, 3)
        SELECT count(*)
        FROM mart_route_health m
        JOIN flown f USING (op_airline_id, route_key_low, route_key_high)
        WHERE m.t12_months_flown <> f.months_flown
    """).fetchone()[0]
    assert mismatched == 0, "t12_months_flown does not match the months that actually flew"

    discriminating = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE t12_months_flown <> t12_months_present"
    ).fetchone()[0]
    assert discriminating > 0, (
        "no admitted row filed a month it did not fly, so the assertion above cannot "
        "distinguish months FLOWN from months FILED -- it is vacuous on this warehouse"
    )
