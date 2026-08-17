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
# fabricates a completion rate for the 180 routes with no filed schedule -- the same NULL
# trap the mart SQL's comment on `completion_capped` documents. A bare least() here would
# pollute this axis's population avg/stddev with 180 fabricated 1.5s before the outer
# `WHERE health_score IS NOT NULL` ever drops those rows (they are dropped too late --
# the window functions already ran over the polluted population). Confirmed: this guarded
# form reconstructs the stored health_score to within 1.47e-14 over every scored row;
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
    under the four-axis, logged choice shows the spread holds at 1.5x. For the guarantee that
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
    assert (total, scored) == (8065, 7332)
    assert (no_prior, no_schedule) == (606, 177)
    assert neither == 0  # every NULL has one of the two live reasons
    assert no_prior + no_schedule - (total - scored) == 50  # the documented overlap


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
    to the mart). 466 of 7,332 is the measured middle: a clamp that fires on zero rows would be
    decoration, one that fires on all of them would be a rank transform wearing a z-score's
    name."""
    clamped = con.execute(f"""
        SELECT count(*) FROM ({Z_COLUMNS})
        WHERE health_score IS NOT NULL
          AND (abs(z_lf) > 3 OR abs(z_gauge) > 3 OR abs(z_freq) > 3 OR abs(z_completion) > 3)
    """).fetchone()[0]
    assert clamped == 466


def test_no_axis_survives_the_clamp_unbounded(con):
    """The observed maximum |health_score| is 2.30880 against a construction bound of 3.0
    (four axes, each clamped to 3, weighted 0.25). Unclamped, VD CPX-VQS reaches z_gauge
    -15.99 on this warehouse."""
    worst = con.execute(
        "SELECT max(abs(health_score)) FROM mart_route_health WHERE health_score IS NOT NULL"
    ).fetchone()[0]
    assert worst <= 3.0
    assert worst == pytest.approx(2.30880, abs=1e-4)


def test_health_score_reconstructs_from_its_own_axes(con):
    """THE test coupled to the mart's own SQL, unlike the two above. It reads the STORED
    `health_score` column and asserts it equals the CASE-guarded, ±3-clamped, 0.25-weighted sum
    of the same four axes recomputed here from raw columns -- so it goes red if
    sql/02_marts/200_mart_route_health.sql stops matching that formula, whether the break is in
    which columns feed an axis (e.g. reverting to raw capacity_delta/frequency_delta instead of
    the logged ratios) or in whether the clamp is applied at all. Measured max |residual|
    5.22e-15 across all 7,332 scored rows -- floating-point noise, not a near-match."""
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
    GCH 1G4-BLD leads at LF 0.0000 on gauge 6.0. The preset is billed as the hook; it implies
    a mainline wasting capacity and delivers cargo runs.

    Asserting 'the top row has a low load factor' passes on the BROKEN version too. Asserting
    the top row is real airliner metal is what distinguishes them."""
    gauge, dep = con.execute("""
        SELECT gauge_t12, t12_departures_performed FROM mart_route_health
        WHERE route_key_low <> route_key_high
          AND lf_t12 IS NOT NULL
          AND gauge_t12 >= 50
          AND t12_departures_performed >= 360
        ORDER BY lf_t12 ASC LIMIT 1
    """).fetchone()
    assert gauge >= 50, gauge
    assert dep >= 360, dep

    unfloored = con.execute("""
        SELECT gauge_t12 FROM mart_route_health
        WHERE route_key_low <> route_key_high
          AND lf_t12 IS NOT NULL
          AND t12_departures_performed >= 360
        ORDER BY lf_t12 ASC LIMIT 1
    """).fetchone()[0]
    assert unfloored < 50, "the floor is a no-op on this warehouse -- the test proves nothing"


def test_same_airport_rows_are_excluded_from_the_presets(con):
    """68 of 8,065 mart rows are same-airport, and 59 of the 76 rows at lf_t12 = 0 are among
    them. The filings are real, but a ROUTE leaderboard listing ATW-ATW reads as a bug."""
    same = con.execute(
        "SELECT count(*) FROM mart_route_health WHERE route_key_low = route_key_high"
    ).fetchone()[0]
    assert same == 68, "the exclusion in every watch_*.sql is what this count justifies"
