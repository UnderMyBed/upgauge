# The design system

Resolved output of the design session. [`brief.md`](brief.md) states the problem and the
constraints; **this file owns the answer** — tokens, components, chart and map encodings,
states. Working mockups with real numbers: [`mockups/`](mockups/).

Product truths that constrain this (mono numerics, `DATA AS OF`, density, permalinks,
honest labels) live in [`../product/overview.md`](../product/overview.md) and are not
restated here.

---

## The decision: an instrument, not a sectional

Three directions were built and compared on the same screen (`/airport/PDX`, top routes,
real data): a **VFR sectional**, an **instrument panel**, and a **filed record**. The brief
floated the sectional first. It lost, and the reason matters more than the verdict:

**A sectional's buff paper and magenta ink encode terrain and airspace for navigation. We
encode capacity over time.** Adopting the palette meant hue immediately started doing
carrier-*identity* work rather than measurement work — the exact failure the map rule
already forbids ("encode in the arc's rendering, not hue alone"). Warm paper plus one accent
also lands next to the brief's own anti-goal. It looked like aviation; it didn't argue like
this product.

The **filed record** direction produced the best honesty apparatus — a reason-code gutter
that makes a caveat structural to the row — but as a whole it was the safe answer:
near-white, ruled, zebra-striped is the hairline-broadsheet look the brief names as an
anti-goal.

**The instrument won because its signature does work in every row instead of explaining
it.** A fixed gauge axis makes the product's namesake measure the first thing you read, and
it puts SkyWest's `PDX–SEA` at 73.6 seats/departure visibly outside a mainline cluster near
170 before you read a digit. Two ideas were grafted in from the losers: the reason-code
gutter, and the sectional's legend rail. Both are separable from their parent's palette —
one is a table column, the other a panel.

> **Don't re-litigate the sectional.** It was built, rendered against real data, and
> rejected on a specific ground: it makes hue carry identity. If a future change wants
> warmth, it must first answer what colour is then free to mean.

---

## Tokens

### Colour — six neutrals, two semantic, and a rule

**Hue is reserved for state. Data is encoded by position and weight.** That is what makes
"survives grayscale and a screenshot" true by construction rather than aspirational, and it
means a red mark on this site always means exactly one thing.

| Token | Value | Job | Contrast on `--panel` |
|---|---|---|---|
| `--panel` | `#F0F2F1` | Page surface | — |
| `--panel-2` | `#E5E8E6` | Zone bands, row hover | — |
| `--field` | `#FAFBFA` | Inputs, legend rail, raised surfaces | — |
| `--ink` | `#15181A` | Primary text, data marks | **15.86:1** AAA |
| `--ink-2` | `#5C6367` | Secondary text, labels | **5.44:1** AA |
| `--ink-3` | `#666E71` | Axis labels, hints, tertiary | **4.63:1** AA |
| `--rule` | `#D6DAD8` | Table hairlines, chart grid | — |
| `--rule-2` | `#828A8B` | Input borders, engraved edges | **3.13:1** (non-text UI) |
| `--signal` | `#0B6E63` | `DATA AS OF`, links, focus ring | **5.45:1** AA |
| `--limit` | `#A8322A` | **Out-of-limit only** | **5.92:1** AA |

Ratios are measured, not assumed. `--ink-3` and `--rule-2` were both darkened during the
session after the first values (`#8B9296` at 2.81:1, `#B4BBB8` at 1.74:1) failed — the
originals were being used for axis labels and input borders, so they were real defects.

**`--limit` is never decorative.** It marks quarantined rows, zero-passenger filings, and
failed invariants. Nothing else. **`DATA AS OF` is therefore `--signal`, not `--limit`** —
the brief asks for it in the accent colour, and freshness is not an error condition.

### Type

**IBM Plex Sans + IBM Plex Mono.** Engineered rather than neutral, drafting-adjacent, and
Plex Mono has true tabular figures. Pin both with `next/font` — no CDN link, per the
portability rule.

Mono is not only for numbers. **Anything that is an identifier is mono**: route pairs
(`PDX–DFW`), carrier codes (`AS`), airport codes, aircraft type codes, month keys
(`2026-04`), and URL keys. Prose is sans.

| Role | Size | Weight | Notes |
|---|---|---|---|
| Entity code | 34px | 600 | mono |
| Stat value | 20px | 500 | mono, `tnum` |
| Body | 13px | 400 | sans |
| Table cell | 12.5px | 400/500 | mono for identifiers |
| Meta / hint | 11px | 400 | `--ink-2` |
| Column + section label | 9.5px | 500 | uppercase, `letter-spacing: .14em` |
| Axis label | 8.5px | 400 | mono, `--ink-3` |

Every numeric cell: `font-variant-numeric: tabular-nums`, `font-feature-settings: "tnum" 1`,
right-aligned, fixed decimals. Load factor is always 2dp with a `%`. Gauge is always 1dp.
Counts are integers with thousands separators.

### Layout and density

- Page max width **1200px**, 20px gutters.
- Main grid: `minmax(0,1fr) 214px` with a 24px gap — content plus legend rail. The rail
  collapses below **920px**.
- **Table row height 22px.** Hairline `--rule` between rows, `--ink` under the header. No
  card containers, no rounded corners, no drop shadows anywhere.
- Vertical rhythm between blocks: 12/16/22px. Section heads are a `--ink` hairline with a
  9.5px uppercase label sitting on it.

---

## Components

### The data table

Column order is fixed: **gutter · identifiers · additive measures · derived measures ·
counts · gauge rail · sparkline.** Identifiers left, everything numeric right.

Rows below the 30-departure floor are **rendered, never hidden**: dashed bottom rule,
`--ink-2` text, and a separator row labelled *"Below the 30-departure floor — reported,
never scored or ranked."* They sort to the bottom and are excluded from ranking, not from
sight.

**The floor treatment requires a departure count to have been queried. Absence is not zero.**
The pivot templates emit only the measures a query selected, so `departures_performed` is
missing entirely from any permalink that did not ask for it — including the invalid-permalink
page's own "known-valid query" link (`m=seats`). Reading that absence as `0` marked **100% of
rows** below floor: every row dashed and muted, an `n` in every gutter cell, and the muted
gauge tick throughout — a false claim about the data on the surface this system calls the
trust moment, and a direct violation of the rule `app/src/lib/format.ts` opens with (*"Null is
absence, zero is a measurement. Never render one as the other."*). A row whose departure count
was never queried makes no claim about the floor in either direction.

**A dimension cell shows the code; the name is the `abbr` expansion.** The table is dense by
rule, and a full carrier or airport name in every row would swamp a column sized for two or
three letters, so `op_airline_id` renders `DL`, not "Delta Air Lines" — the name is reachable
as the `abbr` element's `title`, not printed. Where a dimension has no code of its own (city
market), the name **is** the value and renders directly, since hiding it in a title no
keyboard user can reach would be worse than the density cost. `route` collapses its two
airport-id columns into one `PDX–SEA` cell. An id absent from the catalog (never expected in
production, but the contract must still degrade honestly) renders as the raw id, never a
dash — absence of a name is not absence of data. Every carrier and airport code shown is
**current identity, not a point-in-time filing** — `dim_carrier`/`dim_airport` hold only the
present-day code (`docs/data/invariants.md`'s "Entity resolution" section) — so the legend
rail states this on every view rather than letting a resolved code masquerade as a
historical fact.

### The gauge rail — signature, 1 of 3

A fixed **0–260 seats-per-departure** axis rendered in every row, with grid lines at 50s and
one 2px `--ink` tick at the row's value. Faint `--panel-2` bands mark **<110 (regional)** and
**>210 (widebody)**; the bands are labelled, the tick is never coloured. Position does the
encoding, so it survives grayscale.

The axis is shared across every row of a table, which turns the column into a one-dimensional
scatter of the fleet. That is the differentiator the product is named for, visible without
reading.

### The reason-code gutter — signature, 2 of 3

A 22px left column carrying one mono glyph per row, in `--limit`:

| Code | Meaning |
|---|---|
| `⌀` | Filed departures carrying zero passengers. A real filing, not a gap |
| `n` | Below the 30-departure floor — reported, never scored (rendered in `--ink`, not `--limit`) |
| `Q` | Quarantined: failed an invariant. Excluded from totals, never clamped |

**The caveat is a column, not a tooltip.** Given how much of this data is edge cases, the
apparatus has to survive a screenshot.

**The gutter glyph and the below-floor row treatment (dashed rule, `--ink-2` text, muted
gauge tick) are independent signals, not one collapsed state.** A row can be below floor
*and* zero-pax at once — measured over the trailing 12 months at route grain: 21,569 rows
total, 13,470 below floor, 3,278 zero-pax, and 3,202 of those are both, i.e. **97.7% of every
zero-pax row is also below floor.** The gutter still shows exactly one glyph, chosen by
severity — `Q` > `⌀` > `n` — but the below-floor row treatment applies whenever the row is
below floor, regardless of which glyph won. Gating row treatment on the glyph instead of on
the floor check directly is the bug this note exists to prevent: it silently drops the
below-floor signal from nearly the entire zero-pax class.

### The legend rail — signature, 3 of 3

A sticky `--field` panel with an `--ink` header bar, present on **every data view**. Groups:
gauge rail · row marks · arc rendering · "reading this". It carries the operating-carrier
grain explanation in the last group.

This is the methodology surface (content-inventory item 8) folded into the product. There is
no separate "how to read this" page to go stale.

### Stat strip

Label above value, no borders between, separated by 22px gaps, bounded by `--rule-2`
hairlines top and bottom. **Derived measures carry a dotted underline** on their label —
the honest-labelling constraint made visual. Always includes a `Quarantined` count, even
when zero: showing a zero is what makes the number credible when it isn't zero.

### Sparkline

72×14px, 1.2px `--ink` polyline, no axis, no fill, min–max scaled to its own row. Thin rows
use `--ink-3`. **A single-point series renders as a dot, never a line** — one month is not a
trend.

---

## Charts

Observable Plot under the hood. These are encoding rules, not library configuration.

### Aircraft-type mix — build this before the load-factor chart

Stacked area, monthly. The six-category problem collides with "hue is reserved", and the
resolution is that **these categories are ordered**: shade the bands along one ramp sorted
by seats per departure, smallest metal lightest.

`--g0 #E3E7E6` (Other) · `--g1 #C8D3D1` · `--g2 #A6B7B4` · `--g3 #7E9793` · `--g4 #4F736E` ·
`--g5 #21514A`

**An upgauge therefore darkens the stack.** On `PDX–DFW`/AA the MD-80s and 737-800s give way
to A321s and then A321neos, and the transition is legible without reading the legend. A
monochrome ramp is grayscale-safe by definition.

### Multi-series lines

**No hue at all.** Series are distinguished by weight, dash, and a direct end-label:
2.2px solid → 1.1px solid → 1.1px dashed `4 3` → 1px dotted `1 3`. Same discipline as the
map arcs. Legend rail carries the key.

Rolling-12 is the default view; Month is the toggle. Gaps are gaps — a carrier that stops
filing breaks the line rather than interpolating across the absence.

### Two standing rules

- **COVID is drawn, not hidden.** A `--panel-2` band across 2020-03 → 2021-06, labelled
  *"COVID — in window on purpose."* The window includes it deliberately; the chart should
  say so.
- **Annotations must be derived, never hand-written.** The mockup's *"A321 overtakes
  737-800 · 2018"* is computed from the yearly mix (2017: 84% vs 15%; 2018: 51% vs 48%). A
  hand-typed annotation rots silently the first month the data moves.

---

## The map

deck.gl `GreatCircleLayer` over a **Natural Earth coastline GeoJSON** — no tiled basemap,
ever. (The committed mockup substitutes the 737 filing airports as dots, so it depends on no
external file; production draws the coastline.)

### Projection

**Composite Albers USA.** Conterminous conic (standard parallels 29.5/45.5, central meridian
−96), plus **labelled insets for Alaska and Hawai'i**. This is not cosmetic: letting AK and
HI into a single fit compresses the lower 48 into an unreadable smear — it was tried.

Note for implementers: raw Albers grows northward while screen `y` grows down. The `y` term
must be negated or the country renders upside down.

**An arc crossing a panel boundary cannot be a great circle**, so `PDX–ANC` and `PDX–HNL` are
drawn as straight lines into their inset, and the page says so. Every US map makes this
compromise; this one admits it.

### Arc encoding

| Channel | Encodes |
|---|---|
| Stroke width `0.7 + 2.9·√(seats/max)` | Seats |
| Dash `5 3` | Load factor < 70% |
| Dotted `1 3`, `--ink-3`, 1px | Below the 30-departure floor |
| Opacity 0.62 (0.75 for thin) | Overlap legibility |

Never hue. Thin arcs draw first so heavy ones sit on top. Destination nodes are 2px `--ink`
(1.3px `--ink-3` below floor); the origin is a 4.5px `--field` disc ringed in `--signal`.

### The year slider

**The one orchestrated motion moment.** A 2015→2026 track that animates the network growing
and contracting. Nothing else on the site animates. Honours `prefers-reduced-motion` by
jumping between years instead of tweening.

---

## The Explorer

**The dimension and measure vocabulary is rendered from the catalog** —
`meta_pivot_dimensions` and `meta_pivot_measures` — never hand-listed in the UI. The chips
cannot drift from the allowlist the server validates against, and a dimension added to the
catalog appears without a front-end change.

- Each builder row is labelled with **its URL key** (`k` `g` `d` `m` `t` `f` `s` `n`), so a
  reader learns the permalink format from the interface. Hand-editing a link is what this
  audience does.
- **Derived measures render as dashed chips** and expose their SQL expression on hover.
- The permalink bar is `--signal`-bordered and always visible, showing the real encoded
  string. It is generated by the same codec the server validates with — see
  `pipeline/urlstate.py` and the goldens in `sql/03_queries/goldens/`.
- **Every row ends in a `rows →` drill** to the raw filed rows behind it. Non-negotiable:
  insights that can't be drilled into feel like astrology.
- CSV and Parquet export sit on the result header, not in a menu.

> **Open, deliberately.** Under `grouping="mainline"` a carrier filter still targets the raw
> `op_airline_id`, so a rolled-up row can show more seats than the filter returns. The
> mockup shows **Operating** and takes no position. Current behaviour is pinned by the
> `mainline_grouped_with_carrier_filter` golden; M3b must decide it rather than inherit it.

---

## Entity pages: `/route/<pair>` — shipped, M4b

The first entity page, and the shape the rest (`/airport`, `/carrier`, `/aircraft`) follow.
Composes components already specified above rather than inventing new ones — same top bar,
same `DATA AS OF` badge, same data table, same legend rail:

```
UPGAUGE                                    DATA AS OF 2026-04
─────────────────────────────────────────────────────────────
JFK–LAX     John F Kennedy Intl · Los Angeles Intl
            2025-05 → 2026-04

  SEATS      PASSENGERS   LOAD FACTOR   AVG GAUGE   DEPARTURES  CARRIERS
  3,455,820  2,998,796    86.78%        170.4       20,283      5
─────────────────────────────────────────────────────────────
  [ carriers table — DataTable, one row per operating carrier, sorted by seats desc ]
  Open in the Explorer →
─────────────────────────────────────────────────────────────
  [ legend rail ]
```

- **Title block.** The pair, rendered with an **en dash** (`JFK–LAX`, U+2013 — never a
  hyphen: the URL's `-` is a path separator, the display glyph is typographic), followed by
  both airport names joined with `↔`.
- **Stat strip** (reuses the Stat strip component above). `LOAD FACTOR` and `AVG GAUGE`
  carry the derived marker (dashed, `--ink-2`) and are computed from the summed `SEATS` /
  `PASSENGERS` / `DEPARTURES` of the rows below, never averaged from a per-carrier column —
  the same rule the data table itself follows, applied to a page total. If the carrier count
  ever reaches the page's limit, a disclosure line states the totals cover the listed
  carriers only, rather than silently under-reporting.
- **Table.** The standard data table, one row per operating carrier, trailing 12 months,
  sorted by seats descending. Empty state (two real airports, no scheduled service in the
  window) keeps the title block and stat strip, states the finding in words, and offers the
  widened-to-2015 window — the entity-page version of the Explorer's own empty state, above.
- **Explorer link.** The page's query is an ordinary `PivotQuery`, so the link is the same
  permalink encoder the Explorer itself uses — "every insight row is one click from the raw
  rows that produced it" applied to the whole page, not just a row.
- **Legend rail**, unchanged from the Explorer's.

Canonical-URL handling (redirect, 404, en-dash rendering) is a routing concern, not a design
one — full contract in
[`../architecture/pipeline.md` § M4b](../architecture/pipeline.md#m4b--the-route-page).

---

## States

A table that only looks right when full is a table that looks broken most of the time. All
of these are **normal** in T-100.

| State | Treatment |
|---|---|
| **Loading** | Skeleton rows at exact 22px height so nothing reflows. Never a spinner. |
| **Empty (valid query, no rows)** | Keep the header, stat strip and legend rail. State the query in words and offer the nearest broader window. Never a blank panel. |
| **Sparse** (below the 30-dep floor) | Dashed rule, `n` gutter code, `--ink-2`, sorted below scored rows, excluded from ranking. |
| **Zero passengers** | `⌀` gutter code. Load factor renders `0.00%`, not `—`: it flew and carried nobody, which is a fact, not a gap. |
| **Quarantined** | `Q` code, excluded from totals, **count always surfaced** with its reason. Never clamped, never silently dropped. |
| **Carrier stops filing mid-series** | The line breaks. No interpolation across an absence. |
| **Invalid permalink** | A full-page error naming the offending key and the allowed values, with a link to a valid neighbouring query. Never a silent fallback to defaults — a permalink that quietly renders a different query than it encodes is worse than one that errors, because the screenshot still looks authoritative. |
| **`health_score IS NULL`** | Renders as **"insufficient data"**, visually distinct from a low score, and never sorts to the bottom of the range. Three distinct causes, and the largest today is *no prior window* — a route that didn't exist yet. For the zero-scheduled-departures group, **still show the four known components** even though the composite can't be computed. See [`../product/features.md`](../product/features.md). |

---

## Specified, not mocked

These reuse components above and were specified rather than built. Concrete enough to
implement without another design pass.

### Seasonality heatmap

Year × month grid, one row per year, 12 columns. Cells are **`--panel` → `--g5` on the same
gauge ramp**, so it reads as one family with the fleet chart. Cell 22px tall to match table
rows, 1px `--panel` gutters. Month initials on top, years in mono down the left. **Absent
months are unfilled with a hairline border** — distinct from a filled low value. A legend
strip beneath shows the value range with min and max labelled.

### `/watch` leaderboard

The standard table plus a leading **rank column** (mono, `--ink-3`) and a one-line editorial
frame per preset — the only place on the site with a voice. Each row carries the **component
values, not just the composite score**: the components are the insight, the score is a sort
key. Label the score plainly as a heuristic.

Every row links into the Explorer with its filters pre-applied — the `/watch` presets are
saved instances of the Top-N builder, so their links are ordinary permalinks.

Route Birth Tracker rows must read **"first appearance since 2015"**, never "first ever". The
window starts in 2015.

### OG / social card

1200×630, generated per entity at build time. Same tokens, no webfont dependency at render
time (subset or draw with the system stack).

Layout: entity code in mono at ~120px top-left · entity name beneath in `--ink-2` · **one
headline number** with its label · a bare sparkline or the gauge rail across the lower third
· `DATA AS OF YYYY-MM` bottom-right in `--signal` · `UPGAUGE` wordmark bottom-left. No
gradient, no photograph, no chrome.

The unfurl is a different problem from the screenshot and it fires first — a pasted link
unfurls before anyone sees a screenshot.

---

## Quality floor

Unannounced, non-negotiable.

- **Focus** is a 2px `--signal` outline at 1px offset, on every interactive element. Never
  removed.
- **Reduced motion**: the year slider steps instead of tweening; nothing else moves.
- **Responsive**: the legend rail collapses below 920px and moves beneath the content.
  Tables scroll horizontally within their own container — the page body never does.
- **Contrast**: every text token measured above. Non-text UI boundaries ≥ 3:1.
- Charts carry `role="img"` and a real `aria-label` describing what the series are.
- Colour is never the sole channel for any distinction, in any chart or map.

---

## Mockups

[`mockups/`](mockups/) — four self-contained HTML files, no external assets beyond the two
webfonts, openable with `file://`.

| File | Shows |
|---|---|
| `table.html` | The workhorse table, gauge rail, gutter, legend rail |
| `entity-route.html` | `/route/PDX-DFW`: fleet-mix area, LF lines, carrier table |
| `map-network.html` | `/airport/PDX`: arcs, insets, year slider |
| `explorer.html` | The pivot builder, catalog-driven chips, real permalink |

**Every number in them is queried from `upgauge.duckdb`, frozen at `DATA AS OF 2026-04`.**
They are a design reference, not a live view, and not a build artifact — nothing imports
them. When the design changes, change the mockup and this file together.
