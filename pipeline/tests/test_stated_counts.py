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
from pathlib import Path

ROOT = Path(__file__).parents[2]
MEASURES: dict[str, int] = json.loads(
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
        "app/src/proxy.ts",
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
        "app/src/lib/routePair.test.ts",
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
    "route_health_rows": (
        "app/src/app/watch/[preset]/page.test.tsx",
        "app/src/app/watch/[preset]/page.tsx",
        "app/src/lib/watch.test.ts",
        "docs/architecture/hosting.md",
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
    "same_airport_filings": (
        "app/src/app/airport/[code]/endpoints.ts",
        "app/src/app/explore/page.test.tsx",
        "app/src/lib/pivot/render.ts",
        "app/src/lib/routePair.test.ts",
        "docs/architecture/hosting.md",
        "docs/architecture/pipeline.md",
        "docs/data/invariants.md",
        "pipeline/pivot.py",
    ),
}

# Measures under 1,000. Their digits are not distinctive -- `532` is also Cloudflare error 530's
# neighbour in deploy.md, and `-215.2` is Guam's longitude in invariants.md -- so scanning for
# them bare would either miss real sites or flag unrelated numbers. Each site is registered with
# the PHRASE that pins the meaning, and these are gated FORWARD ONLY. Stated rather than
# implied: a new file stating `532` without being added here goes unnoticed. Widening the scan
# to bare three-digit numbers would flag every line number and percentage in the repo, which is
# worse than the gap.
ANCHORED: dict[str, tuple[tuple[str, str], ...]] = {
    "route_order_disagreeing_pairs": (
        ("CLAUDE.md", "{v} of {sitemap_routes} pairs"),
        ("app/smoke.sh", "{v} of {sitemap_routes} pairs"),
        ("app/src/app/explore/page.test.tsx", "{v} of {sitemap_routes} pairs"),
        ("app/src/app/route/[pair]/page.test.tsx", "{v} routes where id"),
        ("app/src/app/route/[pair]/page.tsx", "{v} routes where the"),
        ("app/src/lib/entityFacts.ts", "{v} of {sitemap_routes} routes"),
        ("app/src/lib/entityLink.ts", "{v} of {sitemap_routes} pairs"),
        ("app/src/lib/routePair.test.ts", "{v} of {route_pairs_with_same_airport} routes"),
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
}


def _fmt(template: str, value: int) -> str:
    """Render a needle. `{v}` is the measure's own value; any other `{name}` is another
    measure, so a phrase like `215 of 22,509` moves in BOTH of its halves when the dataset
    does -- a needle that hard-coded the denominator would be a stale literal inside the very
    gate that exists to catch stale literals."""
    others = {k: f"{n:,}" for k, n in MEASURES.items() if isinstance(n, int)}
    return template.format(v=f"{value:,}", **others)


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


def test_the_manifest_names_only_real_measures():
    """A typo'd key would make its whole block silently unenforced -- every loop above is keyed
    on the manifest, so a key the artifact does not carry simply never gets checked."""
    for key in (*STATED, *ANCHORED):
        assert key in MEASURES, f"{key} is not a measure in stats.generated.json"
