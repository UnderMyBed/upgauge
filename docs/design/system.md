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

### The top bar

The wordmark, the `DATA AS OF` badge, and — as of M5 — a site-wide search field, extracted
into one shared component (`app/src/components/TopBar.tsx`) so the search box has exactly one
home instead of drifting across every page that renders it. `UPGAUGE` in `.mark`, `UP` in
`--ink` and `GAUGE` in `--signal`; the badge in `--signal` (first-class per `DATA AS OF`'s own
token entry, above); the search field a plain `method="GET"` form posting `q` to `/search` —
**no client JS, no `onChange`, no state.** Every view in this product renders and works with
JavaScript off, and the search box is not an exception. Present on every page, including the
four entity pages' `not-found` states and the front door — a 404 still asserts something about
the data (that a query against it would answer nothing), so it keeps the full top bar rather
than treating a 404 as chrome-free.

**The wordmark is a link home**, and it carries `prefetch={false}` — which is load-bearing, not
tidiness. It is the product's only `next/link` (every other internal link is a plain `<a>`; this
one is a `Link` only because `@next/next/no-html-link-for-pages` fires on a statically-resolvable
`href="/"`), it sits above the fold on all ten pages, and `Link`'s default prefetches on
viewport entry. `/` is `force-dynamic` and absent from `proxy.ts`'s matcher, so it carries
`no-store` and the CDN cannot absorb that prefetch — the default would buy one uncached origin
request per page view on a box whose whole cost control is the caching.

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

**Every dimension cell that resolves to a page links to it (M5).** `DataTable`'s
`DimensionCell` is the one chokepoint all five surfaces — `/explore` and the four entity
pages — render their columns through, since they all build `dimKey` the same way
(`allowlist.dims.get(c)?.joinDim ? c : undefined`). Wrapping the cell there in `<a href={
entityHref(dimKey, hit) }>` links every table in the product from one change.
`entityHref` (`app/src/lib/entityLink.ts`) is the single source of truth for whether a cell
links: `null` for a dimension with no entity page (both city markets, `year_month`, `quarter`,
`year`, `origin_state`, `dest_state`, `distance_group`, `aircraft_group`), for an id that never
resolved, and for a resolution with no code — the same three cases that already render bare.
The `<abbr>` carrying the name nests **inside** the `<a>` rather than being replaced by it —
it is the only place a keyboard user reaches the expansion, linked cell or not.

**A fourth case, and it is not a dimension property: a `route` cell whose two halves are the
same airport does not link.** `fct_segment_month` carries 530 such pairs with real traffic
(ORD alone is 73,082 seats over the trailing 12), but `/route/ORD-ORD` is a 404 by design —
`resolveRoutePair` answers *"'ORD' to itself is not a route between two airports"*, and
`sitemap_routes.sql` excludes them for the same reason. The link path was the last place that
did not know, and shipped a link to a guaranteed 404 until M5's final review. The guard lives
in `/explore`'s `routeHref`, beside the alphabetical-by-code sort, because the composite route
cell is the one cell `entityHref` does not own.

**The link is styled with two channels, not one.** Tailwind's preflight resets `a { color:
inherit; text-decoration: inherit }`, so an unstyled `<a>` in a data-table cell renders
pixel-identical to the plain text it replaced — `.data-table td.id a` (`globals.css`) sets both
`color: var(--signal)` **and** `text-decoration: underline`, because colour is never the sole
channel for a distinction (Quality floor) and a link that only differs from body text by hue
fails that for a colour-blind or grayscale reader the same way an uncoloured gauge tick would.

`route`'s cell is the one exception, and it is not a `DimensionCell` at all: its `column_expr`
spans two columns that both resolve through `dim_airport`, so there is no single id to hand
`entityHref`. `/explore` builds its href separately (`routeHref` in `explore/page.tsx`), reading
the two `Resolved` hits directly rather than the joined display string, and passes it as a
**typed `ColumnSpec.href` accessor** (`(row) => string | null`) — not a sibling-field naming
convention on `Record<string, unknown>` (rejected in review: stringly-typed, no compile-time
guard, and wider than the one caller needs) — that `IdentifierCell`, a small generalization of
the same component, calls per row for any non-dimension identifier column that sets one.
**The href is the code-alphabetical pair, never the displayed (airport-id) order**: `/explore`
renders `route_key_low, route_key_high` — airport-id order — and `routeHrefFromCodes` re-sorts
alphabetically by code before building `/route/<pair>`, because the two orderings disagree for
154 of 22,420 pairs (measured; `CLAUDE.md`, M4b). Reusing the displayed order would be wrong
for every one of those 154 — IFP/IAH is one of them: airport-id order displays `IFP–IAH`, but
the canonical `/route/` URL is `/route/IAH-IFP`, the reverse. A fixture built on an
order-agreeing pair like JFK–LAX (22,266 of 22,420) cannot catch that class of bug — both
orderings produce the same, coincidentally correct, href.

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

**Each group is opt-in per view — the rail describes the encodings the page in front of you
actually uses, and no others.** `/explore` gets no arc group because it has no map, and got no
fleet-shading group until M4c put a chart on `/route`. A rail that explains a monochrome gauge
ramp on a page with no ramp is exactly the stale "how to read this" this element exists to
replace, and it costs the reader trust in the groups that *are* relevant.

**The rail carries methodology, never per-subject numbers.** The fleet-shading group states
that one ramp is ordered by seats per departure, that a darkening stack is an upgauge, and
that membership is a *different* ordering — but not how many types "Other" holds on this
route, which belongs on the chart's own swatch. The rail is static and cannot know the
subject; stating a measurement in two places is how the two copies drift.

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

**Axis numerics obey the same rule as every other numeric here: monospaced and
tabular-figure.** Plot's root style hardcodes `font-family: system-ui, sans-serif`, and
`font-variant-numeric` alone does not override it — M4c shipped with the y ticks ("1.2M"), the
year ticks and the annotation's year in the sans face while every other numeric on the page was
Plex Mono. Every chart passes `style: { fontFamily: "var(--font-mono)", fontVariantNumeric:
"tabular-nums" }`; the token, not a literal family, so `globals.css` stays the single source
the way it already is for the `--g*` ramp. The mockups do this with a dedicated `.axl` class.

### Aircraft-type mix — build this before the load-factor chart

**Shipped M4c** on `/route/<pair>`; `/airport`, `/carrier` and `/aircraft` reuse the same
component in M4d. What follows is the encoding rule plus what implementing it taught.

Stacked area, monthly. The six-category problem collides with "hue is reserved", and the
resolution is that **these categories are ordered**: shade the bands along one ramp sorted
by seats per departure, smallest metal lightest.

`--g0 #E3E7E6` (Other) · `--g1 #C8D3D1` · `--g2 #A6B7B4` · `--g3 #7E9793` · `--g4 #4F736E` ·
`--g5 #21514A`

**An upgauge therefore darkens the stack.** On `PDX–DFW`/AA the MD-80s and 737-800s give way
to A321s and then A321neos, and the transition is legible without reading the legend. A
monochrome ramp is grayscale-safe by definition.

**Two orderings, not one.** *Which* five types get a band is by **total seats**, descending.
*Which shade* each band gets is by **gauge**, ascending. These are different sorts of the same
five rows and they genuinely disagree — on JFK–LAX they share only their first element (seats:
A321/LR, B767-3/R, B767-4, B757-2, A320-1/2; gauge: A321/LR, A320-1/2, B757-2, B767-3/R,
B767-4). Collapsing them into one sort produces a chart that looks entirely plausible and
encodes nothing, which is why it is worth stating as a design rule and not only as a code
comment. Bands are stacked in shade order, lightest at the bottom, so the ramp reads as one
gradient rather than six unrelated greys — that gradient is the whole reason the categories are
ordered rather than merely distinguishable. `--g0` is reserved for Other and never assignable
to a type.

**A type that flew nothing has an unknown gauge, and unknown sorts last — never lightest.**
Real, not hypothetical: aircraft type `650` appears on JFK–LAX with 0 seats and 0 departures.
The plausible shortcut (`departures === 0 ? 0 : …`) makes the aircraft that flew nothing the
smallest metal on the chart, a claim about size drawn from no evidence.

**"Other" is not a rounding error, so the chart must disclose it.** Measured over the full
window: top-5 + Other covers a median **94.7%** of seats on routes with more than five types,
but **1,571 of those 4,618 routes fall below 90%, worst case 48.2%**. On roughly a third of
multi-type routes Other is a substantial slice, and on some of them half the area is in the
lightest band. The ramp is fixed at six tokens, so the resolution is honesty rather than more
bands: **how many types Other aggregates and its share of seats are stated on the swatch
itself**, not in the legend rail. That number is per-subject — it differs for every route — and
the rail is static; putting it in both places is how two copies of one measurement drift.

#### The same chart, stacked by something else (M4d)

**The stacking dimension is a parameter, and the words that describe the ramp travel with it.**
`/aircraft/<slug>` is a page that *is* one aircraft type, so the type stack is degenerate there:
one band, whose gauge ordering encodes nothing. It stacks by **operating carrier** instead, which
answers the better question — who adopted this type, and when. `/route`, `/airport` and
`/carrier` keep the type stack.

**The ramp still encodes something, and that is measured, not assumed.** Carriers configure the
same airframe very differently, so ordering carrier bands by seats per departure is a real
encoding rather than a decorative reuse:

**Over the full window `2015-01 → 2026-04`, which is the window `/aircraft` actually draws:**

| type | lightest | darkest | spread |
|---|---|---|---|
| A321/LR | B6 176.0 | F9 230.0 | **54.0 seats (31%)** |
| A320-1/2 | MX 129.3 | G4 181.7 | 52.4 |
| B737-8 | AS 159.8 | XP 187.7 | 27.9 |

**Over the trailing 12 months `2025-05 → 2026-04`** — the window originally measured here, and
the source of the `172.3 → 230.0` pair quoted in prose elsewhere in this repo:

| type | lightest | darkest | spread |
|---|---|---|---|
| A321/LR | B6 172.3 | F9 230.0 | **57.7 seats (33%)** |
| A320-1/2 | AA 150.0 | F9 184.1 | 34.1 |
| B737-8 | AS 159.5 | SY 186.0 | 26.5 |

Both are given because neither alone is the whole claim: the table justifies an encoding the
chart draws over the **full** window, while the figure everyone quotes was measured over the
**trailing 12**, where SY rather than XP tops the B737-8. The spread survives either way, which
is the point — but an unlabelled row is not evidence (`docs/data/invariants.md` § Route identity
records the same lesson about the same-airport counts).

**But it is not the same claim, so it must not carry the same words.** Across aircraft types a
darker band is *bigger metal*. Across carriers of one type it is the *same* metal fitted denser —
on `/aircraft` the ramp isolates **configuration** choice from **fleet** choice, which `/route`
cannot separate. So the chart's key reads "lightest is the least dense cabin" and the legend
rail's swatches read "less dense cabin" / "denser cabin" and "the five **carriers** with the most
seats get a band". A rail explaining metal size next to a chart whose bands are all one airframe
is the stale "how to read this" the rail exists to replace, one level down.

`app/src/lib/chart/aircraftMix.ts`'s `MixDimension` holds the pivot key **and** those sentences
in one object, deliberately: splitting them is how a chart ends up stacked by carrier under a
title and a legend that both say "aircraft type".

**The two orderings do not become one just because the bands changed.** On the 737-800 they are
exact *reverses* — Southwest flies the most of them **and** the densest cabin (593.6 M seats,
175.0 seats/departure), Alaska the fewest and the least dense (104.2 M, 159.8) — so a single sort
mislabels all five swatches rather than four of five. That is the fixture the implementation is
pinned against, precisely because M4c's own version of this test had the two orders coincide and
a single sort passed it.

### Multi-series lines

**No hue at all.** Series are distinguished by weight, dash, and a direct end-label:
2.2px solid → 1.1px solid → 1.1px dashed `4 3` → 1px dotted `1 3`. Same discipline as the
map arcs. Legend rail carries the key.

Rolling-12 is the default view; Month is the toggle. Gaps are gaps — see the standing rule
below, which M4c promoted out of this section because it turned out to bind every time-series
mark, not only lines.

### Three standing rules

- **COVID is drawn, not hidden.** A `--panel-2` band across 2020-03 → 2021-06, labelled
  *"COVID — in window on purpose."* The window includes it deliberately; the chart should
  say so. Implementing it (M4c) settled two details: the band's edges land **on** the 2020-03
  and 2021-06 samples rather than bracketing them — every month is plotted at its first day, so
  a band stopping at 2021-05-31 visibly falls short of the month it names — and it is clamped
  to the chart's own window and **dropped entirely** when the two are disjoint, so a chart
  starting after 2021 never carries a `--panel-2` slab at a meaningless x.
- **Annotations must be derived, never hand-written.** The mockup's *"A321 overtakes
  737-800 · 2018"* is computed from the yearly mix (2017: 84% vs 15%; 2018: 51% vs 48%). A
  hand-typed annotation rots silently the first month the data moves.
  **No annotation is a designed state, not a gap.** Measured: only **12,416 of 22,919 routes
  (54%)** ever change their #1 type, and JFK–LAX — the flagship example — is not one of them.
  So nearly half of all charts carry none, and the chart must never manufacture one, never fall
  back to labelling the largest type (that is not an event, it would appear on every chart, and
  it teaches readers to ignore annotations), and never break a tie to produce one. Three rules
  decide what counts, all of them suppressive: **a tie has no leader** (breaking it gives the
  annotation a direction the reader cannot see, which flips when the row order changes); **a
  leader must have flown** (T-100's zero-seat no-service filings are ordinary, and "X overtakes
  Y" drawn from two zeroes is a claim about nothing); and **a year with no leader is skipped,
  not treated as a wall** — A, then a tied year, then B is a genuine crossover, it is what one
  looks like mid-transition, and it is reported against the later year. Full derivation:
  [`../architecture/pipeline.md` § M4c](../architecture/pipeline.md).
- **Gaps are gaps.** A subject that stops filing **breaks** the mark rather than interpolating
  across the absence — and **zero-filling is not the alternative**: a month with no filing is
  *unknown*, not zero. T-100 is a filing, so "no row" means "nobody filed", which is neither
  "nobody flew" nor "0 seats flew". Drawing either invents data, and the two inventions are
  equally confident-looking under a `DATA AS OF` badge.

  This was written for multi-series lines and M4c shipped violating it on a stacked area,
  which is why it is now stated here. The shipped chart built its x domain from the months
  **present in the query result**, so a month the subject never filed was not on the axis at
  all and Plot joined the two surrounding samples with a straight edge. `HNL–LAS` (7.07 M
  seats) filed nothing for **2020-04 … 2020-09** and the chart drew one edge from 37,441 seats
  down to 6,804 across all six — inside the `--panel-2` band the same chart labels *"COVID —
  in window on purpose."* The one feature whose stated purpose is refusing to smooth COVID
  away was smoothing away the actual COVID shutdown. **14,198 of 22,950 route pairs (62%) have
  at least one interior gap**; `LGB–SJC` has a 21-month one.

  Three consequences for any chart built here:

  - **The absent month gets no sample.** The filed months are split into contiguous runs and
    each run is drawn as its own mark, so the hole is a hole.
  - **An isolated filed month is still drawn.** A one-month run has no width and serializes to
    an invisible degenerate path, and **9,486 of 22,919 pairs (41%)** have at least one such
    month between two gaps. Erasing a filing is the same class of dishonesty as inventing one,
    so those runs are drawn **stroked** — a hairline column in the band's own shade, at its own
    height in the stack.
  - **The count is stated, not merely drawn.** A hole in a stacked area reads as "flat and
    small" as easily as "not filed", and a screen reader sees no hole at all. The chart's own
    key and its `aria-label` both carry *"N months with no filings, drawn as gaps rather than
    interpolated."* One sentence, written once — the number is per-subject, so the static
    legend rail cannot hold it, and two copies of one measurement drift.

  The x domain still runs first-filing → last-filing, not the requested window: a subject that
  stopped filing in 2019 draws nothing to the right of 2019 rather than a flat zero line to
  2026. The page's own window line and the `aria-label` name the range actually drawn.

  **The visible line has to say so too, not just the `aria-label`.** It shipped naming the
  *requested* window and read `chart: the full window · 2015-01 → 2026-04` above a chart that
  stopped in 2022 — on `/route/ATL-CAK`, which filed 67 months, 2015-01 → 2022-06, and nothing
  since (measured). The `aria-label` was already correct, so only the text a sighted reader
  sees was wrong, which is the worse half. 12,062 of 22,950 route pairs last filed before the
  current trailing-12 window, so this is over half of them rather than a corner case. It is the
  same fabrication as interpolating across a gap, and the exact inverse of the mistake the
  two-window line exists to prevent: claiming a window you are not drawing. `page.test.tsx`
  pins it as a pair — ATL-CAK must name `2015-01 → 2022-06` and must not name `asOf`, while
  JFK-LAX files every month and must still show the full window, so an implementation that
  hard-codes either range fails one of the two.

---

## The map

deck.gl `GreatCircleLayer` over a **Natural Earth coastline GeoJSON** — no tiled basemap,
ever. (The committed mockup substitutes the 737 filing airports as dots, so it depends on no
external file; production draws the coastline.)

### Projection

**Composite Albers USA, five panels** (`app/src/lib/map/albers.ts`). Conterminous conic
(standard parallels 29.5/45.5, central meridian −96), plus **labelled insets for Alaska,
Hawai'i, the Pacific (`pac`), and the Caribbean (`car`)** — each panel fit independently to
its own points, in its own screen rect. Letting AK and HI into a single fit compresses the
lower 48 into an unreadable smear — it was tried — which is also why `pac` and `car` are their
own panels rather than folded into `us` or `hi`.

**Longitude is normalized before any panel decision.** Six fact-present airports carry a
positive longitude — GUM, UAM, ROP, TIQ, SPN, and Alaska's own SYA (Eareckson AS, Shemya, at
+174.11, since the western Aleutians genuinely cross the antimeridian) — and the panel tests
are all written in western-hemisphere terms, so `normalizeLon` (`lon > 0 ? lon − 360 : lon`)
runs first at every call site, never only inside one helper. Measurements and the full
airport list: `docs/data/invariants.md` § Airport coordinates, and the six that are east of
the antimeridian.

**`regionOf` is ordered most-specific first** (`pac`, `car`, `hi`, `ak`, then `us` as the
fallback) — reversing that order (testing `us` first) is a real mutant, not a hypothetical:
`us`'s test is unconditional, so it would swallow every point before the more specific panels
ever run. Two panels exist precisely because a two-test split (conterminous / Alaska /
Hawai'i) gets two populations wrong, not just Shemya:
- **`pac`** holds Guam/Saipan/Tinian/Rota, American Samoa, and Midway — American Samoa sits in
  the *southern* hemisphere and Midway at 28.2°N, so the mockup's Hawai'i test
  (`lon < −150 && lat < 30`) caught both, stretching a "Hawai'i" panel to 42° of latitude when
  Hawai'i itself spans 2.3°.
- **`car`** holds Puerto Rico and the USVI, which extend the conterminous bounding box in
  *both* directions at once (east past PQI, Maine, and south of EYW, Key West) — no single
  rectangle holds them and the lower 48 legibly.

Note for implementers: raw Albers grows northward while screen `y` grows down. The `y` term
must be negated or the country renders upside down — asserting that two projected points are
merely *present* does not catch this; only their relative screen order does.

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

**A same-airport row is never an arc, on any page, standing rule.** `fct_segment_month`
really carries rows whose origin and destination are the same airport — 359 of 1,045
fact-present airports have at least one over the trailing 12 months; ORD alone is 53 rows,
73,082 seats. Such a row's great circle has zero angular length, and `greatCircle`'s own
degenerate-endpoint branch (`om < 1e-9`) would emit `steps + 1` identical points — several
hundred bytes of polyline drawing an invisible mark directly on top of the origin disc. So
the drawn arc set always excludes any row whose code equals the origin's (`app/src/lib/map/
networkMap.ts`'s `renderNetworkMap`: ORD draws 267 arcs, not 268) — but the row's seats stay
in whatever total the map states, passed in separately (`sameAirportSeats`), never derived
from the already-filtered arc list. A map that dropped these seats from its own total as well
as from its arcs would disagree with the stat strip directly above it on the same page. Both
halves are required; shipping one without the other is a defect.

**Step count is adaptive, not fixed** (`app/src/lib/map/greatCircle.ts`'s `stepsFor`): points
scale with the arc's length ON SCREEN (`round(projectedLengthPx / 22)`, floor 4, cap 48), not
with its angular distance — a 40px hop needs a handful of points and a transcontinental arc
needs dozens. Measured on ORD's 268 arcs: a flat 48 emits 192,231 bytes of polyline; adaptive
emits 132,178 with no visible change to the long arcs, and a flat 12 would save more but
visibly polygonizes them. A great circle cannot cross a panel boundary at all (above), so
`stepsFor` is only ever consulted for an arc `greatCircle` actually draws — a cross-panel arc
is the two projected endpoints, straight, regardless of its geographic length.

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

## Entity pages — all four shipped: `/route` (M4b + M4c), `/airport` · `/carrier` · `/aircraft` (M4d)

The first entity page, and the shape the other three follow — the differences are tabulated at
the end of this section.
Composes components already specified above rather than inventing new ones — same top bar,
same `DATA AS OF` badge, same data table, same legend rail:

```
UPGAUGE                                    DATA AS OF 2026-04
─────────────────────────────────────────────────────────────
JFK–LAX     John F Kennedy Intl ↔ Los Angeles Intl

  SEATS      PASSENGERS   LOAD FACTOR   AVG GAUGE   DEPARTURES  CARRIERS  QUARANTINED
  3,455,820  2,998,796    86.78%        170.4       20,283      5         0

  Table: trailing 12 months · 2025-05 → 2026-04 · chart: the full window · 2015-01 → 2026-04
─────────────────────────────────────────────────────────────
  [ aircraft-type mix — stacked area, full window, shaded by seats per departure ]
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
- **Chart** (M4c). The aircraft-type mix, above the table, over the **full** window — not the
  table's trailing 12. The two windows differ because a twelve-point fleet-mix stack shows
  nothing, and **the page states both**: a decade drawn under a line reading "Trailing 12
  months" claims a window it is not showing. It is drawn whenever the *full* window has
  filings, including when the trailing-12 table below is empty (12,062 of 22,950 pairs last
  filed before the current trailing-12 window — the majority, not an edge case); when neither
  window has anything, no chart is drawn and the empty state below carries the finding alone.
- **Table.** The standard data table, one row per operating carrier, trailing 12 months,
  sorted by seats descending. Empty state (two real airports, no scheduled service in the
  window) keeps the title block and stat strip, states the finding in words, and offers the
  widened-to-2015 window — the entity-page version of the Explorer's own empty state, above.
- **Explorer link.** The page's query is an ordinary `PivotQuery`, so the link is the same
  permalink encoder the Explorer itself uses — "every insight row is one click from the raw
  rows that produced it" applied to the whole page, not just a row.
- **Legend rail**, the Explorer's plus one group: fleet shading, which only a page with a
  chart on it gets (see below).

Canonical-URL handling (redirect, 404, en-dash rendering) is a routing concern, not a design
one — full contract in
[`../architecture/pipeline.md` § M4b](../architecture/pipeline.md#m4b--the-route-page). As of
M5, all four entity pages export a `<link rel="canonical">` at that same resolved value — never
the requested spelling, so `/airport/sea` declares `/airport/SEA` rather than itself, exactly
the same resolver call the redirect above already makes.

### The other three, shipped M4d — what each one changes and what it must not

`/airport/<code>`, `/carrier/<code>` and `/aircraft/<slug>` are the layout above with the
subject swapped, deliberately: four entity pages that read as one system is worth more than four
pages each optimised alone. Same top bar, same title block (`.code` + `.ename`), same stat strip
with the derived marker on load factor and avg gauge, same chart-above-table, same two window
lines, same empty state, same rail. What differs is only what the subject forces:

| | Stat strip changes | Table rows | Chart stack | The sentence it must carry |
|---|---|---|---|---|
| `/airport` | `Carriers` **+ `Destinations`** | operating carriers | aircraft type | every figure counts this airport at **both** endpoints |
| `/carrier` | `Carriers` → `Aircraft types` | aircraft types | aircraft type | operated, not marketed · code and name are current identity |
| `/aircraft` | `Carriers` | operating carriers | **operating carrier** | — |

Three design consequences worth pinning, because each is somewhere a page could quietly stop
being honest:

- **`/airport`'s Explorer link is two links, and says so.** The pivot cannot express
  `origin OR dest`, so the page offers `departures from SEA` and `arrivals into SEA` as
  *halves*. Linking one silently would half-satisfy "every insight row is one click from the raw
  rows" while pointing at a query that is not the page's.
- **`/carrier`'s two caveats render whether or not there is a table.** They qualify the
  *subject*, not the rows, and 39% of carriers have no rows in the trailing 12. They also sit in
  the content column, not the rail: the rail already carries a generic version on every data
  view, and a page-specific claim hidden among generic ones is not a claim.
- **`/aircraft`'s ramp means something else, so it says something else.** Covered in
  § Charts above: "less dense cabin" / "denser cabin", never "smaller metal", or the rail is the
  stale "how to read this" it exists to replace.

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

**Not saved instances of the generic Top-N builder** (`app/src/lib/topn.ts`), and **not saved
Explorer queries** — despite reusing the rank column: every `meta_pivot_measures` row is a
single-window aggregate and no pivot measure expresses a delta, while these presets rank on one
(Δ load factor, log Δ gauge) against prior-12, which only `mart_route_health` computes. The two
share `DataTable`'s rank column and nothing else. **The user-facing copy has to say this too**,
not just the docs: `/watch`'s own index read "Four saved Explorer queries, editorially framed"
through M6, one milestone after the correction landed in six other places.

Route Birth Tracker rows must read **"re-entry, not first appearance"** and must **name the
carrier** — never "first ever", never "first appearance since 2015", and never "nobody flew it
last year". All three shipped; the first two were mandated by this very line through M6.
`p12_months_present = 0` means *this carrier filed nothing on this route in the prior 12
months*, full stop. Two things it does **not** mean, each measured:

- **Not a first appearance.** The mart has no lookback past that window. 334 of 688 qualifying
  rows (48.5%), and 17 of the 25 rendered, had already filed earlier — `MQ AZO–ORD` in 93
  distinct months back to 2015-01.
- **Not an unserved route.** `mart_route_health`'s grain is **(op_airline_id, route)**, so the
  filter is silent about every other carrier on the same airport pair. **521 of 688 (75.7%), and
  25 of the 25 rendered**, had a different carrier flying that pair inside the prior window —
  `AS HNL–ITO` leads the page while HA, UA and WN filed **1,787,347 seats** on it in that
  window, 4.9× the subject's own trailing 12.

**Grain is a copy problem, not just a data problem.** The second bullet was introduced by the
fix wave that closed the first: "nobody flew last year" read as the accurate half of the old
sentence and was carried over unexamined, so a wave correcting one false claim shipped another
of the same class. Any sentence about a `mart_route_health` row names the carrier or it is a
claim about a route the query never made. `docs/product/features.md` § Insight presets owns the
rule and the rest of the evidence.

**Every filter a preset applies is stated on the preset's own page**, in a `.foot` note, or the
page cannot be reproduced from what it says. Empty Planes has two (`gauge_t12 >= 50` and
`t12_departures_performed >= 360`, the latter the more restrictive) and disclosed only the
first through M6.

**`health_score` renders in a left-aligned `td.id`, not a `.num` cell** — a deliberate,
declared exception to "all numerics right-aligned, tabular-figure". The cell's value is
`formatHealthScore`'s output, either two decimals or the literal string "insufficient data",
and on Route Birth Tracker it is that string on 100% of rows. `DataTable`'s `kind` is per
column, not per cell. It keeps its monospace; it gives up the right edge. See the comment on
`buildColumns` in `app/src/app/watch/[preset]/page.tsx`.

The editorial frame is `.frame`: a left hairline in `--signal`, `--ink` text at 14px, no box.
The preset index is `.watch-list`: hairline-separated rows, no bullets, the linked title
carrying the weight and its frame muted to `--ink-2`. Both shipped in M6 with **no CSS rule at
all**, which left the one voiced line on the site rendering as plain body text beneath its own
disclosures.

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
