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
COMPLETION_CAPPED = "CASE WHEN completion_factor IS NULL THEN NULL ELSE least(completion_factor,1.5) END"

AXES = f"""
    SELECT
        avg(abs(greatest(least(z_lf,         3), -3))) AS lf,
        avg(abs(greatest(least(z_gauge,      3), -3))) AS gauge,
        avg(abs(greatest(least(z_freq,       3), -3))) AS freq,
        avg(abs(greatest(least(z_completion, 3), -3))) AS completion
    FROM (
        SELECT
            (lf_delta - avg(lf_delta) OVER ()) / stddev_samp(lf_delta) OVER () AS z_lf,
            (ln(nullif(gauge_t12,0)/nullif(gauge_p12,0))
              - avg(ln(nullif(gauge_t12,0)/nullif(gauge_p12,0))) OVER ())
              / stddev_samp(ln(nullif(gauge_t12,0)/nullif(gauge_p12,0))) OVER () AS z_gauge,
            (ln(nullif(t12_departures_performed,0)/nullif(p12_departures_performed,0))
              - avg(ln(nullif(t12_departures_performed,0)/nullif(p12_departures_performed,0))) OVER ())
              / stddev_samp(ln(nullif(t12_departures_performed,0)/nullif(p12_departures_performed,0))) OVER () AS z_freq,
            ({COMPLETION_CAPPED} - avg({COMPLETION_CAPPED}) OVER ())
              / stddev_samp({COMPLETION_CAPPED}) OVER () AS z_completion,
            health_score
        FROM mart_route_health
    )
    WHERE health_score IS NOT NULL
"""


def test_all_four_axes_carry_comparable_weight(con):
    """THE test this milestone exists for. The shipped composite's five components ranged from
    0.575 to 0.023 mean |z| -- a 25.0x spread on nominally equal weights, because three were
    unbounded ratios whose own outliers inflated their own denominators.

    Asserting 'the score is a composite' would pass on the broken version. Asserting the SPREAD
    is what distinguishes them."""
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
    assert (total, scored) == (8080, 7267)
    assert (no_prior, no_schedule) == (688, 180)
    assert neither == 0          # every NULL has one of the two live reasons
    assert no_prior + no_schedule - (total - scored) == 55   # the documented overlap


Z_COLUMNS = f"""
    SELECT
        (lf_delta - avg(lf_delta) OVER ()) / stddev_samp(lf_delta) OVER () AS z_lf,
        (ln(nullif(gauge_t12,0)/nullif(gauge_p12,0))
          - avg(ln(nullif(gauge_t12,0)/nullif(gauge_p12,0))) OVER ())
          / stddev_samp(ln(nullif(gauge_t12,0)/nullif(gauge_p12,0))) OVER () AS z_gauge,
        (ln(nullif(t12_departures_performed,0)/nullif(p12_departures_performed,0))
          - avg(ln(nullif(t12_departures_performed,0)/nullif(p12_departures_performed,0))) OVER ())
          / stddev_samp(ln(nullif(t12_departures_performed,0)/nullif(p12_departures_performed,0))) OVER () AS z_freq,
        ({COMPLETION_CAPPED} - avg({COMPLETION_CAPPED}) OVER ())
          / stddev_samp({COMPLETION_CAPPED}) OVER () AS z_completion,
        health_score
    FROM mart_route_health
"""


def test_the_clamp_binds_on_a_real_minority(con):
    """A clamp that never fires is decoration; one that fires on everything is a rank
    transform wearing a z-score's name. 470 of 7,267 is the measured middle."""
    clamped = con.execute(f"""
        SELECT count(*) FROM ({Z_COLUMNS})
        WHERE health_score IS NOT NULL
          AND (abs(z_lf) > 3 OR abs(z_gauge) > 3 OR abs(z_freq) > 3 OR abs(z_completion) > 3)
    """).fetchone()[0]
    assert clamped == 470


def test_no_axis_survives_the_clamp_unbounded(con):
    """The observed maximum |health_score| is 2.31246 against a construction bound of 3.0
    (four axes, each clamped to 3, weighted 0.25). Unclamped, VD CPX-VQS reaches z_gauge
    -17.28 on this warehouse."""
    worst = con.execute(
        "SELECT max(abs(health_score)) FROM mart_route_health WHERE health_score IS NOT NULL"
    ).fetchone()[0]
    assert worst <= 3.0
    assert worst == pytest.approx(2.31246, abs=1e-4)


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
