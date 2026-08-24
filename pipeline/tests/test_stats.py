"""The generated reference-values artifact. This exists so an upstream BTS refresh produces
ONE readable diff instead of scattered assertion failures -- see
docs/superpowers/specs/2026-08-08-ci-and-tooling-foundation-design.md."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest

from pipeline.stats import STATS_PATH, collect

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
    """#91: these figures were stated in 27 files and generated in NONE, so the 2026-08-07 BTS
    refresh moved every one of them (22,420 route pairs -> 22,509, 1,045 airports -> 1,047) and
    nothing anywhere went red. Each must now come from the artifact so a refresh reddens
    `make stats` at the producer instead of drifting silently in prose."""
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
    direction (22,509 -> 22,478).

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
    (215 and 22,294). Measured separately, the identity also proves no pair has two endpoints
    resolving to the same current code -- such a pair is in neither half and would show up here
    as a shortfall rather than as a silently wrong percentage on the route page.
    """
    m = json.loads(STATS_PATH.read_text())["measures"]
    assert (
        m["route_order_agreeing_pairs"] + m["route_order_disagreeing_pairs"] == m["sitemap_routes"]
    )
