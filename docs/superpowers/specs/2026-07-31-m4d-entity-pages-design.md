# M4d — `/airport`, `/carrier`, `/aircraft`

**Status:** design approved 2026-07-31. Completes M4.

**Goal.** Three more entity pages on the pattern `/route/<pair>` established in M4b and M4c:
a title block, a stat strip, a fleet-mix chart, one table, an Explorer link, and the legend rail.

This spec records what differs per entity and the measurements behind each decision. It does
not restate the shared page contract — that lives in
`docs/architecture/pipeline.md` § M4b and § M4c.

---

## The trap this milestone is most likely to fall into

**`app/src/proxy.ts`'s matcher is `["/explore", "/api/pivot", "/route/:pair"]`.** M4b's
Critical was that `/route/<pair>` shipped with `private, no-cache, no-store` because it was not
in that list, while `/explore` got the month-long CDN cache. M4d adds **three** more routes.

Each new page must be added to the matcher **and** to the pathname predicate that decides
cacheability, and each must get a served-build `Cache-Control` check in `app/smoke.sh` — the
absent header check is precisely why the M4b bug survived to final review. `hosting.md`
§ Cache-Control already states this rule; this milestone is its first test.

The proxy resolves the entity before the page runs so a 404 gets `no-store` while a real page
gets the long cache. Each new entity needs its existence check wired into that decision, or
its 404s will be cached for 30 days.

---

## Shared shape

| | |
|---|---|
| grain | `segment` |
| table window | trailing 12 months, as `/route` |
| chart window | full — `2015-01` → `asOf`, drawn range named honestly (M4c) |
| resolution | code → id via a fact-present-scoped `.sql` lookup, with a fail-loud collision guard |
| 404 | names the offending code, `no-store`, branded page |
| empty state | states the query in words, offers the widened permalink |

**Entity counts** (trailing 12 months / all-time, measured): airports 741 / 993 · carriers
70 / 114 · aircraft types 74 / 110. All three are small enough that a future prerender of the
finite entity set stays available (`hosting.md`).

---

## `/airport/<code>` — e.g. `/airport/SEA`

**Slug:** the IATA-style `code` from `dim_airport`. `lookup_airport_by_code.sql` already exists
(M4b) and already carries the fact-presence filter and the collision guard — **reuse it, do not
write a second one.** Its scoping is load-bearing: `is_latest` alone left 36 colliding codes,
including `AUS` resolving to both Austin-Bergstrom and an airport closed since 1999.

**Table:** carriers at the airport (13 at SEA, measured), mirroring `/route`'s carriers table.

**Stat strip:** seats, passengers, load factor, avg gauge, departures, carriers, destinations,
quarantined. Derived measures computed from summed numerator and denominator, never averaged.

**An airport is both endpoints.** Every query must match `origin_airport_id = X OR
dest_airport_id = X`, not origin alone. Measured at SEA over the trailing 12 months: 13
carriers, 141 destinations, 25 aircraft types, 53,373,806 seats. A page counting only
departures would silently halve the airport.

**Do not double-count.** A segment with SEA at both ends does not exist (same-airport rows are
excluded as non-routes, M4b), but a sum over `origin OR dest` counts each SEA segment once —
verify this against a hand-checked figure rather than assuming.

## `/carrier/<code>` — e.g. `/carrier/DL`

**Slug:** `dim_carrier.carrier_code`. Measured: **0 collisions** among fact-present carriers, so
the code is a key here — but scope the lookup to fact-present airlines anyway and carry the same
fail-loud guard. A reassuring zero in one scope is not uniqueness in another; that assumption is
exactly what produced M4b's Critical.

`CLAUDE.md` is explicit that `dim_carrier` holds the **current** code, not the point-in-time
one, and that this must never be presented as historical fact. The legend rail already says so
for `/route`; it must say so here, where the entity *is* the carrier.

**Table:** aircraft types operated (17 for DL, measured) — the fleet, which is this product's
subject. Routes (1,873) and airports (186) are too many for a first table and want the Top-N
builder that does not exist yet.

**Operating carrier is the grain.** A Delta-branded regional flown by Endeavor files as `9E`.
`/carrier/DL` shows what Delta *operated*, not what it marketed, and the page must say so —
otherwise the numbers read as wrong to anyone who knows the network. There is no
marketing-carrier field; do not infer one.

## `/aircraft/<short_name>` — e.g. `/aircraft/B737-8`

**Slug:** `dim_aircraft_type.short_name`, **path-safe-encoded**, scoped to fact-present types,
with a **fail-loud collision guard**. Never the raw `code`: `612` is the 737-700, not the A321,
and nobody pastes `/aircraft/614`.

**`short_name` is not directly usable as a path segment — this spec's own worked example proves
it.** 16 of the 111 fact-present `short_name`s contain `/` or a space, and they include
`A321/LR` — the type this spec uses to demonstrate the gauge ramp — and `B767-3/R`, which is a
band on the JFK–LAX chart. `/aircraft/A321/LR` parses as *two* path segments and can never match
a single dynamic segment, so matching `upper(short_name)` exactly 404s all 16. Found by Task 1
while building the lookup; the spec was wrong.

The slug transform is `/` → `-`, space → `-`, uppercased — measured **injective over all 111
fact-present types, 0 collisions** (`A321/LR` → `A321-LR`, `A320-1/2` → `A320-1-2`, `CRJ-2/4`
→ `CRJ-2-4`). Because the transform maps two characters onto one that already occurs in names
like `B737-8`, that zero is a property of today's data, not of the scheme: guard it exactly as
the `CE-180` collision is guarded, and let a future clash fail loudly rather than resolve
arbitrarily.

**The one collision, measured.** `CE-180` maps to **two** fact-present codes — `030` (CESSNA
180, 994 seats, 441 departures, 183 rows) and `031` (CESSNA 180A/B, 557 seats, 189 departures,
131 rows). In-window collisions are **0**. This is the `AUS` shape exactly: a zero in one scope
is not uniqueness in another, and M4a's invariant could not see the `AUS` pair because of how it
was scoped. So the guard is not decoration — it is the thing that turns this from a silent
last-write-wins into a loud failure. Decide and document what a colliding slug does; do not let
it resolve arbitrarily.

**Table:** operating carriers (7 for the B737-8, measured).

**Chart: stack by carrier, not by aircraft type.** The type-mix chart is degenerate here — the
page *is* one type, so it would draw a single band whose gauge ordering encodes nothing. Stacking
seats by operating carrier answers the better question: who adopted this type, and when.

**The gauge ramp stays meaningful, and this is measured, not assumed.** Carriers configure the
same airframe very differently, so ordering carrier bands by seats per departure still means
something and a darkening stack still reads as upgauge:

| type | lightest | darkest | spread |
|---|---|---|---|
| A321/LR | B6 172.3 | F9 230.0 | **57.7 seats (33%)** |
| A320-1/2 | AA 150.0 | F9 184.1 | 34.1 |
| B737-8 | AS 159.5 | SY 186.0 | 26.5 |

On `/aircraft` the ramp isolates *configuration* choice from *fleet* choice, which `/route`
cannot separate — the same metal, fitted a third denser by a low-cost carrier than by JetBlue.

**This requires the chart component to take its dimension as a parameter**, not to hard-code
`aircraft_type`. Keep the change to the component minimal and keep `pipeline/pivot.py` and
`app/src/lib/pivot/render.ts` byte-identical in what they emit — the goldens must not move.

---

## Reuse, explicitly

Build nothing that M4b/M4c already built. `AircraftMixChart` (generalized to take a dimension),
`toBands`, `findCrossover`, `renderPlotToSvg`, `DataTable`, `LegendRail`, `GaugeRail`,
`ReasonCode`, the empty state, the branded 404, `resolve.ts`, and the pivot layer all stand. If a
task finds itself writing a second version of one of these, that is the signal to stop and
generalize the first.

**No new SQL beyond the two reverse lookups** (`carrier_code` → `airline_id`, `short_name` →
`code`). Everything else is the existing pivot. `make goldens` must leave
`sql/03_queries/goldens/` byte-identical.

## Testing

- **Unit** — resolution and its collision guard for each entity; the `origin OR dest` rule for
  airports; the carrier-stacked chart's band ordering.
- **Served build** (`app/smoke.sh`) — the tier that matters. For each of the three pages: it
  renders, it carries the project `Cache-Control`, its 404 names the code and is `no-store`, a
  real code renders and a bare id does not, and the chart's SVG is in the HTML. M4c's harness
  bug (`grep -q` + `pipefail` → false `ok` on `check_not`) is fixed; do not reintroduce `-q`.

## Out of scope

The arc map, `/watch`, the Top-N builder, the load-factor chart, the seasonality heatmap, OG
cards. Those are M5.
