"""Every dataset-cardinality figure STATED in the repo, bound to the artifact that generates it.

#91: thirteen such figures were stated across 27 files and generated in none, so a BTS refresh
moved all of them at once and nothing anywhere went red. The repo then held two different route
counts simultaneously: `app/src/lib/sitemap.ts` carried the corrected figure on one line and the
superseded one three lines below it. That is what a partial sweep leaves behind when no gate can
say whether a sweep is finished.

The fix is not a sweep. A sweep regresses on the next refresh. Each figure is generated
(`sql/03_queries/stats_counts.sql` -> `pipeline/reference/stats.generated.json`, already
diff-gated by CI) and bound here to its stated form in BOTH directions:

    forward   every file registered for a measure states that measure's CURRENT value
    reverse   every file stating that value is registered

Forward alone lets a figure rot in a file nobody thought to register. Reverse alone passes
VACUOUSLY the moment the dataset moves -- the files then state the old value, so the scan finds
nothing and reports success. Only the pair is a gate.

What a refresh looks like from here: `make stats` reddens first (the artifact diff), and once
the artifact is updated this module reddens on every stated site at once, naming each file. The
remedy is mechanical and the gate says when it is complete.

CLAUDE.md's rule that measurements belong in generated output is what this enforces. Its other
rule -- keep the evidence attached to the constraint it justifies -- is why the numbers stay
inline in prose rather than being replaced by pointers to the artifact.

`docs/superpowers/` is excluded: specs and plans are DATED artifacts recording what was measured
the day they were written. Sweeping them would be writing the correction instead of the rule.
Generated files are excluded because they are outputs, and `docs/design/mockups/` because its
embedded coordinate data contains these digit sequences as substrings of unrelated numbers.
"""

from __future__ import annotations

import json
import re
import string
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parents[2]
MEASURES: dict[str, Any] = json.loads(
    (ROOT / "pipeline" / "reference" / "stats.generated.json").read_text()
)["measures"]

# Whole trees, not hand-picked subdirectories. Naming `docs/architecture`, `docs/data`,
# `docs/design` and `docs/product` individually left `docs/README.md` and anything else at the
# root of docs/ outside the scan, and a mutant that added the route count there survived -- the
# precise failure this reverse check exists to prevent. Exclusions belong in SKIP, where they
# are stated once and apply everywhere, never in the enumeration of what to look at.
SCANNED_DIRS = ("docs", "app/src", "sql", "pipeline", "deploy")
SCANNED_FILES = ("CLAUDE.md", "app/smoke.sh")
SCANNED_SUFFIXES = (".md", ".ts", ".tsx", ".py", ".sql", ".sh")
# This module is skipped in the reverse scan for the same reason a ruler is not measured with
# itself: its manifest and its failure messages quote these values by construction, so scanning
# it would report every measure as an unregistered site.
SKIP = (
    ".generated.",
    "node_modules/",
    "/.next/",
    "docs/superpowers/",
    "/mockups/",
    "test_stated_counts.py",
)

# Measures whose value is distinctive enough to scan for: a comma-formatted 4+ digit number
# means one thing repo-wide. Gated in BOTH directions.
STATED: dict[str, tuple[str, ...]] = {
    "sitemap_routes": (
        "CLAUDE.md",
        "app/smoke.sh",
        "app/src/app/explore/page.test.tsx",
        "app/src/app/explore/page.tsx",
        "app/src/app/route/[pair]/page.test.tsx",
        "app/src/app/route/[pair]/page.tsx",
        "app/src/app/sitemap.ts",
        "app/src/lib/entityFacts.ts",
        "app/src/lib/entityLink.ts",
        "app/src/components/AircraftMixChart.test.tsx",
        "app/src/lib/chart/crossover.ts",
        "app/src/lib/routePair.test.ts",
        "app/src/lib/routePair.ts",
        "app/src/lib/search.test.ts",
        "app/src/lib/sitemap.test.ts",
        "app/src/lib/sitemap.ts",
        "docs/architecture/hosting.md",
        "docs/architecture/pipeline.md",
        "docs/data/invariants.md",
        "docs/design/system.md",
        "docs/product/features.md",
        "docs/product/scope.md",
        "pipeline/tests/test_cloudflare_desired_state.py",
        "pipeline/tests/test_stats.py",
        "sql/03_queries/sitemap_routes.sql",
        "sql/03_queries/stats_counts.sql",
    ),
    "sitemap_airports": (
        "app/src/app/route/[pair]/page.test.tsx",
        "app/src/app/sitemap.ts",
        "app/src/lib/map/albers.ts",
        "app/src/lib/map/greatCircle.test.ts",
        "app/src/lib/map/greatCircle.ts",
        "app/src/lib/map/networkMap.test.ts",
        "app/src/lib/map/networkMap.ts",
        "app/src/lib/map/panelContainment.test.ts",
        "app/src/lib/map/segmentMap.test.ts",
        "app/src/lib/map/segmentMap.ts",
        "app/src/lib/sitemap.test.ts",
        "docs/architecture/hosting.md",
        "docs/data/invariants.md",
        "docs/design/system.md",
        "docs/product/scope.md",
        "pipeline/tests/test_resolution_invariants.py",
        "sql/03_queries/lookup_airport_by_code.sql",
        "sql/03_queries/map_airport_coords.sql",
        "sql/03_queries/sitemap_airports.sql",
    ),
    "sitemap_urls_total": (
        "app/src/app/route/[pair]/page.test.tsx",
        "app/src/app/sitemap.ts",
        "app/src/lib/sitemap.test.ts",
        "app/src/proxy.ts",
        "docs/architecture/hosting.md",
        "docs/product/features.md",
        "docs/product/scope.md",
    ),
    "sitemap_entity_urls": (
        "app/src/app/route/[pair]/page.test.tsx",
        "app/src/app/sitemap.ts",
        "app/src/lib/canonicalQuery.test.ts",
        "app/src/lib/sitemap.test.ts",
        "app/src/proxy.test.ts",
        # #117: hosting.md states the rate-limited share of the published sitemap, which is this
        # measure over `sitemap_urls_total`. THIS MANIFEST IS TO BE REGISTERED AGAINST, NEVER
        # ROUTED AROUND: reaching for a smaller measure that is already registered, because the
        # right one is not, buys a green gate with prose that answers a different question.
        "docs/architecture/hosting.md",
    ),
    "sitemap_route_and_airport_urls": (
        "app/src/app/route/[pair]/page.test.tsx",
        "docs/product/features.md",
    ),
    "route_pairs_with_same_airport": (
        "app/smoke.sh",
        "app/src/app/route/[pair]/page.tsx",
        # #121: the denominator for how narrow the crossover annotation's new refusal is.
        "app/src/lib/chart/crossover.ts",
        "app/src/components/AircraftMixChart.test.tsx",
        "app/src/lib/chart/aircraftMix.test.ts",
        "app/src/lib/chart/aircraftMix.ts",
        "app/src/lib/map/carrierTypeNetwork.ts",
        "docs/architecture/hosting.md",
        "docs/data/invariants.md",
        "docs/design/system.md",
        "docs/product/features.md",
    ),
    "route_order_agreeing_pairs": (
        "app/src/app/explore/page.test.tsx",
        "app/src/lib/sitemap.test.ts",
        "docs/design/system.md",
        "pipeline/tests/test_stats.py",
    ),
    "route_pairs_with_a_gap_month": (
        "app/smoke.sh",
        "app/src/components/AircraftMixChart.test.tsx",
        "app/src/lib/chart/aircraftMix.test.ts",
        "app/src/lib/chart/aircraftMix.ts",
        "docs/design/system.md",
    ),
    "route_pairs_stale_vs_trailing_12": (
        "app/smoke.sh",
        "app/src/app/route/[pair]/page.test.tsx",
        "app/src/app/route/[pair]/page.tsx",
        # #121: `sumColumn`'s null SEED is what makes these pairs render an absence rather than
        # a fabricated zero, so the count is the evidence for the seed and belongs beside it --
        # in the module, in its own tests, in `sumTotals`'s tests, and on the route card whose
        # sixth stat has to name which of the two absences a page is in.
        "app/src/app/route/[pair]/opengraph-image.test.tsx",
        "app/src/lib/entityFacts.test.ts",
        "app/src/lib/nullSum.test.ts",
        "app/src/lib/nullSum.ts",
        "docs/data/invariants.md",
        "docs/design/system.md",
        "docs/product/features.md",
    ),
    # mart_route_health cardinality (#146, #148). The grain is a carrier-route PAIR, so `rows`
    # and `pairs` are different questions and both are gated -- stating one as the other is the
    # defect #146 closed.
    #
    # docs/architecture/hosting.md is NOT registered here, and must not be: its only statement of
    # this measure is the leaderboard-precompute retirement paragraph, "Measured 2026-08-30 at
    # `9b358aa`, against a served build on that commit's warehouse" -- a measurement pinned to a
    # build. Registering it would force that figure to the current warehouse on every refresh,
    # which makes the sentence false about the build it names.
    "route_health_rows": (
        "app/smoke.sh",
        "app/src/app/watch/[preset]/page.test.tsx",
        "app/src/app/watch/[preset]/page.tsx",
        "app/src/lib/watch.test.ts",
        "docs/architecture/pipeline.md",
        "docs/data/model.md",
        "docs/product/features.md",
        "pipeline/tests/test_route_health_real_data.py",
        "sql/02_marts/200_mart_route_health.sql",
        "sql/03_queries/watch_death_watch.sql",
        "sql/03_queries/watch_gauge.sql",
    ),
    # One site today, and that is the point: this is the figure the tree never carried. Every
    # "N routes" sentence about the mart was a row count wearing the wrong noun.
    "route_health_pairs": ("docs/data/model.md",),
    "route_health_scored": (
        "docs/data/model.md",
        "pipeline/tests/test_route_health_real_data.py",
        "sql/02_marts/200_mart_route_health.sql",
    ),
    "route_health_with_prior_window": (
        "docs/data/model.md",
        "pipeline/tests/test_route_health.py",
        "sql/02_marts/200_mart_route_health.sql",
    ),
    # docs/architecture/hosting.md is NOT registered here: it states no same-airport filing
    # count. A value of this measure turning up inside one of its unrelated numbers -- the image
    # byte count 412,995,560, say -- is a collision, not a statement, and registering the file to
    # match one would gate a coincidence. Its same-airport statement is the 532-pairs sentence,
    # gated in ANCHORED under same_airport_pairs.
    # The crossover annotation's two populations (#182). BOTH are stated, and both are
    # measured, because the sentence's claim is which of them is larger: it shipped reading
    # "`null` is the common case" directly above a figure saying 54% of routes DO cross over,
    # so the bolded rule and its own evidence disagreed. A single count with the other half
    # subtracted in prose is what let that stand.
    "crossover_routes": (
        "app/src/lib/chart/crossover.ts",
        "docs/design/system.md",
    ),
    # THE POPULATION, and registering it is half of what makes the share above honest. The
    # function is reached only through `prepareMixPlot`, which returns early on
    # `!mixChartDraws(rows)`, so a no-annotation share taken against every route understates
    # it by more than half -- 46.1% of all routes against 25.4% of the ones that draw. Both
    # sentences were literally true and one of them sized the branch wrong.
    #
    # `crossover_routes_none` IS here, with NO sites, and the empty tuple is the point: no
    # sentence states the all-routes complement any more, and the reverse scan is what keeps it
    # that way. Dropping the key entirely left a real hole -- a file already registered for
    # `sitemap_routes`, say docs/product/features.md, could state "10,442 of 22,635 routes
    # (46.1%)" and no check would look at it. The forward loop is a no-op over no sites; the
    # reverse loop flags 10,442 wherever it appears. If the figure is ever wanted in prose
    # again, add the file here rather than deleting the key.
    "crossover_routes_none": (),
    "crossover_routes_drawing": (
        "app/smoke.sh",
        "app/src/components/AircraftMixChart.test.tsx",
        "app/src/lib/chart/crossover.test.ts",
        "app/src/lib/chart/crossover.ts",
        "docs/design/system.md",
    ),
    "crossover_routes_drawing_none": (
        "app/smoke.sh",
        "app/src/components/AircraftMixChart.test.tsx",
        "app/src/lib/chart/crossover.test.ts",
        "app/src/lib/chart/crossover.ts",
        "docs/design/system.md",
    ),
    "same_airport_filings": (
        "app/src/app/airport/[code]/endpoints.ts",
        "app/src/app/explore/page.test.tsx",
        "app/src/lib/pivot/render.ts",
        "app/src/lib/routePair.test.ts",
        "docs/architecture/pipeline.md",
        "docs/data/invariants.md",
        "pipeline/pivot.py",
    ),
}

# Measures whose rendering is not distinctive enough to scan for: counts under 1,000, every
# PERCENTAGE, and every DECIMAL. `532` is also Cloudflare error 530's neighbour in deploy.md,
# `-215.2` is Guam's longitude in invariants.md, and `187.5` is both a gauge figure and the
# longitude of the westernmost basemap point in system.md -- so scanning for them bare would
# either miss real sites or flag unrelated numbers. Each site is registered with the PHRASE
# that pins the meaning, and these are gated FORWARD ONLY. Stated rather than implied: a new
# file stating `532` without being added here goes unnoticed. Widening the scan to bare
# three-digit numbers would flag every line number and percentage in the repo, which is worse
# than the gap.
#
# A DECIMAL's needle carries the carrier code beside the number (`B6 {v:.1f}`), and that is
# deliberate: the measure is "the lightest gauge on this airframe", so a needle pinning the
# number alone would stay green if the lightest OPERATOR changed while its figure did not. The
# phrase catches the ordinary case -- a new carrier brings a new number -- and the residual is
# written down here rather than left to be discovered.
ANCHORED: dict[str, tuple[tuple[str, str], ...]] = {
    "route_order_disagreeing_pairs": (
        ("CLAUDE.md", "{v} of {sitemap_routes} pairs"),
        ("app/smoke.sh", "{v} of {sitemap_routes} pairs"),
        ("app/src/app/explore/page.test.tsx", "{v} of {sitemap_routes} pairs"),
        ("app/src/app/route/[pair]/page.test.tsx", "{v} routes where id"),
        ("app/src/app/route/[pair]/page.tsx", "{v} routes where the"),
        ("app/src/lib/entityFacts.ts", "{v} of {sitemap_routes} routes"),
        ("app/src/lib/entityLink.ts", "{v} of {sitemap_routes} pairs"),
        # Was registered against route_pairs_with_same_airport and read "215 of 23,167 routes"
        # (#182). True of neither population: the 215 are pairs the sitemap SERVES, counted by
        # a measure that excludes same-airport pairs, so 23,167 was a denominator the numerator
        # is not drawn from -- and every other site states the same 215 over 22,635.
        ("app/src/lib/routePair.test.ts", "{v} of {sitemap_routes} routes"),
        ("app/src/lib/routePair.ts", "{v} of {sitemap_routes} routes"),
        ("app/src/lib/search.test.ts", "{v} of {sitemap_routes} pairs"),
        ("app/src/lib/sitemap.ts", "{v} of {sitemap_routes} pairs"),
        ("docs/architecture/pipeline.md", "{v} of {sitemap_routes} routes"),
        ("docs/data/invariants.md", "{v} of {sitemap_routes} routes"),
        ("docs/design/system.md", "{v} of {sitemap_routes} pairs"),
        ("docs/product/features.md", "{v} of {sitemap_routes} pairs"),
        ("docs/product/scope.md", "{v} of {sitemap_routes} pairs"),
        ("sql/03_queries/sitemap_routes.sql", "{v} of {sitemap_routes} pairs"),
    ),
    # mart_route_health's sub-1,000 figures (#146, #148). WHERE a needle carries a grain noun
    # beside the number, the grain rule is pinned by the same gate that pins the count -- a sweep
    # that swapped 373 back into a sentence saying "routes" reddens here, and that is proved by
    # mutation. Every SERVED-COPY site is of that kind, which is where #146's defect was visible.
    # The rest pin only the number in whatever phrase carries it; claiming otherwise (an earlier
    # revision of this comment said "every needle") would be a false universal inside the gate
    # whose whole job is catching false statements about figures.
    "route_health_null_score": (
        ("app/src/app/watch/[preset]/page.test.tsx", "{v} of {route_health_rows}"),
        (
            "app/src/app/watch/[preset]/page.tsx",
            "{v} of {route_health_rows} carrier-route pairs",
        ),
        ("docs/data/model.md", "{v} of {route_health_rows} rows"),
        # This file used to be registered for `route_health_scored` and state "76 of the 5,238
        # scored" -- a true count against a population those 76 are not in, since every one of
        # them is unscored BECAUSE completion_factor is NULL. Registered here now, on the figure
        # the sentence actually uses.
        ("pipeline/tests/test_route_health.py", "{v} UNSCORED carrier-route pairs"),
        ("docs/product/features.md", "{v} of the mart's {route_health_rows} rows"),
        (
            "sql/03_queries/watch_death_watch.sql",
            "{v} of the {route_health_rows} carrier-route pairs",
        ),
        ("sql/03_queries/watch_gauge.sql", "three-reason union ({v}"),
    ),
    "route_health_no_prior_window": (
        ("app/src/app/watch/[preset]/page.tsx", "{v} no prior"),
        ("docs/data/model.md", "| No prior window | {v} |"),
        ("docs/product/features.md", "No prior window — {v}"),
        ("sql/03_queries/watch_death_watch.sql", "{v} no prior window"),
        (
            "sql/03_queries/watch_gauge.sql",
            "the {v} carrier-route pairs with no prior-window data",
        ),
    ),
    "route_health_no_schedule": (
        ("app/src/app/watch/[preset]/page.tsx", "{v} no filed schedule"),
        ("docs/data/model.md", "| Zero scheduled departures | {v} |"),
        ("docs/product/features.md", "Zero scheduled departures — {v}"),
        ("sql/02_marts/200_mart_route_health.sql", "rate for the {v} carrier-route"),
        ("sql/03_queries/watch_death_watch.sql", "{v} no filed schedule"),
    ),
    "route_health_null_overlap": (
        ("app/src/app/watch/[preset]/page.tsx", "overlap {v}"),
        ("docs/data/model.md", "overcounts by {v}"),
        ("sql/03_queries/watch_death_watch.sql", "overlap {v}"),
    ),
    "route_health_same_airport_rows": (
        ("app/src/app/watch/[preset]/page.test.tsx", "{v} of {route_health_rows}"),
        (
            "app/src/app/watch/[preset]/page.tsx",
            "{v} of {route_health_rows} mart_route_health rows",
        ),
        ("pipeline/tests/test_route_health_real_data.py", "{v} of {route_health_rows} mart rows"),
    ),
    "same_airport_pairs": (
        ("app/src/app/explore/page.test.tsx", "{v} distinct pairs"),
        ("app/src/app/explore/page.tsx", "{v} distinct pairs"),
        ("app/src/lib/pivot/render.ts", "{v} airports"),
        ("app/src/lib/routePair.test.ts", "{v} airports"),
        ("app/src/lib/routePair.ts", "{v} same-airport"),
        ("docs/architecture/hosting.md", "{v} same-airport pairs"),
        ("docs/architecture/pipeline.md", "{v} airports"),
        ("docs/data/invariants.md", "{v} airports"),
        ("docs/design/system.md", "{v} such pairs"),
        ("docs/product/features.md", "{v} same-airport pairs"),
        ("pipeline/pivot.py", "{v} airports"),
    ),
    # #182. The share, not just the count: invariants.md and pipeline.md each stated `0.95%`
    # and then `0.7%` for the same 215 pairs, two lines apart, and no gate could see either.
    "route_order_disagreeing_pct": (
        ("app/src/lib/routePair.ts", "({v:.2f}%, excluding"),
        ("app/src/lib/routePair.ts", "wrong route for that {v:.2f}%"),
        ("docs/architecture/pipeline.md", "({v:.2f}%, excluding"),
        ("docs/architecture/pipeline.md", "wrong route for that {v:.2f}%"),
        ("docs/data/invariants.md", "({v:.2f}%, excluding"),
        ("docs/data/invariants.md", "wrong route for that {v:.2f}%"),
    ),
    # The no-annotation share, always against the DRAWING population. Three of the five needles
    # name that population in so many words; the `crossover.ts` and `system.md` two pin the
    # sentence around the figure instead, which binds those files just as hard but does not
    # carry the noun -- so this is not "every needle names it". A false universal inside the
    # gate whose job is catching false statements about figures is the defect at :313 one
    # screen up, and it is the same one.
    "crossover_routes_drawing_none_pct": (
        (
            "app/smoke.sh",
            "{crossover_routes_drawing_none} of the {crossover_routes_drawing} routes whose "
            "chart draws ({v:.1f}%)",
        ),
        (
            "app/src/components/AircraftMixChart.test.tsx",
            "{crossover_routes_drawing_none} of the {crossover_routes_drawing} real routes "
            "whose chart draws ({v:.1f}%)",
        ),
        (
            "app/src/lib/chart/crossover.test.ts",
            "{crossover_routes_drawing_none} of the {crossover_routes_drawing} routes whose "
            "chart draws ({v:.1f}%)",
        ),
        (
            "app/src/lib/chart/crossover.ts",
            "{crossover_routes} carry an annotation and {crossover_routes_drawing_none} "
            "({v:.1f}%) do not",
        ),
        ("docs/design/system.md", "**{crossover_routes_drawing_none} ({v:.1f}%)**"),
    ),
    # THE CARRIER GAUGE SPREAD (#182), and the reason this module learned decimals. `172.3`
    # was stated in seven files as the trailing-12 figure for a ramp the chart draws over the
    # FULL window, and it had moved to 172.2 besides -- two different wrongnesses in one
    # number, neither visible to a gate. Every site now quotes the window it describes.
    "gauge_a321nxlr_full_low": (
        ("app/src/app/aircraft/[name]/page.tsx", "B6's {v:.1f}"),
        ("app/src/components/AircraftMixChart.test.tsx", "B6's {v:.1f}"),
        ("app/src/components/AircraftMixChart.tsx", "B6's {v:.1f}"),
        ("app/src/lib/chart/aircraftMix.ts", "B6 {v:.1f} seats per departure"),
        ("app/src/lib/chart/aircraftMix.ts", "A321nXLR spans B6 {v:.1f}"),
        ("docs/design/system.md", "| A321nXLR | B6 {v:.1f} |"),
        ("docs/product/features.md", "B6 at {v:.1f} seats/departure"),
    ),
    "gauge_a321nxlr_full_high": (
        ("app/src/app/aircraft/[name]/page.tsx", "F9 fits {v:.1f} seats"),
        ("app/src/components/AircraftMixChart.test.tsx", "F9 fits {v:.1f} seats"),
        ("app/src/components/AircraftMixChart.tsx", "F9 {v:.1f} seats in"),
        ("app/src/lib/chart/aircraftMix.ts", "departure to F9 {v:.1f}"),
        ("app/src/lib/chart/aircraftMix.ts", "-> F9 {v:.1f}"),
        ("docs/design/system.md", "| F9 {v:.1f} |"),
        ("docs/product/features.md", "F9 at {v:.1f}"),
    ),
    "gauge_a321nxlr_full_spread": (
        ("app/src/lib/chart/aircraftMix.ts", "({v:.1f} seats,"),
        ("docs/design/system.md", "**{v:.1f} seats ({gauge_a321nxlr_full_spread_pct:.0f}%)**"),
    ),
    "gauge_a321nxlr_full_spread_pct": (
        ("app/src/app/aircraft/[name]/page.tsx", "a {v:.0f}% spread"),
        ("app/src/lib/chart/aircraftMix.ts", "seats, {v:.0f}%,"),
        ("docs/product/features.md", "a {v:.0f}% spread"),
    ),
    "gauge_a320_12_full_low": (
        ("app/src/lib/chart/aircraftMix.ts", "A320-1/2 spans MX {v:.1f}"),
        ("docs/design/system.md", "| A320-1/2 | MX {v:.1f} |"),
    ),
    "gauge_a320_12_full_high": (
        ("app/src/lib/chart/aircraftMix.ts", "MX {gauge_a320_12_full_low:.1f} -> G4 {v:.1f}"),
        ("docs/design/system.md", "| G4 {v:.1f} |"),
    ),
    "gauge_a320_12_full_spread": (
        ("docs/design/system.md", "| G4 {gauge_a320_12_full_high:.1f} | {v:.1f} |"),
    ),
    "gauge_b737_8_full_low": (
        ("app/src/app/aircraft/[name]/page.test.tsx", "down to AS {v:.1f}"),
        # ONE needle over the whole clause, not a value-free "B737-8 spans" beside a bare
        # number: a needle with no {v} in it is the deletable-green shape -- it can never
        # refuse anything, so it is coverage on paper only.
        ("app/src/lib/chart/aircraftMix.ts", "B737-8 spans AS {v:.1f}"),
        # TWO DECIMALS in the table cell, alone among its six gauge figures: this type's two
        # least-dense operators are closer together than a tenth, so a drift too small to move
        # a one-decimal figure can still change which carrier the cell should name. Whether a
        # given swap crosses a rounding boundary is luck -- today's pair happens to fall either
        # side of one, which is why the two needles above can stay at one decimal.
        ("docs/design/system.md", "| B737-8 | AS {v:.2f} |"),
    ),
    # The SAME near-tie, one population over. The two-orderings sentence is about the chart's
    # five BANDED carriers, so binding it to the all-operator minimum above was the population
    # mismatch gauge_b737_8_banded_high exists to avoid, left on the light end only.
    "gauge_b737_8_banded_low": (
        ("docs/design/system.md", "the least dense of the five (**{v:.2f}**)"),
    ),
    "gauge_b737_8_full_high": (
        ("app/src/lib/chart/aircraftMix.ts", "-> XP {v:.1f}"),
        ("docs/design/system.md", "| XP {v:.1f} |"),
        # The window-flip rule states BOTH ends of the flip. SY's half is gauge_b737_8_t12_high
        # and XP's half is this one, in the same sentence -- a second site in this file, which
        # the reverse scan cannot find for a decimal.
        ("docs/design/system.md", "**XP {v:.1f}** over the full window"),
    ),
    "gauge_b737_8_full_spread": (
        ("docs/design/system.md", "| XP {gauge_b737_8_full_high:.1f} | {v:.1f} |"),
    ),
    # Finding 4 of the #182 review: XP's half of the window-flip rule sat inside
    # gauge_b737_8_full_high and SY's half was pinned nowhere, so SY losing the trailing 12
    # would leave two files stating a false fact with every gate green.
    "gauge_b737_8_t12_high": (
        ("app/src/lib/chart/aircraftMix.ts", "there is SY {v:.1f}"),
        ("docs/design/system.md", "**SY {v:.1f}**"),
    ),
    # The two-orderings passage. Its population is the chart's five BANDED carriers, not every
    # operator of the type, so these are their own measures rather than a reuse of the spread
    # ends -- reusing gauge_b737_8_full_high would pin XP, which is in Other.
    "seats_b737_8_banded_high_m": (("docs/design/system.md", "(**{v:.1f} M seats**)"),),
    "seats_b737_8_banded_low_m": (("docs/design/system.md", "the fewest (**{v:.1f} M**)"),),
    "gauge_b737_8_banded_high": (("docs/design/system.md", "cabin (**{v:.1f}** seats/departure)"),),
    # The evidence for the every-carrier predicate, stated beside that predicate in the SQL
    # that uses it: 51 departures is what sets the A320-1/2's light end, and a reader deciding
    # to "tidy" the measure down to the banded carriers needs to see the number it would drop.
    "gauge_a320_12_full_low_departures": (
        ("sql/03_queries/stats_counts.sql", "MX's {v} A320-1/2 departures"),
    ),
    # The window every gauge figure above is measured over, bound to the dataset rather than
    # typed: it was written as `2026-04` in three files on a 2026-06 warehouse, which is what
    # made "the trailing 12" and "the full window" indistinguishable to a reader.
    "max_year_month": (
        ("app/src/lib/chart/aircraftMix.ts", "full window 2015-01..{v}"),
        ("docs/design/system.md", "full window `2015-01 → {v}`"),
        ("docs/product/features.md", "full window 2015-01 → {v}"),
    ),
}


class _NeedleFormat(string.Formatter):
    """How a measure renders inside a needle.

    With no format spec a value renders the way this repo WRITES it: an int in its comma form,
    a string (`max_year_month`) as itself. A DECIMAL has no such default and must carry an
    explicit spec -- `{v:.1f}`, `{v:.0f}` -- for two reasons. A bare `{v}` on 175.9158 would
    render the full binary expansion and match nothing, which is a red that says nothing about
    the prose. And the places are the ASSERTION: the gauge figures this gate covers are quoted
    to one decimal, so a needle rendering `176` would accept `176.0`, `175.9` and `176.4`
    alike, and the wrong tenth -- the exact defect #182 was opened for -- would pass silently.
    An unspecced decimal is therefore refused rather than defaulted."""

    def format_field(self, value: Any, spec: str) -> str:
        if spec:
            return format(value, spec)
        if isinstance(value, int) and not isinstance(value, bool):
            return f"{value:,}"
        if isinstance(value, str):
            return value
        raise ValueError(
            f"{value!r} is a decimal measure, so its needle must state the places it is "
            f"written to (e.g. '{{v:.1f}}'). A bare '{{v}}' renders the binary expansion, "
            f"and a coarser spec would let a wrong decimal pass."
        )


def _fmt(template: str, value: Any) -> str:
    """Render a needle. `{v}` is the measure's own value; any other `{name}` is another
    measure, so a phrase like `215 of 22,635` moves in BOTH of its halves when the dataset
    does -- a needle that hard-coded the denominator would be a stale literal inside the very
    gate that exists to catch stale literals."""
    others = {k: n for k, n in MEASURES.items() if isinstance(n, int | float | str)}
    return _NeedleFormat().vformat(template, (), {**others, "v": value})


def _flat(text: str) -> str:
    """Collapse whitespace runs to one space.

    Needles are phrases, and these are PROSE files that get rewrapped: `across 532 airports`
    genuinely appears in pipeline.md as `across 532\nairports`. Matching the raw bytes would
    make this gate fail on a reflow -- a false red that trains people to edit the needle
    instead of reading it. Markdown emphasis is not stripped, so a needle must be written the
    way the sentence actually reads."""
    return re.sub(r"\s+", " ", text)


def _scanned_files() -> list[Path]:
    out: list[Path] = []
    for d in SCANNED_DIRS:
        out += [p for p in (ROOT / d).rglob("*") if p.is_file() and p.suffix in SCANNED_SUFFIXES]
    out += [ROOT / f for f in SCANNED_FILES]
    return [p for p in out if not any(s in p.as_posix() for s in SKIP)]


def test_every_registered_file_states_the_current_value():
    """Forward. A registered file that has stopped stating the current value has drifted."""
    for key, files in STATED.items():
        want = f"{MEASURES[key]:,}"
        for rel in files:
            path = ROOT / rel
            assert path.exists(), f"{rel} is registered for {key} but does not exist"
            assert want in path.read_text(), (
                f"{rel} no longer states the current {key} ({want}). If the dataset moved, "
                f"`make stats` has already gone red -- sweep the literal here. Never edit the "
                f"artifact to match the prose."
            )


def test_every_anchored_site_states_the_current_value():
    """Forward, for the sub-1,000 measures, matched on the phrase that pins the meaning."""
    for key, sites in ANCHORED.items():
        for rel, template in sites:
            needle = _fmt(template, MEASURES[key])
            path = ROOT / rel
            assert path.exists(), f"{rel} is registered for {key} but does not exist"
            assert _flat(needle) in _flat(path.read_text()), (
                f"{rel} does not contain {needle!r}. Either {key} moved and the literal needs "
                f"sweeping, or the sentence was reworded and this needle needs updating -- "
                f"check which before editing, they are different failures."
            )


def test_no_unregistered_file_states_a_gated_value():
    """Reverse. A file that states a gated figure without being registered is a site nothing
    would catch going stale -- which is exactly how this family drifted in the first place.

    Runs only for the comma-formatted values. `_fmt` is not used here: this asks the blunter
    question "does this number appear at all", so an unregistered site is caught however it is
    phrased."""
    files = _scanned_files()
    for key, registered in STATED.items():
        want = f"{MEASURES[key]:,}"
        assert "," in want, f"{key} is too short to scan for; register it in ANCHORED instead"
        pattern = re.compile(rf"(?<![\d,.]){re.escape(want)}(?![\d,.])")
        for path in files:
            rel = path.relative_to(ROOT).as_posix()
            if pattern.search(path.read_text()) and rel not in registered:
                raise AssertionError(
                    f"{rel} states {want} ({key}) but is not registered in STATED, so nothing "
                    f"would catch it going stale on the next refresh. Add it to the manifest."
                )


def test_a_decimal_needle_must_state_the_places_it_is_written_to():
    """The half of the decimal support that no manifest entry can prove.

    `_fmt("{v}", 175.9158)` rendering `176` would make every gauge needle accept any figure
    that rounds to the same integer -- and #182 was opened for a stated `172.3` against a
    measured `172.2`, a defect exactly one tenth wide. So a bare `{v}` on a float is refused
    rather than defaulted, and the spec-carrying forms render what the prose writes."""
    import pytest

    with pytest.raises(ValueError, match="must state the places"):
        _fmt("{v}", 175.9158)
    assert _fmt("{v:.1f}", 175.9158) == "175.9"
    assert _fmt("{v:.2f}", 0.9499) == "0.95"
    assert _fmt("{v:.0f}", 30.7356) == "31"
    # Ints and strings keep rendering the way the repo writes them, with no spec at all.
    assert _fmt("{v} of {sitemap_routes}", 215) == f"215 of {MEASURES['sitemap_routes']:,}"
    assert _fmt("{v}", MEASURES["max_year_month"]) == MEASURES["max_year_month"]


def test_the_manifest_names_only_real_measures():
    """A typo'd key would make its whole block silently unenforced -- every loop above is keyed
    on the manifest, so a key the artifact does not carry simply never gets checked."""
    for key in (*STATED, *ANCHORED):
        assert key in MEASURES, f"{key} is not a measure in stats.generated.json"
