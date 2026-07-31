# M4c — the aircraft-type-mix chart

**Status:** design approved 2026-07-31. Implementation follows via
`docs/superpowers/plans/2026-07-31-m4c-aircraft-mix-chart.md`.

**Goal.** Put the project's first chart on `/route/<pair>`: a server-rendered stacked area of
seats by aircraft type over the full window, shaded so that an upgauge darkens the stack.

This is deliberately the first chart built. `CLAUDE.md`'s workflow rule: *"Build the
aircraft-type-mix chart before the load-factor chart. Everyone does load factor; the gauge
story is the differentiator."* `docs/design/system.md` § Charts already owns the encoding —
this spec does not re-decide it, it records what was measured and what the encoding implies
for the code.

---

## What ships

A reusable server component rendering a stacked area chart, mounted on `/route/<pair>` between
the stat strip and the carriers table, plus its legend-rail entry.

Reusable is not speculative generality: M4d mounts the same component on `/aircraft` and
`/carrier`. Its props are a row set and a title — it does not know what entity it is describing.

## Data

No new SQL, no new catalog entries. The existing pivot answers this directly:

| | |
|---|---|
| grain | `segment` (`aircraft_type` is segment-only in `meta_pivot_dimensions`) |
| dimensions | `year_month`, `aircraft_type` |
| measure | `seats` |
| window | full — `2015-01` → `2026-04` (136 months, measured) |
| filter | the route, via the composite `route` dimension M4b added |

`aircraft_type` joins `dim_aircraft_type` on `code` and displays `short_name`. Measured:
**zero** aircraft types present in `fct_segment_month` lack a `short_name`, so the display path
has no fallback case to design around. (`code` itself is useless for display — `612` is the
737-700, not the A321; that was an M4a finding.)

Quarantined rows are already excluded by the measure expression
(`SUM(seats) FILTER (WHERE NOT is_quarantined)`); the chart inherits that and must not re-filter.

## Encoding — from `docs/design/system.md` § Charts

**Stacked area, monthly, monochrome ramp ordered by seats per departure, smallest metal
lightest.** Tokens already exist in `app/src/app/globals.css:15-16`:

`--g0 #E3E7E6` (Other) · `--g1 #C8D3D1` · `--g2 #A6B7B4` · `--g3 #7E9793` · `--g4 #4F736E` ·
`--g5 #21514A`

**Band membership and band shade are two different orderings, and they genuinely differ.**
This is the single most important implementation detail in this spec, and the easiest to get
wrong by collapsing them into one sort:

- **membership** — which five types get their own band — is by **total seats**, descending.
- **shade** — which of `--g1`…`--g5` each band gets — is by **seats per departure** (gauge),
  ascending, so the lightest band is the smallest metal.

Measured on JFK–LAX over the full window:

| by seats (membership) | | by gauge (shade) | |
|---|---|---|---|
| 1. A321/LR | 17,485,274 | `--g1` A321/LR | 128.1 |
| 2. B767-3/R | 7,852,109 | `--g2` A320-1/2 | 148.4 |
| 3. B767-4 | 3,119,079 | `--g3` B757-2 | 164.2 |
| 4. B757-2 | 2,900,388 | `--g4` B767-3/R | 216.6 |
| 5. A320-1/2 | 2,132,256 | `--g5` B767-4 | 239.2 |

The A321/LR is first by seats and *lightest* by gauge. A single sort produces a chart that
looks plausible and encodes nothing.

Because the ramp is monochrome and ordered, hue is never load-bearing and the chart is
grayscale-safe by construction — which is what satisfies system.md's *"Colour is never the
sole channel for any distinction"* without extra work.

### The "Other" band is not a rounding error

Top-5 + Other covers a **median 94.7%** of seats on routes with more than five types, but
**1,571 of those 4,618 routes fall below 90%, and the worst case is 48.2%** (measured, full
window). On roughly a third of multi-type routes "Other" is a substantial slice.

The ramp is fixed at six tokens, so the resolution is honesty rather than more bands: the
legend rail states how many types Other aggregates and what share of seats it carries, for the
route being viewed. A chart where half the area sits in the lightest band must say so.

### COVID is drawn, not hidden

A `--panel-2` band across `2020-03` → `2021-06`, labelled *"COVID — in window on purpose."*
All 16 of those months are present in the facts (measured). system.md makes this a standing
rule: the window includes COVID deliberately and the chart should say so.

## The derived annotation

system.md: *"Annotations must be derived, never hand-written… A hand-typed annotation rots
silently the first month the data moves."*

**Rule:** annotate the most recent year in which the #1 aircraft type by seats changed from the
previous year — e.g. *"A321 overtakes 737-800 · 2018"*.

**The no-crossover state is the common case, not an edge case.** Measured: only **12,416 of
22,919 routes (54%)** ever change their #1 type. **JFK–LAX — the flagship example — has none:**
the A321/LR leads every year from 2015 to 2026. Its share *falls* from 44.8% to 35.2% as
widebodies arrive, which is a real upgauge story, but it is not a crossover.

So the component renders **no annotation at all** when there is no crossover. It must never
manufacture one, and it must never fall back to labelling the largest type (that is not an
event, and it would appear on every chart, teaching readers to ignore annotations).

Cases the implementation must handle explicitly, each with its own test:

- no crossover in the window → no annotation (JFK–LAX)
- a single aircraft type on the route → no annotation
- two types tied for #1 in a year → not a crossover; ties break deterministically, and a tie
  never emits an annotation
- multiple crossovers → the most recent one only

## Rendering

Server-rendered, per the approved decision: Plot draws into a jsdom `document`, and the
serialized SVG is injected. The chart is present in the served HTML and visible with JS off.

```
Plot.plot({ document, marks: [...] })  →  svg.outerHTML  →  dangerouslySetInnerHTML
```

`@observablehq/plot` (0.6.17, pulling `d3`, `isoformat`, `interval-tree-1d`) and `jsdom`
(29.1.1, already vendored as a devDependency via vitest) both move to production dependencies.
Size is not a constraint here: `CLAUDE.md` commits to an always-on Docker box, not a
scale-to-zero runtime.

This preserves what `/route` already has — measured at 1,353 characters of real server-rendered
text — on the page whose permalinks `CLAUDE.md` calls the entire growth mechanic. The
alternative, a client-side chart, would have reproduced the failure shape M4b found on the 404
page: an empty container in the served HTML.

**Colour tokens reach the SVG as `var(--g1)`-style values**, keeping `globals.css` the single
source. Plot passes ordinal scale values through to the `fill` attribute, so this works for a
categorical scale — but it is unverified against Plot 0.6.17 in this project and must be
confirmed against a served build, not a unit test. If Plot mangles or drops `var()`, fall back
to the literal hex values with a comment naming `globals.css:15-16` as the source of truth and a
test asserting the two agree.

## Accessibility

Per system.md: the chart carries `role="img"` and a real `aria-label` describing the series —
not "chart", but what it shows, which types, and over what window. Numerics in axis labels
follow `CLAUDE.md`'s tabular-figure rule.

## Testing

The project's rule is invariants as failing tests first. For this milestone the layers are:

- **Unit** — band membership vs shade ordering (the two-sort trap, with a fixture where a
  single sort would pass); Other-bucket aggregation; the crossover detector across all five
  cases above.
- **Served build** (`app/smoke.sh`) — this is the tier that matters, and the only one that can
  catch the class of bug that has bitten this project five times. It must assert that `/route/
  JFK-LAX` ships an `<svg>` in its HTML, that the SVG carries the ramp colours, and that the
  page still renders its existing server-side text. A unit test cannot cross Plot + jsdom +
  Next's bundler, which is exactly where this will break if it breaks.

## Risks

1. **Plot + jsdom under Next's server bundler.** The single real unknown. `serverExternalPackages`
   may be needed for jsdom. Establish by building and serving before building anything on top.
2. **`var()` in SVG fill** — see Rendering; verify served, fall back to hex.
3. **Chart size in the HTML.** 136 months × 6 bands of SVG path data on every request, on a
   `force-dynamic` page. Measure the added bytes and record them; if large, that is a finding
   for M4d, which mounts this component three more times.

## Out of scope

The load-factor chart (system.md § Multi-series lines), the seasonality heatmap, the map, and
`/watch`. M4d owns `/airport`, `/carrier` and `/aircraft`, which reuse this component.
