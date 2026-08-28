# The design system

Resolved output of the design session. [`brief.md`](brief.md) states the problem and the
constraints; **this file owns the answer** — tokens, components, chart and map encodings,
states. Working mockups with real numbers: [`mockups/`](mockups/).

Product truths that constrain this (mono numerics, `DATA AS OF`, density, permalinks,
honest labels) are owned by [`../product/overview.md`](../product/overview.md); where a section
below applies one, it states the constraint it is applying rather than deferring.

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
  collapses below **920px**, and **the collapsed single-column form is `minmax(0,1fr)` too.**
  A bare `1fr` is `minmax(auto,1fr)`, and that `auto` is a content-based minimum: the track
  takes the widest *rendered* table's min-content as its floor, so the page body scrolls while
  `.table-scroll` — handed exactly its own content width — never scrolls at all. **No
  breakpoint can bound this**, because the floor moves with whatever the URL asks for.
  Measured on the served build across 17 URLs × 15 widths, 320–1440px, with the guard removed
  and restored — **this is the only place the sweep is stated, and the code sites cite it
  rather than repeat it**: **72 of 255 (url, width) pairs overflowed with a bare `1fr`, 0 of
  255 with `minmax(0,1fr)`.** The widest viewport that still overflowed was **920px, the
  breakpoint itself**; the worst case was `/watch/empty-planes` at **+804px on a 320px
  viewport**. The threshold is per-page and per-query, which is the entire argument:
  `/airport/BET` failed up to 470px, `/carrier/AS` to 520px and the four `/watch` presets to
  920px — and **`/explore` failed up to 600px with three dimensions and five measures selected
  while its default view never failed at all.** Same template, same build, two permalinks.
  Every flexible track in `globals.css` is therefore `minmax(0,…)`, and a bare `1fr` or `auto`
  track anywhere in that file is a test failure, not a review note.
- **Table row height 22px.** Hairline `--rule` between rows, `--ink` under the header. No
  card containers, no rounded corners, no drop shadows anywhere.
- Vertical rhythm between blocks: 12/16/22px. Section heads are a `--ink` hairline with a
  9.5px uppercase label sitting on it.

---

## Components

### The top bar

The wordmark, the `DATA AS OF` badge, and a site-wide search field, extracted
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

**An unknowable measure renders `—` in the same column as a real figure, never a blank cell and
never a zero.** A group whose every filing was quarantined sums to NULL, not 0
(`docs/data/invariants.md`), and the three states — *measured zero*, *unknowable*, *not asked
for* — have to stay distinguishable in a table whose whole claim is that it shows the dirt. The
em dash keeps the column's monospaced, tabular-figure, right-aligned alignment because it is one
glyph in the same face, so a reader scanning the column sees a gap in the data rather than a gap
in the layout; a blank cell reads as a rendering fault, and `0` is a lie. **Where quarantine is the cause, the dash states that nothing can be said and the reason-code
gutter states why** — `Q`, with the row's own `quarantine_reasons` in its `abbr` title (plural,
and comma-joined where one displayed row folds several filings together), so the pair is a
complete disclosure. **A zero denominator has no such partner and the dash stands alone**: a
derived measure over a real, un-quarantined zero is unknowable with an empty gutter, and only a
page that carries a foot of its own (`/airport`) says so in words. 14 groups at segment grain in
the trailing 12 are in that state. A row in this state carries no below-floor treatment: an unknown departure
count makes no claim about the floor, exactly as the paragraph above requires.

**The rule above is about a measure that was QUERIED.** A measure the query never selected is
absent from the row, not null in it, and a component that reads both as "no value" asserts the
unknowable treatment on every row of any permalink that did not ask for the column. **Whether
that collapse is a defect depends on how many answers the column has.** The floor has one — a
departure count that is absent and one that is unknowable both make no claim about the floor, so
collapsing them there is correct, and necessary, since `departures_performed` is itself a
`FILTER`ed sum and comes back NULL for a wholly-quarantined group. The gauge rail has two: draw
nothing, or draw the axis to say the value cannot be stated. Same collapse, opposite
correctness.

**A test for this asserts the dash's POSITION, not its presence.** Load factor and average gauge
are already `—` on such a row before the bug is fixed — their denominators are zero — so
"contains an em dash" passes on the broken page. The discriminator is the sequence of cells.

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

**Every dimension cell that resolves to a page links to it.** `DataTable`'s
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
same airport does not link.** `fct_segment_month` carries 532 such pairs with real traffic
(ORD alone is 76,236 seats over the trailing 12), but `/route/ORD-ORD` is a 404 by design —
`resolveRoutePair` answers *"'ORD' to itself is not a route between two airports"*, and
`sitemap_routes.sql` excludes them for the same reason. The link path is the easiest place to
forget it, and forgetting it ships a link to a guaranteed 404. The guard lives
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
215 of 22,509 pairs (measured; `CLAUDE.md`). Reusing the displayed order would be wrong
for every one of those 215 — IFP/IAH is one of them: airport-id order displays `IFP–IAH`, but
the canonical `/route/` URL is `/route/IAH-IFP`, the reverse. A fixture built on an
order-agreeing pair like JFK–LAX (22,294 of 22,509) cannot catch that class of bug — both
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
fleet-shading group, which only a page carrying a chart gets. A rail that explains a monochrome gauge
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

**The aircraft-mix chart adds no SQL and no catalog entries.** It composes the existing
segment-grain pivot (`year_month` × `aircraft_type`, seats + departures) through the composite
`route` filter. That is why chart work leaves `make goldens` byte-identical, and it is a
property to preserve: a chart that needs its own query has escaped the pivot contract that
`/explore` and every entity page share.

Observable Plot under the hood. These are encoding rules, not library configuration.

**Axis numerics obey the same rule as every other numeric here: monospaced and
tabular-figure.** Plot's root style hardcodes `font-family: system-ui, sans-serif`, and
`font-variant-numeric` alone does not override it. The trap is shipping with the y ticks ("1.2M"), the
year ticks and the annotation's year in the sans face while every other numeric on the page was
Plex Mono. Every chart passes `style: { fontFamily: "var(--font-mono)", fontVariantNumeric:
"tabular-nums" }`; the token, not a literal family, so `globals.css` stays the single source
the way it already is for the `--g*` ramp. The mockups do this with a dedicated `.axl` class.

### Aircraft-type mix — build this before the load-factor chart

All four entity pages share one component. What follows is the encoding rule plus the traps
in implementing it.

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
A321nXLR, B767-3/R, B767-4, B757-2, A320-1/2; gauge: A321nXLR, A320-1/2, B757-2, B767-3/R,
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

#### The same chart, stacked by something else

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
| A321nXLR | B6 176.0 | F9 230.0 | **54.0 seats (31%)** |
| A320-1/2 | MX 129.2 | G4 181.7 | 52.5 |
| B737-8 | AS 159.8 | XP 187.7 | 27.9 |

**Over the trailing 12 months `2025-05 → 2026-04`** — the window originally measured here, and
the source of the `172.3 → 230.0` pair quoted in prose elsewhere in this repo:

| type | lightest | darkest | spread |
|---|---|---|---|
| A321nXLR | B6 172.3 | F9 230.0 | **57.7 seats (33%)** |
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
pinned against, precisely because a fixture whose two orders coincide lets a single sort pass.

### Multi-series lines

**No hue at all.** Series are distinguished by weight, dash, and a direct end-label:
2.2px solid → 1.1px solid → 1.1px dashed `4 3` → 1px dotted `1 3`. Same discipline as the
map arcs. Legend rail carries the key.

Rolling-12 is the default view; Month is the toggle. Gaps are gaps — see the standing rule
below — it binds every time-series mark, not only lines.

### Three standing rules

- **COVID is drawn, not hidden.** A `--panel-2` band across 2020-03 → 2021-06, labelled
  *"COVID — in window on purpose."* The window includes it deliberately; the chart should
  say so. Two details matter: the band's edges land **on** the 2020-03
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
  [`../architecture/pipeline.md`](../architecture/pipeline.md).
- **Gaps are gaps.** A subject that stops filing **breaks** the mark rather than interpolating
  across the absence — and **zero-filling is not the alternative**: a month with no filing is
  *unknown*, not zero. T-100 is a filing, so "no row" means "nobody filed", which is neither
  "nobody flew" nor "0 seats flew". Drawing either invents data, and the two inventions are
  equally confident-looking under a `DATA AS OF` badge.

  It binds stacked areas as hard as lines, and the way to violate it is subtle: building the
  x domain from the months **present in the query result** leaves a month the subject never
  filed off the axis entirely, and Plot joins the two surrounding samples with a straight edge. `HNL–LAS` (7.07 M
  seats) filed nothing for **2020-04 … 2020-09** and the chart drew one edge from 37,441 seats
  down to 6,804 across all six — inside the `--panel-2` band the same chart labels *"COVID —
  in window on purpose."* The one feature whose stated purpose is refusing to smooth COVID
  away was smoothing away the actual COVID shutdown. **14,293 of 23,041 route pairs (62%) have
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

  **A hole has more than one cause, and the sentence must name the right one.** A month whose
  every filing was **quarantined** is not a month with *no* filings — it was filed, and nothing
  about it can be trusted. Both break the runs, because the geometry of an absence is the same
  whichever cause it has, but they are counted and worded **separately** on the key and in the
  `aria-label`: *"N months filed but wholly quarantined — every filing failed an invariant."*
  Folding them into the gap count puts a false clause in the one sentence a sighted reader gets,
  which is the compound-claim shape `/watch/new-routes` already shipped once. Measured over the
  pairs the chart draws: **339** such months, and they carry zero stateable seats, so breaking
  them erases nothing.

  **A third state is not a hole at all.** Where *some* of a month's bands can be stated and
  others cannot, the month is **still drawn**, from what can be stated, and disclosed as
  understated: *"N months understated — a quarantined filing could not be summed into the stack,
  so the real total is higher by an amount that cannot be stated."* Dropping the month instead
  was measured and rejected: **407** such months hold **11,687,092** stateable seats, the worst
  (`LAS–LAX` 2024-11) **297,295** across 12 cells with one unknowable. Erasing a filing is the
  same dishonesty as inventing one, and the shortfall is not bounded near zero — 26 of the 606
  rows behind these cells are `load_factor_gt_1` carrying 19,870 filed seats, not `zero_seats`.
  A stacked area's y is cumulative, so there is no honest way to omit one component at one x and
  keep the rest aligned; the choice is draw-and-disclose or erase, and this project surfaces dirt
  rather than hiding it.

  **The crossover annotation refuses rather than ranks.** *"B overtakes A in 2018"* is a claim
  about which type was biggest, so a year holding a type whose seats cannot be stated yields **no
  leader** — the unknown rival cannot be shown to have lost. A year with no leader is skipped
  rather than treated as a wall, so the annotation is derived from the years that can be ranked.
  Measured **at year × type grain**, which is the grain the refusal fires at — a type's
  whole-year total must be unstateable, a strictly smaller set than "pairs carrying an
  unstateable cell": **214 pairs across 273 pair-years** of 23,041. What a reader sees change is
  smaller again, because most refused years were never the year the annotation named — the
  rendered annotation differs on **18 pairs**, 6 losing it and 12 moving year or direction.

  The x domain still runs first-filing → last-filing, not the requested window: a subject that
  stopped filing in 2019 draws nothing to the right of 2019 rather than a flat zero line to
  2026. The page's own window line and the `aria-label` name the range actually drawn.

  **The visible line has to say so too, not just the `aria-label`.** It shipped naming the
  *requested* window and read `chart: the full window · 2015-01 → 2026-04` above a chart that
  stopped in 2022 — on `/route/ATL-CAK`, which filed 67 months, 2015-01 → 2022-06, and nothing
  since (measured). The `aria-label` was already correct, so only the text a sighted reader
  sees was wrong, which is the worse half. 12,115 of 23,041 route pairs last filed before the
  current trailing-12 window, so this is over half of them rather than a corner case. It is the
  same fabrication as interpolating across a gap, and the exact inverse of the mistake the
  two-window line exists to prevent: claiming a window you are not drawing. `page.test.tsx`
  pins it as a pair — ATL-CAK must name `2015-01 → 2022-06` and must not name `asOf`, while
  JFK-LAX files every month and must still show the full window, so an implementation that
  hard-codes either range fails one of the two.

---

## The map

**Not deck.gl, not MapLibre**, though a `GreatCircleLayer` over a MapLibre basemap is the
obvious reach. The map is a from-scratch, dependency-free, server-rendered SVG engine
(`app/src/lib/map/{albers,greatCircle,arcs,segmentMap,networkMap,basemap}.ts`, composed by
`app/src/components/NetworkMap.tsx`) — the same "in the served HTML, visible with JS off"
property `AircraftMixChart.tsx` has, extended to a map: no client charting/mapping
library ever touches the render path, so the map works with JavaScript off and needs no tile
budget at all, not merely an untiled one. A great-circle arc over a projected coastline —
**Natural Earth GeoJSON**, still true — no tiled basemap, ever. (The committed mockup
substitutes the 737 filing airports as dots, so it depends on no external file; production
draws the coastline.)

### Projection

**Composite Albers USA, seven panels** (`app/src/lib/map/albers.ts`). Conterminous conic
(standard parallels 29.5/45.5, central meridian −96), plus **labelled insets for Alaska, Hawai'i,
the Marianas (`pac`), Midway (`nwhi`), the Caribbean (`car`) and American Samoa (`sam`)** — each
panel fit independently to its own points, in its own screen rect. Letting AK and HI into a
single fit compresses the lower 48 into an unreadable smear — it was tried — which is the same
reason the other four are panels rather than folded into `us` or `hi`.

**Longitude is normalized before any panel decision.** Six fact-present airports carry a
positive longitude — GUM, UAM, ROP, TIQ, SPN, and Alaska's own SYA (Eareckson AS, Shemya, at
+174.11, since the western Aleutians genuinely cross the antimeridian) — and the panel tests
are all written in western-hemisphere terms, so `normalizeLon` (`lon > 0 ? lon − 360 : lon`)
runs first at every call site, never only inside one helper. Measurements and the full
airport list: `docs/data/invariants.md` § Airport coordinates, and the six that are east of
the antimeridian.

**`regionOf` is ordered most-specific first** (`sam`, `pac`, `nwhi`, `car`, `hi`, `ak`, then
`us` as the fallback) — reversing that order (testing `us` first) is a real mutant, not a
hypothetical: `us`'s test is unconditional, so it would swallow every point before the more
specific panels ever run. The extra panels exist precisely because a two-test split
(conterminous / Alaska / Hawai'i) gets two populations wrong, not just Shemya:
- **`sam`, `pac` and `nwhi`** are a three-way split of one `lat < 30 && lon < −160` test, and
  their union is exactly that test again — which is what makes the split provably unable to move
  a point into or out of `us`/`ak`/`hi`/`car`. **`sam`** is American Samoa, in the *southern*
  hemisphere; **`nwhi`** is Midway at 28.2°N; both were caught by the mockup's Hawai'i test
  (`lon < −150 && lat < 30`), stretching a "Hawai'i" panel to 42° of latitude when Hawai'i itself
  spans 2.3°. **`pac`** is the Marianas — Guam/Rota/Tinian/Saipan and the uninhabited northern
  islands, everything west of the antimeridian (`lon < −200`).
- **One Albers fit cannot carry all three.** They span roughly 5,000 km, and a fit scaled to that
  extent puts Tinian and Saipan — 18 km apart, on an **undirected** route filing 78,420 seats over
  the trailing 12 — **2.73px** apart even in a `pac` rect filling the whole canvas. (That figure is
  `fct_route_month`'s, because the map draws one arc per undirected route. `fct_segment_month`'s
  directed halves are 39,908 and 38,512; quoting either as a route total understates the arc by
  half.) American Samoa, were `regionOf` to send it to `pac`, projects to (1892.5, 1102.0) under
  the shipped `pac` fit — off the canvas. A counterfactual pixel coordinate like that one is only
  true of the `pac` rect current when it was taken, since `ox`/`oy` move with the rect; re-derive
  it rather than carrying it forward. This is arithmetic, not a layout preference: see § Basemap
  coastline.
- **`car`** holds Puerto Rico and the USVI, which extend the conterminous bounding box in
  *both* directions at once (east past PQI, Maine, and south of EYW, Key West) — no single
  rectangle holds them and the lower 48 legibly.

Note for implementers: raw Albers grows northward while screen `y` grows down. The `y` term
must be negated or the country renders upside down — asserting that two projected points are
merely *present* does not catch this; only their relative screen order does.

**An arc crossing a panel boundary cannot be a great circle**, so `PDX–ANC` and `PDX–HNL` are
drawn as straight lines **across the boundary** — never "into an inset", which is true only when
the subject is conterminous. An inset-origin subject (`ANC`, `HNL`, `SJU`, `GUM`) crosses OUT of
its own inset, and the point-to-point engine draws inset-to-inset segments such as `HNL–ANC` that
enter no inset at all. The page says so — in the legend rail's "Arc rendering" group
(`LegendRail`'s `map` prop) and in the map's own `aria-label`, which names the exact count of
straight-line segments rather than calling every one a great-circle arc (`segmentMap.ts`'s
`arcsSentence`, shared by both maps). Every US map makes this compromise; this one admits it,
twice over — once for a sighted reader, once for a screen reader.

### Basemap coastline

The committed basemap (`app/geo/*.json` → `app/scripts/build-basemap.mjs` → `app/src/lib/map/
basemapPaths.generated.ts`) starts at Natural Earth **1:110m**, which has no polygon at all for
Guam/CNMI/American Samoa/Midway or Puerto Rico/the USVI, which on its own leaves those insets
empty. Measured against the real warehouse over the trailing 12 months, in which **757**
airports are fact-present: **79** of them reach `car` and **7** reach a Pacific panel (GUM, HNL,
PPG, ROP, SFO, SPN, TIQ). 757 is the denominator these two are shares of — 1,047 is the
fact-present population across the *whole* window and is the wrong one to read them against.
`/airport/SJU` alone drew 65 arcs inside a labelled Caribbean frame with no landmass under it,
and San Juan is a major airport, not an edge case. None of 757, 79 or 7 is generated; all three
must be re-measured when quoted.

**Two panels are simplified at their own RDP epsilon, and one is the reason.** The shared
0.05° (~5.5 km) is ~1.93px at `pac`'s scale — wider than four of the six Northern Mariana
islands — so RDP collapsed each of those rings to a two-point segment enclosing **zero area**: a
hairline where the map claims an island. One of them is **Rota**, ~19 km across, inhabited, with
its own `/airport/ROP` page and 4,672 + 16,270 seats over the trailing 12 — so its destination
dot sat on top of a hairline. `ne_50m_pac.json` is therefore simplified at **0.01°** (~0.39px),
at which every ring regains real fill (Rota 7.80 px² of its unsimplified 8.23) and Tutuila keeps
all 8 of its source vertices instead of 5. Per input, never global: lowering the shared value
would rewrite every `us`/`ak`/`hi`/`car` path, and those are pinned. It moves no fit — the
generator builds its reference points from the raw rings, before simplification — so every
projected airport is identical either way.

**A second, finer input carries every territory** (Natural Earth 1:50m Admin-0 Countries, same
mirror): `app/geo/ne_50m_car.json` (`NAME in ('Puerto Rico', 'U.S. Virgin Is.')` — 2 features)
and `app/geo/ne_50m_pac.json` (`NAME in ('Guam', 'N. Mariana Is.', 'American Samoa')` — 3
features). 1:110m's own Admin-0-countries file does carry a lone 9-point "Puerto Rico" polygon,
but no separate USVI feature at any resolution below 1:50m; 1:50m is the first resolution with
both as real, multi-island features (PR: main island + Vieques + Culebra; USVI: St. Thomas +
St. Croix + St. John) — confirmed by fetching and inspecting both resolutions before choosing.
`build-basemap.mjs` reads all three committed files and merges their features before the
existing sort/simplify/project pipeline runs unchanged — no second projection path, no new
RDP variant.

**The Pacific territories were in that same 1:50m file all along**, and this repo asserted the
opposite in six places for a milestone on the strength of a comment nobody checked. Guam is 12
points, N. Mariana Is. 46 across 6 rings, American Samoa 8. The rule that generalizes: a claim
that an upstream source *lacks* something is a measurement, and expires like any other.

**Midway is one of two gaps in the committed geography, and the reason is a scope decision,
not a missing polygon.** 1:50m
genuinely has no Midway. At 1:10m it exists, but only inside a 13-ring `U.S. Minor Outlying Is.`
feature whose other rings include **Navassa Island, in the Caribbean** — and `build-basemap.mjs`
classifies a whole feature by `regionOf` of its first ring's first point, so taking that feature
whole projects Navassa into the Pacific inset. A ring-level filter would extract Midway, and this
repo already hand-filters its inputs at the feature level, so that is the same class of
operation, not a new one. **What rules it out is that ring indices are not stable across a
Natural Earth refresh**: a committed input that says "ring 4 of this feature" silently becomes a
different island when upstream reorders, and this project has already paid once for a fixture
that stopped exercising what it named (aircraft type 699). Say that, rather than "the source
does not have it" — the last claim of that shape in this file was false for a milestone. Midway
therefore has its own panel, `nwhi`, with zero reference points; the subject-derived fit in
`segmentMap.ts`'s `renderMapCore` is what renders it, and `nwhi` is the only panel that branch
serves.

**Folding Midway into `pac` instead would be a regression, not a simplification.** `pac`'s baked
fit is scaled to the Marianas' own extent, so Midway lands at (1367.6, −429.7) under the shipped
fit — off a 960×500 canvas — and `/airport/MDY?y=2021` loses its own subject while the caption says
only the landmass is missing. MDY has exactly one filing in the window (MDY–HNL, HA, 2021-09,
278 seats), so `/airport/MDY?y=2021` and `/airport/HNL?y=2021` are the two pages this decision
is about.

**The western Aleutians are the second gap, and `ak` covers them with a declared extent rather
than geometry.** `ne_110m_us.json`'s Alaska is 164 points spanning 171.791 W – 129.980 W: Natural
Earth 1:110m stops mid-chain around Atka and omits the western third of the Aleutians. A fit taken
over that coastline alone is right for the coastline and too narrow for the airports past it.
Measured against the built warehouse over all 9,796 fact-present airport × window views: **seven**
fact-present Alaskan airports projected outside `PANEL_RECTS.ak` — ADK, AKB, FQW, IKO, SNP, STG,
SYA, across **69** of those views — and **three** put the subject's own `r=4.5` disc *or* its
right-anchored label off the 960×500 canvas, where `globals.css`'s `svg:not(:root) { overflow:
hidden }` clips it away: ADK at (−3.1, 453.4), AKB at (7.0, 454.5) and SYA at (−35.2, 433.5),
across **27** views. `/airport/SYA?y=2018` rendered a map of a network whose centre was not on it.
**AKB is the one a disc-only check misses** — its disc was on-canvas and its label ran to x = −19.8,
so `/airport/AKB` drew an unlabelled subject jammed against the left edge in all 13 of its windows.
That is why the gate asserts the label box and not just the mark.

**The fix is the fit, not the rect, and that is arithmetic.** `fitPanels`'s `k` is `min(w/dx, h/dy)`
and `ak` binds on **width**, so `ADK.x = rx0 + (raw_x − x0)·k = rx0 − 0.10343k` — strictly left of
the rect's own left edge for every `k`, and widening the rect only *raises* `k`. Widening helps at
all only once height binds (`k` capped at 509.33), and ADK then needs a rect 294px wide and SYA
381px, against the 140px the bottom tray has between the 16px pad and `hi`'s frame at 186.
`BASEMAP_FIT_POINTS` therefore carries two anchors with no drawn geometry —
`build-basemap.mjs`'s `AK_EXTENT_ANCHORS`: Attu Island's western tip (52.927 N, 172.476 E) and
Amatignak Island, Alaska's southernmost point (51.215 N, 179.119 W), both Natural Earth 1:10m
Alaska's own extreme vertices. `ak`'s fit goes from k=377.8397 to **k=244.5450**, all 344
fact-present Alaskan airports land inside the rect, and both properties above are clean. Alaska's
easternmost airport, WHD, is the binding case at the other end: 1.0px inside the east edge, against
1.55px before.

**The islands are not committed, and the reason is scale, not source.** 1:50m Alaska stops at
178.195 W and does not reach Shemya at all; 1:10m carries the whole chain — 26 rings / 1,371 points
west of the committed coastline, out to 187.524 W, Shemya's own 8-point ring included. What rules
it out is that this panel draws **2.436 px per degree of longitude**: Attu is 2.35px, Adak 1.37px,
Kiska 1.14px, Agattu 0.98px, Buldir 0.27px and **Shemya 0.25px**. At any RDP epsilon coarse enough
not to bloat the artifact most of those collapse to a two-point segment enclosing zero area — the
hairline-where-the-map-claims-an-island defect `PAC_RDP_EPSILON_DEG` exists to prevent for Rota,
eighteen times over. At this panel's scale the western Aleutians are points, not polygons: the same
call `nwhi` makes for Midway, and the reason `pac` became its own panel rather than share one.

**`PANEL_RECTS.ak` is deliberately *not* reshaped to the new 1.9124:1 extent**, which is the one
place this differs from `car` and `pac`. Albers is conic, so the raw bounding box of a declared
extent does not contain the images of every point inside it: IKO, ADK, AKB and FQW all sit south of
that box. A tray-height 140×76 rect gives the identical `k` (width binds either way) and puts IKO
0.4px above the frame. `ak` fills 100.0% × 50.1% of its rect and the vertical slack is load-bearing,
not waste — which is also why `basemap.test.ts`'s "fills its rect" gate still covers `pac`/`car`/`sam`
only.

**The Florida Keys are the third gap, and `us` covers them with a declared extent too (#119).**
`ne_110m_us.json`'s Florida is 40 points and stops at lat 25.08 (lon 80.68 W), north of the Keys
entirely, so the conterminous fit had no extent below them. Measured over the fact-present
population: **EYW** (Key West) projected to (693.6, 428.7) and **MTH** (Marathon) to (703.4, 424.5),
**4.7px and 0.5px below `PANEL_RECTS.us`'s bottom edge of 424**. Both stayed on the canvas, so
unlike ADK/AKB/SYA nothing was clipped.

**The fix is the fit, not the rect — and here that is not a preference, it is an impossibility.**
`us` binds on **height** (`w/dx` = 1256.99, `h/dy` = 904.51), so its fitted extent fills 100.0% of
the rect's height and the vertical slack a point could sit in is **exactly zero**. EYW's raw-Albers
y exceeds the reference extent's by 0.005210, so its overshoot is `0.005210·k` below the bottom edge
**for every `k`**, and enlarging the rect only raises `k`. Slack appears only once *width* binds
instead, which needs **`w` ≤ 638.6px** — narrowing the lower 48 from 908px to 638px and leaving
~300px of dead margin on a 960px canvas. Anyone proposing to move or resize this rect should read
that number first: there is no rect that fixes this and keeps the map.

**The anchor is the vertex that projects furthest south, not the one that lies furthest south.**
Albers is conic, so those are different points, and the obvious-looking derivation is the wrong one.
Over all 33,462 Natural Earth 1:10m US vertices that `regionOf` files as `us`, the maximum raw y
under `PANEL_PARAMS.us` is **(24.551 N, 82.129 W)** in the Marquesas Keys; the minimum-*latitude*
vertex is (24.543 N, 81.815 W), Key West itself, 0.54px short — enough to halve EYW's clearance from
0.86px to 0.32px. `BASEMAP_FIT_POINTS` therefore carries **one** more anchor with no drawn geometry,
`build-basemap.mjs`'s `US_EXTENT_ANCHORS`, and the `us` fit goes from k=904.5131 to **k=892.2437**.
One anchor, because exactly one axis is short: measured against 1:10m, west and east already reach
0.15px *further* in the committed 1:110m file and north is 0.62px, against **5.58px** in the south.
The Keys are not committed as geometry for the same reason the western Aleutians are not.
Quote the scale **at the latitude it is used at**: this panel draws **14.18 px per degree of
longitude at lat 24.55**, where the Keys are, against 13.63 at lat 28 mid-peninsula — a 4% spread,
so the latitude travels with the figure. Measured on the source rather than on chosen endpoints,
NE 1:10m Florida's own 426 vertices south of 25.35 N span **24.9 × 16.2px** under the shipped fit,
and an individual key is **0.72px**. At any RDP epsilon coarse enough not to bloat the artifact
those collapse to zero-area hairlines — the Rota defect the whole `PAC_RDP_EPSILON_DEG` rule
exists to prevent.

**The counter-candidate is the Dry Tortugas, and the source settles it.** They lie 70km west of
Key West and are genuinely further south in projection — Loggerhead Key's southwestern tip would
sit 0.41px below this anchor. Natural Earth 1:10m's Florida polygon **does not contain them**: zero
vertices west of 82.5 W. Anchoring there would be *inventing* an extent rather than declaring one,
which is the opposite of what these constants are for. So the stated maximum is the maximum of the
source, checked rather than scanned.

**The anchor sits on a `regionOf` cliff — structurally like Amatignak's, quantitatively not.** The
Caribbean test is `lat < 25 && lon > −70` and the anchor is at lat 24.551, *below* 25, so only the
longitude clause keeps it in `us`. But Amatignak clears its own `lat > 51` clause by **0.215°**
while this one clears `lon > −70` by **12.129°** — a retune that reaches it is a deliberate
redesign of the Caribbean boundary, not a nudge, so the two are not mirror images.
`panelContainment.test.ts` asserts the classification anyway, first because it needs no database
and so fires where the live sweep skips, and second because it names the cause rather than
reporting a moved `k`; it also asserts separately that the anchor *binds* the fit's southern edge
rather than sitting inside it.

**The guard is asymmetric, and the unwatched direction is south.** An anchor placed too far *north*
is caught twice — the containment sweep, and the clearance assertion one step before it. An anchor
placed too far *south* (a transcription typo, or an extent not in the source at all) silently
**shrinks** the lower 48 while every airport stays comfortably inside its rect; the only thing that
moves is the hand-pinned `us` fit constant, which the same commit is already updating. That is
review catching it, not a gate. Both `AK_EXTENT_ANCHORS` and `US_EXTENT_ANCHORS` are hand
transcriptions of extrema from a file the repo does not commit and no `make` target fetches, so the
transcription is unverifiable in CI. Tracked as **#128**.

**Blast radius, because the issue predicted the opposite.** #119 was filed saying the fix would
rewrite every path byte in `basemapPaths.generated.ts`, every panel's geometry. It rewrites **one**:
`fitPanels` partitions its input by `regionOf` before fitting, so a `us`-classified anchor cannot
move another panel. **Exactly two data lines moved** — the `us` path literal and one appended fit
point — and `ak`, `hi`, `pac`, `car` and `sam` are byte-identical, which is what the three
unchanged path hashes in `basemap.test.ts` are there to check. Say *data lines*: the file's own
diff is larger, because the generator rewrites its header comment alongside them.

**The property is now stated once, for every panel, instead of one airport at a time.**
`panelContainment.test.ts` reads every airport `/sitemap.xml` serves a page for — through
`sitemap_airports.sql`, `lookup_airport_by_code.sql` and `map_airport_coords.sql`, the same three
production queries the site uses, so there is no second definition of fact-presence — and asserts
both that each projects inside its own panel's rect and that its subject disc and label stay on the
canvas. It mirrors `renderMapCore`'s own fit merge, baked fit with a subject-derived fallback, so
Midway is scored the way its page actually renders it rather than through the `us` fallback. **It
now carries no exemptions**: the two it shipped with, EYW and MTH, were closed by the `us` declared
extent above, and the assertion is an exact sorted set precisely so that fixing them is red too.

**What #119 did *not* close, because the issue's own second clause was false.** It read "EYW and
MTH … land inside the Caribbean inset's frame", citing `/airport/EYW` drawing its subject disc on a
labelled CARIBBEAN box. Re-derived clause by clause against the warehouse: EYW and MTH have **never**
shared a route pair with any `car`-panel airport in any year, and an inset frame is only drawn for a
panel a network actually reaches — so `/airport/EYW` never draws that box at all. What is true is
the *other* clause, and it is far wider than two airports. Counting fact-present airports whose
`regionOf` panel is `us` and whose projected point falls inside the drawn `car` frame — the rect
`[424, 392, 720, 468]` grown by the 6px the renderer draws its border at, so `[418, 386]`–`[726,
474]`, inclusive on all four edges — gives **18 before #119 and 17 after it**. Only SRQ falls out,
because everything shifted ~5px up; the defect is untouched. MIA is inside on both sides, at
(711.6, 406.3) before and **(708.4, 401.0)** now, about 22px above EYW either way. That is `car`'s
rect overlapping the bottom-right of `us`'s — the pre-existing overlap the land test below records
as `["FL", "TX"]` — not an extent defect, and no `us` fit can reach it. It is **#122**, it moves
rects, and moving rects lights up the frame-overlap, canvas-bounds and tray-baseline gates that
#119 leaves untouched by construction.

None of 9,796, 344, 69, 27 or the per-island pixel widths is generated; like 757/79/7 above they
are measurements dated by the commit that took them, and must be re-measured when quoted. The two
figures that *are* pinned mechanically are `ak`'s path sha256 and its fit, both in
`basemap.test.ts`.

*What the containment gate cannot see, measured:* `fitPanels` derives `ox`/`oy` from the rect, so
**translating** a rect translates everything projected into it and the property is invariant —
`PANEL_RECTS.ak` moved 24px right, same size, leaves it green. It is also blind to an anchor pulled
*almost* far enough, because it asks a boolean of each airport and `p.y <= y1` passes at equality:
set `US_EXTENT_ANCHORS` to EYW's own coordinates and its clearance goes to 0.00px while that test
stays green. Catching that needs a **position**, not a set, which is why a second test asserts EYW
is the tightest `us` airport and that its clearance (0.86px today, against MTH's 4.99px) is off
zero. Rect position belongs to
`albers.test.ts`'s frame-overlap check, the `ak` fit pin, and `networkMap.test.ts`'s golden and its
`PANEL_RECTS`/`INSET_RECTS` sync check, all four of which do go red on it.

**An empty, labelled inset must not read as a rendering bug to a site visitor.** `nwhi` is the
one panel left with a frame and nothing in it — so `NetworkMap.tsx` states the gap on the page
itself, in a `.foot` caption, whenever a network's own points actually reach it (derived from
`basemapPathsFor(["nwhi"]) === ""`, never hardcoded, so the caption retires itself the day
Midway gains geometry without a code change there — which is exactly what it just did for
`pac`).

**`PANEL_RECTS.car` (`albers.ts`) was widened once there was real geometry to check it
against** — Task 4/7's own open item, carried forward twice with nothing to measure.
Puerto Rico + the USVI's combined raw-Albers extent under `car`'s own projection parameters
is ~3.89:1 (wide, not tall — the territories span ~3.4° of longitude against ~0.8° of
latitude). The original rect was 100×76px (aspect 1.32:1), so `fitPanels`'s `k = min(w/dx,
h/dy)` bound on width and left the coastline only ~26px tall inside a 76px-tall frame — not
wrong, but a thin sliver floating in a mostly-empty labelled box. Widened to 296×76px (aspect
~3.89:1, matching the measured geometry) so both dimensions bind together; height is
unchanged so the bottom inset row (`ak`/`hi`/`nwhi`/`car`/`sam`) keeps one shared baseline.
`segmentMap.ts`'s own `INSET_RECTS.car` (the frame-drawing literal, intentionally duplicated
from `albers.ts` rather than imported) was updated to match — the two tables drifting would
mean the drawn frame border no longer matches the rectangle the coastline was actually fit
to.

**`PANEL_RECTS.pac` was reshaped the same way, for the opposite mismatch.** Guam + the Northern
Marianas measure dx=0.019902, dy=0.096983 — an aspect of **0.2052:1**, five times *taller* than
wide, since the chain is a ~617 km north–south arc only ~129 km across. The 100×76 placeholder
bound on height and left the islands a 15.6px-wide sliver. Height is what the rect is really
buying, and the number is forced rather than chosen: `dy` is the chain's latitude span in
radians, which no projection parameter changes, so `k ≤ h / 0.096983` at any width. Drawing
Tinian and Saipan 6px apart — one node diameter of clear air at r=2 — needs `k ≥ 2129` and
therefore **h ≥ 206.4px**. Hence **44×216 at k=2211**: Tinian–Saipan 6.232px, Guam–Rota 31.447px,
Guam–Saipan 72.232px, islands filling 44.0 × 214.4px of the frame.

**And a correct size in the wrong place is still a defect.** Grown upward from the tray, that
rect's frame lands *inside* the conterminous panel, whose drawn coastline occupies x[157.7,
802.3] y[18.0, 418.5] — and `globals.css`'s `.map svg path[data-panel]` fills every basemap path
with **opaque** `--panel-2` while `renderMapCore` draws frames *before* the basemap. Measured
on a 0.1px grid: **2,972 px² of drawn landmass inside that rect — 31.3% of it** — with all eight
glyph positions of the "MARIANAS" label inside drawn Arizona or New Mexico, two of the panel's
own islands painted over, ABQ and ELP swallowed on `/airport/SFO`, and 27 of its 147 arcs
crossing the box, across 25 served views. `fitPanels`'s `k` depends only on a rect's **width and
height, never its position**, so relocating to the top-left margin — frame (34,24)–(90,252),
which no lower-48 coastline reaches, since `us` land spans x[157.7, 802.3] — preserved every
figure above verbatim. There it measures **0 px² of land**, every label glyph clear, and exactly
one arc crossing on `/airport/SFO`: SFO–GUM, which terminates inside the panel and must enter it.
`pac` is therefore the one inset outside the bottom tray; the other five keep the shared 468
baseline. **`sam` is 181×76** and **`nwhi` is 40×76**.

*Every pixel figure in the two paragraphs above depends on the `us` fit, and nothing regenerates
them* — the rect they describe was never shipped, so no gate reads them: they are re-measured by
hand or they rot. Last measured at **k=892.2437** (#119). The conclusions have never rested on the
exact values, only on their order of magnitude, so re-measure on any fit change rather than
carrying these forward.

**A panel's aspect is measured under that panel's own parameters, and on the points `fitPanels`
actually reads.** Both halves bite. American Samoa's extent under `PANEL_PARAMS.pac` — the
sheared projection `sam` exists to avoid — is a different number from its extent under
`PANEL_PARAMS.sam`, and sizing a rect from the wrong one makes one dimension bind alone and
letterboxes the island under a comment claiming otherwise. And `fitPanels` reads
`BASEMAP_FIT_POINTS`, which the generator rounds to 3 decimals before taking the fit, so the raw
4-decimal committed file is not the right measurement either: the aspect is **2.3801:1** rounded
and 2.3884:1 raw, giving a width of 76 × 2.3801 ≈ **181** rather than 182 — 0.1px of slack
against 1.1. Height binds at k=42272.46 with the extent filling 180.9 × 76.0.

*Known limitation, stated rather than hidden, and purely a SOURCE limitation:* Natural Earth's
1:50m Tutuila is 8 vertices, and at `PAC_RDP_EPSILON_DEG` all 8 survive, so `sam` draws 50.5px of
outline per source vertex against the 4.4px `hi` and 6.0px `car` manage on that same denominator
— drawn perimeter over source vertices. Mixing that with a drawn-vertex denominator is what
produces a spurious "6–10px" comparison band. The shape is coarse at this scale because the source
is, not because anything was thrown away: the drawn outline spans 180.5 × 75.6px inside an extent
fitted to 180.9 × 76.0. It is sized for the tray anyway because the frame has to hold PPG's 2px
node and its 9px label; a fidelity-matched box would be about 30×13px, narrower than the word
printed on top of it.

**`car` has the same defect, at ~1,024 px² over drawn Florida and Texas — 4.6% of its rect,
against `pac`'s 31.3%.** It shipped in M7 Task 7b and is not fixed here. It is recorded
because `basemap.test.ts` asserts every other inset frame is clear of drawn land, and a test that
simply omitted `car` would read as though the property held everywhere.

**The generated paths carry no presentation attributes, so the paint is a stylesheet rule and
must stay one.** `basemapPaths.generated.ts` emits geometry alone — `<path data-panel="us"
data-name="AL" d="…"/>` — and `networkMap.ts`'s `<svg>` root sets no `fill`, so an unstyled
basemap inherits SVG's initial `fill`, which is **black**. `globals.css`'s
`.map svg path[data-panel]` supplies it: land `--panel-2`, border `--rule-2`, `stroke-width`
0.5.

The border is `--rule-2` and not `--rule` because the committed geometry is per-STATE
(`data-name="AL"`), so the borders are what render the shape of the country; `--rule` measures
1.14:1 against `--panel-2` land and disappears, while `--rule-2` measures 2.86:1. It stays a
hairline for the opposite reason — at 1px, 53 state outlines become a cage over the same area
the arcs occupy. Measured contrast for the arcs themselves: `--ink` on `--panel-2` is 14.45:1
and an `--ink-3` floor arc is 4.22:1, against WCAG's 3.0:1 minimum for a graphical object.


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
really carries rows whose origin and destination are the same airport — 359 of 1,047
fact-present airports have at least one over the trailing 12 months; ORD alone is 53 rows,
76,236 seats. Such a row's great circle has zero angular length, and `greatCircle`'s own
degenerate-endpoint branch (`om < 1e-9`) would emit `steps + 1` identical points — several
hundred bytes of polyline drawing an invisible mark directly on top of the origin disc. So
the drawn arc set always excludes any row whose two endpoints are the same airport
(`app/src/lib/map/segmentMap.ts`'s `drawableSegments`, which both maps filter through) — an
airport with a same-airport filing draws one fewer arc
than it has routes, 267 from 268 for ORD over 2025-05 → 2026-04, the fixed window
`app/src/lib/map/airportNetwork.test.ts` pins it at. But the row's seats stay in whatever total
the map states, passed in separately (`sameAirportSeats`), never derived
from the already-filtered arc list. A map that dropped these seats from its own total as well
as from its arcs would disagree with the stat strip directly above it on the same page. Both
halves are required; shipping one without the other is a defect.

**Step count is adaptive, not fixed** (`app/src/lib/map/greatCircle.ts`'s `stepsFor`): points
scale with the arc's length ON SCREEN (`round(projectedLengthPx / 22)`, floor 4, cap 48), not
with its angular distance — a 40px hop needs a handful of points and a transcontinental arc
needs dozens. Adaptive beats a flat 48 outright, and it also beats a flat 12 — most arcs on a
960px-wide canvas are short enough that adaptive's floor of 4 undercuts a flat 12, which would
still visibly polygonize the long arcs it does not help. The byte counts behind that comparison
are measured in `stepsFor`'s own header, against a named window. A great circle cannot
cross a panel boundary at all (above), so
`stepsFor` is only ever consulted for an arc `greatCircle` actually draws — a cross-panel arc
is the two projected endpoints, straight, regardless of its geographic length.

### The year track

**Do not build an animated 2015→2026 track** tweening the network growing and contracting,
however naturally it reads as "the one orchestrated motion moment" — this doc specified exactly
that until it was measured, and **the measurement kills it:** the map that shipped is
server-rendered SVG,
composed the same way the aircraft-mix chart is (`app/src/components/NetworkMap.tsx`,
`app/src/lib/map/`) — no client charting or mapping library in the render path — so animating
between years means shipping every year's geometry in one response rather than one page's
worth. Measured: ORD's arcs alone are ~64,287 bytes of polyline for **one** year;
twelve years would be roughly a megabyte, doubled again because this project's charts ship
twice per response — body **and** RSC payload (`docs/architecture/hosting.md` § "The SVG is
emitted twice per response").

**The shipped shape is a track of plain links, one server-rendered permalink per year** —
`/airport/<code>?y=<year>` (`app/src/lib/year.ts`, `app/src/app/airport/[code]/page.tsx`).
This is not a downgrade so much as the same principle this product already applies everywhere
else: "URL-encoded query state on every view; permalinks are the entire growth mechanic"
(CLAUDE.md). A year tick is a real, shareable, cacheable URL; an animation frame is neither. It
also honours `prefers-reduced-motion` for free — there is nothing to tween — and works with JS
off, like every other view in this app.

`y`'s value set is closed (the calendar years the dataset covers), which is exactly what lets
`proxy.ts` validate it before the response is cacheable rather than falling back to `/search`'s
blanket `no-store` — full reasoning in `docs/architecture/hosting.md` § "`y` on `/airport/:code`
— a closed set, so validate it rather than blanket `no-store`". The current year's tick is
marked partial when `dataAsOf()` falls short of December — presenting a four-month year
identically to a twelve-month one is the same class of false claim as a "first appearance
since 2015" that is nothing of the kind (CLAUDE.md); the track states which months the partial year actually covers rather
than leaving the asterisk to speak for itself.

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
> `mainline_grouped_with_carrier_filter` golden; it is a decision to make, not one to inherit.

---

## Entity pages

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
- **Chart.** The aircraft-type mix, above the table, over the **full** window — not the
  table's trailing 12. The two windows differ because a twelve-point fleet-mix stack shows
  nothing, and **the page states both**: a decade drawn under a line reading "Trailing 12
  months" claims a window it is not showing. It is drawn whenever the *full* window has
  filings, including when the trailing-12 table below is empty (12,115 of 23,041 pairs last
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
[`../architecture/pipeline.md` § Route slugs](../architecture/pipeline.md#route-slugs-two-orderings-that-are-not-the-same-thing).
All four entity pages export a `<link rel="canonical">` at that same resolved value — never
the requested spelling, so `/airport/sea` declares `/airport/SEA` rather than itself, exactly
the same resolver call the redirect above already makes. The canonical tag is not the whole head:
each page also exports Open Graph metadata — `og:title` naming the entity by **code and name**
(many surfaces drop the description entirely, and a link previewing as "SEA" has lost the thing
worth sharing), a description stating what the data view is plus that page's own honesty caveat,
and the `og:image` pointing at its card (§ The OG card). Open Graph is exported on the `ok`
outcome alone — a redirect and an ambiguous slug get the canonical tag and nothing more, and a
404 gets neither. `og:title` is code **and** name where the card's own title is code alone,
because the card has a subtitle line to put the name on and a flat metadata tag does not.

### The other three — what each one changes and what it must not

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

- **`/airport`'s Explorer link is ONE link.** `endpoint_airport_id` (filter-only,
  `filter_mode='either'`) compiles `origin OR dest` directly, so the page filters on it and
  links to the identical query — that link reproduces the page's own 53,373,806-seat SEA
  figure, not a half of it. Without that dimension the page can only offer `departures from
  SEA` and `arrivals into SEA` as two halves, and "every insight row is one click from the raw
  rows" holds only with a qualification.
- **`/carrier`'s two caveats render whether or not there is a table.** They qualify the
  *subject*, not the rows, and 39% of carriers have no rows in the trailing 12. They also sit in
  the content column, not the rail: the rail already carries a generic version on every data
  view, and a page-specific claim hidden among generic ones is not a claim.
- **`/aircraft`'s ramp means something else, so it says something else.** Covered in
  § Charts above: "less dense cabin" / "denser cabin", never "smaller metal", or the rail is the
  stale "how to read this" it exists to replace.

### The OG card — the same page, rasterized

Every entity page has one, rendered on demand at its `opengraph-image` child route. **The unfurl
is a different problem from the screenshot and it fires first**: a pasted link unfurls before
anyone sees the page.

**1200×630.** Top rule: the `UPGAUGE` wordmark left with the deploy's own host beside it in mono
`--ink-2`, and the `DATA AS OF: YYYY-MM` badge right — `--signal` text inside a `--signal`
hairline, the same first-class element every data view carries. Beneath it the title block: the
entity code in **mono, SemiBold, 42px**, the subject line under it in `--ink-2`. Then the stat
row — the page's own six stats, label in small-caps sans over the value in mono at 26px, ruled
above and below in `--rule-2`. The chart fills the remaining height. Ground is `--panel`. No
gradient, no photograph, no chrome.

**The chart is the page's chart, not a redrawing of it.** It arrives as `renderPlotToSvg`'s own
output with its `var()` tokens resolved to literals, embedded as a data URI, so the gap rules and
the two orderings (§ Charts) keep exactly one implementation and the card cannot contradict the
page it decorates. A rasterizer has no CSS-variable resolution and paints an unresolved `var()`
black — a card that renders successfully in the wrong colours — so the resolver **throws on an
unknown token** rather than passing it through, and a test parses `globals.css`'s `:root` block
and asserts the literals still agree with it.

**Numerics stay mono and tabular-figure.** The rule does not lapse at social-preview size: a card
is a data view, not a marketing asset. Both faces are subset and **baked into a generated
module** rather than read from disk — the runtime image copies `app/.next` and not `app/src`, so
a `readFileSync` under `src/` passes every host gate and fails only in the container.

**Derived measures carry the `computed` marker here too.** Load factor and average gauge are
ratios of summed numerator and denominator; a card that shows the figure without saying so
presents a computed value as a filed one.

**The unfiled-month count is VISIBLE TEXT, and that is the one thing the card does differently.**
The page states it twice — in the chart and in the chart's `aria-label` — and **an image has no
`aria-label`**. Rasterizing the page's chart therefore drops the accessible half of that
statement, so the count is rendered as a line of type instead. It appears only when there are
gaps: a card that says "0 unfiled months" is noise, and erasing a filing is the same dishonesty
as inventing one.

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
| **Unknowable** (a measure was queried and cannot be stated) | The measure cells render `—`, never `0` and never blank — the sum of no trusted values is not a measurement of nothing. The gauge rail keeps its axis and shows no tick. No below-floor treatment: an unknown departure count makes no claim about the floor. **Its cause is named per row and per page, never by the legend rail**, which is rendered on every view and so can only state that the mark is not a zero — and is painted in `--ink`, not `--limit`, because a dash is a data-availability mark and not an out-of-limit code. `Q` in the gutter where the cause is quarantine; the page's own foot where it has one. A zero denominator has neither, and the dash stands alone. On a card — no foot, no empty state, no `aria-label` — the sixth stat slot carries the quarantined count *where there are quarantined rows to count*, and the entity count otherwise. **All four entity cards compose it the same way** — `cardStats(totals, cardSixthStat(totals, quarantinedRows, fallback))` — and the rule is gated on **both** operands: the quarantined count displaces the entity count only where the totals are unknowable *and* quarantine is why. Keyed on the null alone it answers "Quarantined 0" on every page that simply filed nothing, naming the one cause it is not; keyed on the count alone it displaces the entity count on every page carrying a quarantined row beside honest traffic. Distinct from *Zero passengers*, which flew and is a measurement, and from *Not queried* below. |
| **Not queried** (the measure is absent from the row) | Draws **nothing** — no dash treatment, no axis, no glyph. The pivot templates emit only the measures a query selected, so a permalink that did not ask for `departures_performed` or `avg_gauge` has rows that make no claim about the floor or the gauge in either direction. Rendering the *Unknowable* treatment here states a finding the query never made: measured, a default top-25 `/explore` view put all 25 rows in it. |
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
for a full milestone *after* the correction had landed in six other places.

Route Birth Tracker rows must read **"re-entry, not first appearance"** and must **name the
carrier** — never "first ever", never "first appearance since 2015", and never "nobody flew it
last year". All three shipped wrong, and the first two were mandated by this very line while the
page still said otherwise — a rule in a doc does not enforce itself.
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
`t12_departures_performed >= 360`, the latter the more restrictive) and both are stated.

**`health_score` renders in a left-aligned `td.id`, not a `.num` cell** — a deliberate,
declared exception to "all numerics right-aligned, tabular-figure". The cell's value is
`formatHealthScore`'s output, either two decimals or the literal string "insufficient data",
and on Route Birth Tracker it is that string on 100% of rows. `DataTable`'s `kind` is per
column, not per cell. It keeps its monospace; it gives up the right edge. See the comment on
`buildColumns` in `app/src/app/watch/[preset]/page.tsx`.

The editorial frame is `.frame`: a left hairline in `--signal`, `--ink` text at 14px, no box.
The preset index is `.watch-list`: hairline-separated rows, no bullets, the linked title
carrying the weight and its frame muted to `--ink-2`. Both need a real CSS rule: without one
the site's only voiced line renders as plain body text beneath its own disclosures.

---

## Quality floor

Unannounced, non-negotiable.

- **Focus** is a 2px `--signal` outline at 1px offset, on every interactive element. Never
  removed.
- **Reduced motion**: N/A for the year track — plain, cacheable `?y=<year>` links (see § The
  map) rather than the animated slider the mockup shows, so there is no motion to reduce. Nothing on the site currently animates.
- **Responsive**: the legend rail collapses below 920px and moves beneath the content.
  Tables scroll horizontally within their own container — the page body never does, **at every
  width down to 265px**. That bound is below **WCAG 1.4.10's 320px reflow width**, so the
  guarantee covers every width the standard requires. Below 265px the body does scroll: `body`
  is a column flex container, so `.wrap` takes its own min-content rather than the viewport,
  and the search field's intrinsic width is that floor. Unlike the grid-track rule under
  § Layout and density, this one is a **constant** — the same 265px on `/`, `/explore`,
  `/airport/BET` and `/watch/new-routes` — not a threshold that moves with the query.
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
