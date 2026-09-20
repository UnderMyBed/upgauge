"""The generated reference-values artifact. This exists so an upstream BTS refresh produces
ONE readable diff instead of scattered assertion failures -- see
docs/superpowers/specs/2026-08-08-ci-and-tooling-foundation-design.md."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest

from pipeline.stats import STATS_PATH, all_measures_sql, collect

DB = Path("upgauge.duckdb")
pytestmark = pytest.mark.skipif(not DB.exists(), reason="no built catalog; run `make build`")

# This skip is legitimate (the catalog is a build artifact) but M1 shipped 12 real-data tests
# that skipped for FOUR MILESTONES because their guard was permanently false. After running,
# confirm from pytest's output that these PASSED, not SKIPPED.


@pytest.fixture(scope="module")
def con():
    return duckdb.connect(str(DB), read_only=True)


def test_generated_artifact_matches_the_live_warehouse(con):
    """The gate itself: if this fails, either the warehouse moved or someone hand-edited the
    artifact. Both must be loud."""
    assert STATS_PATH.exists(), "run `make stats`"
    committed = json.loads(STATS_PATH.read_text())
    assert committed["measures"] == collect(con)["measures"]


def test_collect_reports_the_shape_that_broke_on_the_2026_08_07_refresh(con):
    """Every key here names something a real BTS refresh moved. aircraft 699 was renamed
    'A321/LR' -> 'A321nXLR', which reddened 17 assertions while moving NO number; city markets
    went 6,177 -> 6,181. Absence of any of these keys means the artifact cannot see the drift
    class it exists to catch."""
    m = collect(con)["measures"]
    for key in (
        "max_year_month",
        "fact_rows",
        "quarantined_rows",
        "dim_airport_current",
        "dim_carrier_rows",
        "dim_aircraft_type_rows",
        "city_markets",
        "fact_present_aircraft_codes",
        "aircraft_short_names",
        "aircraft_slug_separators",
    ):
        assert key in m, f"missing measure: {key}"


def test_aircraft_short_names_are_sorted_and_carry_their_code(con):
    """A set rendered in nondeterministic order would diff spuriously on every run, which
    would train a reader to ignore the diff -- the exact failure this artifact prevents."""
    names = collect(con)["measures"]["aircraft_short_names"]
    codes = [row["code"] for row in names]
    assert codes == sorted(codes)
    assert {"code": "699", "short_name": "A321nXLR"} in names


def test_page_cardinality_measures_are_generated():
    """#91: these figures were stated across 27 files and generated in NONE, so a BTS refresh
    moved every one of them and nothing anywhere went red. Each must now come from the artifact,
    so a refresh reddens `make stats` at the producer instead of drifting silently in prose."""
    measures = json.loads(STATS_PATH.read_text())["measures"]
    for key in (
        "sitemap_routes",
        "sitemap_airports",
        "sitemap_carriers",
        "sitemap_aircraft",
        "sitemap_urls_total",
        "sitemap_entity_urls",
        "sitemap_route_and_airport_urls",
        "route_pairs_with_same_airport",
        "same_airport_pairs",
        "route_order_disagreeing_pairs",
        "route_order_agreeing_pairs",
        "route_pairs_with_a_gap_month",
        "route_pairs_stale_vs_trailing_12",
    ):
        assert isinstance(measures.get(key), int), f"{key} is not a generated integer"


def test_route_health_measures_are_generated():
    """#146/#148: the mart's own cardinality figures were the one family this gate did not
    cover. `8,065`, `733`, `606`, `177`, the overlap `50`, `68` and `466 of 7,332` were stated
    across docs, SQL comments, served copy and test literals and generated NOWHERE -- so the
    #148 floor change moved every one of them at once and nothing anywhere would have gone red.
    Same failure #91 fixed for page cardinality, one mart over.

    `route_health_pairs` is here for a reason the others are not: it is the figure the tree
    never carried at all. mart_route_health's grain is (op_airline_id, route), so its row count
    is not a route count -- `8,065 routes` overstated routes by 84% and every derived sentence
    inherited it. Generating the distinct-pair count is what lets a sentence about routes be
    re-derived instead of re-worded."""
    measures = json.loads(STATS_PATH.read_text())["measures"]
    for key in (
        "route_health_rows",
        "route_health_pairs",
        "route_health_scored",
        "route_health_with_prior_window",
        "route_health_null_score",
        "route_health_no_prior_window",
        "route_health_no_schedule",
        "route_health_null_overlap",
        "route_health_same_airport_rows",
    ):
        assert isinstance(measures.get(key), int), f"{key} is not a generated integer"


def test_the_three_null_reasons_account_for_every_unscored_row():
    """The identity behind docs/data/model.md's "never sum them" warning, asserted rather than
    restated: no_prior + no_schedule - overlap == null_score, and scored + null == rows. A
    measure that drifted off its own predicate breaks one of these while still looking like a
    plausible number on its own."""
    m = json.loads(STATS_PATH.read_text())["measures"]
    assert m["route_health_scored"] + m["route_health_null_score"] == m["route_health_rows"]
    assert (
        m["route_health_no_prior_window"]
        + m["route_health_no_schedule"]
        - m["route_health_null_overlap"]
        == m["route_health_null_score"]
    ), (
        "the two live NULL reasons no longer account for every unscored pair. The likeliest "
        "cause is not a broken measure: docs/data/model.md warns that the THIRD reason -- a "
        "prior window that is present but filed zero seats and zero departures -- is empty "
        "today as a property of which 24 months are current, not structurally. If it has "
        "reappeared, this identity needs its third term, not a fix."
    )


def test_route_health_pairs_is_below_rows_and_above_zero():
    """The grain claim itself (#146). If these were equal the mart would be one row per route
    and every "N routes" sentence the sweep rewrote would have been correct as written; the gap
    is what makes the distinction real and worth generating."""
    m = json.loads(STATS_PATH.read_text())["measures"]
    assert 0 < m["route_health_pairs"] < m["route_health_rows"]


def test_sitemap_totals_are_consistent_with_their_parts():
    """A total that is not the sum of its parts means one measure drifted off the sitemap query
    it mirrors. `+5` is /watch and its four presets -- entity pages with no OG card, which is
    the one asymmetry between the two totals.

    The route identity is the load-bearing one: sitemap_routes EXCLUDES same-airport pairs
    (CLAUDE.md / routePair.ts -- those are not routes) and route_pairs_with_same_airport
    includes them, so the two must differ by exactly same_airport_pairs. Filtering quarantine
    out of any of them breaks this by 31 rows."""
    m = json.loads(STATS_PATH.read_text())["measures"]
    entity = (
        m["sitemap_routes"] + m["sitemap_airports"] + m["sitemap_carriers"] + m["sitemap_aircraft"]
    )
    assert m["sitemap_entity_urls"] == entity
    assert m["sitemap_urls_total"] == entity + 5
    assert m["sitemap_route_and_airport_urls"] == m["sitemap_routes"] + m["sitemap_airports"]
    assert m["route_pairs_with_same_airport"] == m["sitemap_routes"] + m["same_airport_pairs"]
    assert (
        m["route_order_agreeing_pairs"] == m["sitemap_routes"] - m["route_order_disagreeing_pairs"]
    )


# The measure -> the sitemap query it claims to mirror. stats_counts.sql's header asserts this
# relationship in prose; this is the executable form.
_MIRRORS = {
    "sitemap_routes": "sitemap_routes.sql",
    "sitemap_airports": "sitemap_airports.sql",
    "sitemap_carriers": "sitemap_carriers.sql",
    "sitemap_aircraft": "sitemap_aircraft.sql",
}


def test_each_page_count_equals_the_sitemap_query_it_mirrors(con):
    """The measure must count the pages the SITE SERVES, not merely something plausible.

    This exists because the arithmetic identities could not catch either of two real mutants.
    Dropping `HAVING count(DISTINCT t.code) = 1` from sitemap_aircraft takes it from 110 to 111
    -- admitting CE-180, the ambiguous short name that renders a 404 rather than a page -- and
    every total still balanced, because the totals are sums of the very measure that moved.
    Adding `NOT is_quarantined` to sitemap_routes is the same shape of error in the opposite
    direction (22,635 -> 22,604).

    Comparing against the shipped query is the only assertion that distinguishes them: a measure
    that stops mirroring its query fails here, however self-consistent the artifact stays.
    """
    measures = json.loads(STATS_PATH.read_text())["measures"]
    sql_dir = Path(__file__).parents[2] / "sql" / "03_queries"
    for key, filename in _MIRRORS.items():
        served = len(con.execute((sql_dir / filename).read_text()).fetchall())
        assert measures[key] == served, (
            f"{key} is {measures[key]:,} but {filename} returns {served:,} rows -- the measure "
            f"has stopped counting the pages /sitemap.xml actually serves"
        )


def test_route_order_halves_account_for_every_pair(con):
    """agree + disagree = sitemap_routes, with BOTH halves measured independently.

    Deriving the agreeing half made this vacuous: it moved with the disagreeing half, so
    reversing `a.code > b.code` to `<` left the suite green while the two figures swapped
    (215 and 22,420). Measured separately, the identity also proves no pair has two endpoints
    resolving to the same current code -- such a pair is in neither half and would show up here
    as a shortfall rather than as a silently wrong percentage on the route page.
    """
    m = json.loads(STATS_PATH.read_text())["measures"]
    assert (
        m["route_order_agreeing_pairs"] + m["route_order_disagreeing_pairs"] == m["sitemap_routes"]
    )


def test_crossover_halves_stay_copy_consistent():
    """changed + never-changed = sitemap_routes.

    THIS IS NOT A CHECK ON THE PREDICATE, and an earlier revision of this docstring said it
    was. `crossover_routes_none` is `NOT EXISTS` over the same population with a byte-copy of
    the same chain, so the identity holds for ANY predicate: invert `code <> prev` in BOTH
    blocks and it stays green at 12,216 + 10,419 = 22,635 while the prose states the opposite
    of what is measured. Mutating one copy kills it, which is exactly why a one-copy mutant is
    not evidence about a two-copy structure.

    What it does catch is the two copies DRIFTING APART -- the live risk of duplicating a chain
    this long -- and it proves the two halves partition the population BY COUNT: a route
    falling into neither shows as a shortfall, into both as an excess, so one with no led year
    at all (every year tied, unknowable or flown empty) lands in exactly one. Cardinalities
    only. Two copies could in principle drift into different sets of the same size, and
    claiming more than that would be the overclaim this docstring already had to lose once.
    The predicate itself is pinned by the falsifiable pair below, and the two assertions are
    complementary: the pair fixes what `changed` means, this fixes `none` against it.
    """
    m = json.loads(STATS_PATH.read_text())["measures"]
    assert m["crossover_routes"] + m["crossover_routes_none"] == m["sitemap_routes"]


# The two route pairs that tell the crossover predicate apart from its plausible inversions,
# keyed by airport id. `app/smoke.sh` pins the same pair on the RENDERED annotation and states
# why: absence alone is satisfied by a predicate that never fires, presence alone by one that
# always does. Only the pair is a test.
_JFK_LAX = (12478, 12892)  # A321nXLR leads every year 2015-2026 -- no crossover
_ATL_MCO = (10397, 13204)  # A321nXLR -> B757-2 in 2018
_05A_ANC = (10005, 10299)  # one filed month, one stateable -- fails the >= 2 threshold
_DCK_GAL = (11280, 11844)  # THREE filed months, one stateable -- fails only on QUARANTINE

# A MARKER, not query logic. It is the outer aggregate that turns a measure's pair set into a
# count, and replacing it is how these tests read the set THE MEASURE ITSELF built rather than
# adding a third copy of a CTE chain this repo already carries twice. A copy would drift, and
# drift is the one failure the identity above cannot see.
_COUNT_HEAD = "SELECT count(*) FROM ("


def _pairs_behind(con, measure: str) -> set[tuple[int, int]]:
    statement = all_measures_sql()[measure]
    assert statement.count(_COUNT_HEAD) == 1, (
        f"{measure} no longer has exactly one {_COUNT_HEAD!r} projection, so this test is not "
        f"reading the set that measure counts. Fix the transform, never the assertion."
    )
    rows = con.execute(statement.replace(_COUNT_HEAD, "SELECT * FROM (", 1)).fetchall()
    return {(lo, hi) for lo, hi in rows}


def test_the_crossover_predicate_is_pinned_to_the_pair_that_distinguishes_it(con):
    """The falsifiable pair, asserted against `crossover_routes`'s own set.

    Each half refuses a different wrong predicate, and they are asserted separately so the red
    says which: ATL-MCO's absence means the predicate stopped firing, JFK-LAX's presence means
    it fires where the leader never changes. Inverting `code <> prev` to `code = prev` in every
    copy -- the mutant the identity above survives -- puts JFK-LAX into `changed`, because its
    A321nXLR leads every led year in a row, and dies here.
    """
    changed = _pairs_behind(con, "crossover_routes")
    assert _ATL_MCO in changed, (
        "ATL-MCO's #1 type goes A321nXLR -> B757-2 in 2018 -- app/smoke.sh pins the rendered "
        "annotation. Absent from `changed`, the predicate has stopped detecting crossovers."
    )
    assert _JFK_LAX not in changed, (
        "JFK-LAX's A321nXLR is the #1 type in every year 2015-2026, so it has no crossover. "
        "Present in `changed`, the predicate is reporting a change where the leader held."
    )


def test_the_drawing_population_is_the_routes_whose_chart_actually_draws(con):
    """`crossover_routes_drawing` mirrors `mixChartDraws`, which is TWO rules, not one: the
    `>= 2` threshold and the fact that it counts STATEABLE months rather than filed ones.

    ONE FIXTURE PER RULE, because a fixture that exercises one of two asserted properties is
    the vacuous fixture wearing half a disguise. 05A-ANC files one month and is refused by the
    threshold; DCK-GAL files THREE and is refused only by quarantine, so it is the one that
    moves when `FILTER (WHERE NOT is_quarantined)` is dropped. Confirmed by running that
    mutant: the count rises, DCK-GAL crosses into `drawing`, and JFK-LAX and 05A-ANC do not
    budge -- which is why the threshold fixtures alone left half the mirrored rule unpinned.

    The subset relation is asserted rather than assumed, because `crossover_routes_drawing_none`
    is derived by subtracting one from the other: a crossover needs two led years, which needs
    two stateable months, so every changed route draws.
    """
    drawing = _pairs_behind(con, "crossover_routes_drawing")
    assert _JFK_LAX in drawing, "JFK-LAX files every month in the window and draws a chart"
    assert _05A_ANC not in drawing, (
        "05A-ANC has ONE filed month. A stacked area over one month has a degenerate x domain "
        "and serializes to zero width, which is why mixChartDraws requires >= 2."
    )
    assert _DCK_GAL not in drawing, (
        "DCK-GAL files THREE months and only ONE of them is stateable -- the other two are "
        "wholly quarantined, so the chart has one point and cannot draw. Present here, the "
        "measure is counting FILED months, which is the distinction mixChartDraws exists to "
        "make and which no threshold fixture can catch."
    )
    m = json.loads(STATS_PATH.read_text())["measures"]
    assert _pairs_behind(con, "crossover_routes") <= drawing
    assert m["crossover_routes"] < m["crossover_routes_drawing"] < m["sitemap_routes"]
    assert (
        m["crossover_routes_drawing"] - m["crossover_routes"] == m["crossover_routes_drawing_none"]
    )


def test_the_gauge_spread_measures_are_decimals_with_a_real_spread():
    """The gauge figures are DERIVED measures -- seats per departure -- and the artifact's
    first non-integers.

    `low < high` is the claim the /aircraft ramp rests on: if the lightest and darkest operator
    of an airframe had the same gauge, ordering the bands by it would encode nothing and the
    legend rail would be describing a ramp that is not there. Typed too: an int here would mean
    a measure had started returning a count, and every needle quoting it to one decimal would
    then be pinning a number that cannot carry one.
    """
    m = json.loads(STATS_PATH.read_text())["measures"]
    for key in ("a321nxlr", "a320_12", "b737_8"):
        low, high = m[f"gauge_{key}_full_low"], m[f"gauge_{key}_full_high"]
        assert isinstance(low, float) and isinstance(high, float), key
        assert 0 < low < high, key
        assert m[f"gauge_{key}_full_spread"] == round(high - low, 4), key
