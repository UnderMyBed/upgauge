# Feature set

## The Explorer — the base layer (build this first)

A pivot surface: pick dimensions, measures, filters, time range → table + chart.

**Dimensions:** month/quarter/year · operating carrier · **carrier grouping (operating vs.
mainline-group toggle)** · origin · dest · route · **city market** · origin/dest state ·
aircraft type · aircraft group · distance group

**Dimension columns display codes, not the catalog's ids.** A carrier column shows `DL`,
not `19790`; an airport column shows `SEA`; `route` shows `PDX–SEA`. City market has no code
of its own, so its name renders directly. The full cell rule — and why the code is current
identity rather than a point-in-time filing — lives in `docs/design/system.md`'s "The data
table" section.

**Then the things that make it good:**

1. **URL-encoded query state.** Every view is a permalink. The entire growth mechanic for a
   nerd tool — people paste links into forums and Discords. Don't skip it.

   **The encoding is a frozen public contract from the first shipped link.** Once permalinks are
   in forum posts, changing the format breaks them, and nobody will report it. So:

   - **Short, stable keys**, frozen from the first shipped link. Not a base64 JSON blob: that
     is opaque in a forum, unreadable at a glance, and impossible to hand-edit — and
     hand-editing a permalink is exactly what this audience does. Reference implementation:
     `pipeline/urlstate.py` (`encode`/`decode`); M3b's TypeScript port must match it exactly.

     | Key | Meaning | Example | Required? |
     |---|---|---|---|
     | `v` | version | `v=1` | yes |
     | `k` | grain | `k=seg` / `k=route` | yes |
     | `d` | dimensions, comma-separated | `d=year_month,op_airline_id` | yes |
     | `m` | measures, comma-separated | `m=seats,load_factor` | yes |
     | `t` | time range | `t=2024-01:2024-12` | yes |
     | `f` | filter, repeatable | `f=origin_airport_id:14771,13487` | no |
     | `s` | sort, `-` prefix = descending | `s=-seats` | no |
     | `n` | limit | `n=50` | no — defaults to `100` |
     | `g` | grouping | `g=op` / `g=ml` | no — defaults to `op` (operating) |

   - **Versioned** (`v=1`), so a future incompatible change can migrate rather than silently
     misread an old link.
   - **Decode is total.** An unknown key, a duplicate non-`f` key, or a dimension not on the
     allowlist, is a rejection with a message — never a silent drop to a default or a silent
     last-wins. A permalink that quietly renders a *different* query than it encodes is worse
     than one that errors, because the screenshot still looks authoritative. This does *not*
     extend to `n`/`g` being merely absent: those two keys have a documented default (above)
     that both `encode` and a hand-editor can legitimately omit, and applying it is not the
     kind of silent misreading the totality rule targets — a value that *is* present and
     invalid is still rejected the same as any other key. Identifier/structural validation
     (unknown dimension, measure, sort key, grain, grouping, empty lists, non-positive limit)
     is reused as-is from `pipeline.pivot.render_pivot` — one allowlist, not two. URL syntax
     that `render_pivot` can't see (`v` itself, unknown or duplicate query-string keys, the
     shape of `t` and `f`, `n`/`v` as integers) is validated in the codec.
   - **Filter values are percent-encoded individually**, because they are the one piece of
     free text in the format and can legally contain the delimiters (`,`, `:`, `&`, `=`) the
     format itself uses. This is what makes the raw query string load-bearing: once a web
     framework decodes or re-encodes the query, a data `,` and a structural `,` are the same
     byte and the distinction is gone for good. Both server entry points therefore read the
     untouched request line via `proxy.ts`, never `searchParams` and never a normalized
     `request.url` — see
     [hosting.md § `proxy.ts` is load-bearing](../architecture/hosting.md#proxyts-is-load-bearing--both-query-entry-points-break-without-it),
     which records the measured failure this caused on both `/explore` and `/api/pivot`. Every other key carries plain allowlisted-identifier text and needs
     no escaping. Decoding never uses `urllib.parse.parse_qsl` — see the "Escaping" section
     of `pipeline/urlstate.py`'s module docstring for why an eager, whole-string unquote
     would silently corrupt a percent-encoded structural comma.
   - Round-trip tested both directions: `state → url → state` and `url → state → url` —
     including a filter value containing a comma, an ampersand, and a percent sign, and both
     `grain="route"` and `grouping="mainline"` (not just the defaults).
2. **CSV / Parquet export of any result.** Nerds want the data, not just the picture.
3. **Compare mode.** Pin 2–5 entities (routes, carriers, airports, *aircraft types*) and
   overlay on one chart. Most-requested feature in every data explorer ever built.
4. **Rolling-12 toggle.** Month / quarter / rolling-12. Rolling-12 kills seasonality and
   makes trends legible. Skipping it gives unreadable sawtooth charts. **Deferred to M3b**: it
   is a window over the pre-aggregate rather than a plain `GROUP BY`, so it is a different query
   shape, and its only consumer is the time-series chart. Building it before the chart exists
   means guessing what the chart needs.
5. **Seasonality heatmap.** Year × month grid per route. Cheap, satisfying, and the *honest*
   way to present an "empty plane" claim.
6. **Generic Top-N builder — shipped, M6.** "Top N `<dimension>` by `<measure>` in
   `<period>`" is an existing pivot query, not a new one: one dimension, sorted descending on
   a measure, limited (`app/src/lib/topn.ts`'s `topNQuery`/`topNPermalink`, plus `DataTable`'s
   `rank` prop). The `/watch` presets are **not** saved instances of it — every
   `meta_pivot_measures` row is a single-window aggregate and the presets need deltas against
   `mart_route_health` — they share only the rank column.
7. **The omnibox — shipped, M5.** `/search?q=...` (`app/src/lib/search.ts`,
   `app/src/app/search/page.tsx`, `sql/03_queries/search_by_name.sql`). One field resolving
   `PDX` · `Portland` · `Alaska` · `AS` · `A220` · `PDX-AUS`. Sounds trivial. It is the whole
   UX. Resolution order: a route-pair pattern (`-`, an en dash, or a space, case-insensitively)
   → an exact code in any of the three namespaces → a name substring across all three. A
   unique match 307-redirects (not 308 -- this is a live resolution over data that can change,
   not a second spelling of one fixed URL); no match names the query and the namespaces
   checked, offering the Explorer; an unbounded substring hit list discloses the cap (50) and
   the true count rather than truncating silently.

   **A code can be a real match in two namespaces at once, and the omnibox must not silently
   pick one.** Measured, fact-present, `is_latest`-scoped: exactly three codes are both an
   airport and a carrier -- `LNY` (Lanai Airport / Western Aircraft dba Lanai Air), `NEW`
   (Lakefront / New England Airlines Inc.), `WST` (Westerly State / Friday Harbor Seaplanes).
   `LNY` is the sharpest of the three: the carrier is named after the airport, so a
   silently-chosen answer would still read as plausible -- the same failure shape as the `AUS`
   airport-id collision and `/aircraft/CE-180`'s two-BTS-codes-one-short-name collision,
   documented in `docs/data/invariants.md` § Entity resolution. All three codes render as a
   two-way choice instead. Airport ∩ aircraft and carrier ∩ aircraft are both 0 today, but that
   is a property of the current dataset, not a structural guarantee, so the guard checks every
   namespace rather than trusting the count.

   A name substring ranks a result whose name STARTS WITH the query above one that merely
   contains it, ties broken by the underlying query's own order -- no fuzzy distance, no
   traffic-based boost, both of which are numbers nobody could justify. `Portland` matches
   four fact-present airports, not three -- `HIO`, `PDX`, `PWM` (Maine, not Oregon), `TTD` --
   and `Alaska` returns 8 rows (`DUT` Unalaska Airport plus 7 carriers) where the ranking is
   what puts `AS` Alaska Airlines ahead of the `DUT` substring false positive.
8. **Methodology surface.** The class filter, operating-carrier keying, the lag, the
   quarantine rules. Trust feature; also free SEO content. The design session may fold this
   into the UI rather than a standalone page.

## Entity pages (canonical hubs, good for SEO)

| Route | Contents |
|---|---|
| **`/route/PDX-AUS` — shipped, M4b + M4c** | Title block (both airport names), a stat strip (seats, passengers, load factor, avg gauge, departures, carrier count, quarantined count — load factor and avg gauge computed as ratios of the summed rows, never averaged), **the aircraft-type-mix chart** (M4c), a carriers table (one row per operating carrier over the trailing 12 months, resolved to codes, not ids), a link into the Explorer for the identical query, and the legend rail. **The chart and the table cover different windows and the page says so**: the chart is the full 2015-01 → `asOf`, because a twelve-point fleet-mix stack shows nothing (the A321's rise on JFK–LAX takes eight years to read); the table is the trailing 12. The chart is drawn whenever the route has any filings in the full window — including when the trailing-12 table is empty, which is 12,062 of 22,950 pairs (measured), i.e. the common case, not an edge one. A pair with nothing in either window draws no chart at all: the empty state already states that finding in words, and a second panel repeating it is card soup. **Months the pair filed nothing in break the area rather than being drawn across or zero-filled**, and the chart says how many there were — 62% of pairs have at least one, and HNL–LAS's six fall inside the COVID band. |
| **`/airport/SEA` — shipped, M4d, network map + either-endpoint filter added M7** | The same shape as `/route`, with one thing that changes every figure on it: **an airport is both endpoints.** Every stat, row and chart band counts `origin = X OR dest = X`, and the page says so in words. An origin-only page is not visibly broken — it renders everything in the right shape and is silently about half the airport (SEA reads 26,710,000 seats instead of 53,373,806). Stat strip adds **Destinations** (143 at SEA: distinct other endpoints, counted once each, excluding SEA itself — its own same-airport filings stay in every measure because they are real activity). Table is one row per carrier over the trailing 12; chart is the full window, stacked by aircraft type. **The Explorer link is ONE link, as of M7 Task 3** — `endpoint_airport_id` (filter-only, `filter_mode='either'`) compiles `origin OR dest` directly, so the link reproduces the page's own 53,373,806-seat figure rather than a half of it; through M6 the pivot could not express this and the page offered two half-links instead. The network map (below) is now built too — still unbuilt here: capacity YoY, carrier share, routes added/dropped. |
| **`/carrier/DL` — shipped, M4d, Top-N tables added M6 Task 4** | The same shape again, one dimension over: the table is **aircraft types operated** (17 for DL), because the fleet is this product's subject. Below it, **Top routes** and **Top origin airports** — DL's first two callers of the Top-N builder (`app/src/lib/topn.ts`, shipped M6 Task 3) — rank the 1,873 distinct routes and, headed exactly that rather than "airports served," the **186 origin-only** airports DL touches over the trailing 12 months. Origin-only, not either-endpoint, is load-bearing here, but not because the filter is missing — M7 Task 3 built `endpoint_airport_id` and `/airport` uses it. The real reason: ranking airports means grouping BY the endpoint dimension, and `endpoint_airport_id` is `filter_only` (it can narrow a query to one fixed airport, which is exactly what `/airport` needs, but it is rejected as a grouping dimension the same way it would double-count a row into both its origin's and its dest's group) — so this table stays origin-only until a groupable either-endpoint dimension exists, which is on no current backlog list. DL's either-endpoint count is 188 against 186 origin-only, a small gap today but not a guarantee. Two things this page has to say out loud, and does, on every carrier and whether or not it has a table: **"Operated, not marketed"** — a DL-branded regional flown by Endeavor is counted under `9E`, and there is no marketing-carrier field to infer one from — and that the code and name are BTS's **current identity**, not what the airline filed under at the time. 39% of carriers have no rows in the trailing 12 (VX stopped filing in 2018-03) and still get a full-window chart. Still unbuilt: the network map, the operating vs. mainline-group toggle, gainers/losers. |
| **`/aircraft/B737-8` — shipped, M4d** | **The differentiator, and the first page whose chart is not the same chart.** A page that *is* one aircraft type makes the type stack degenerate — one band — so it stacks by **operating carrier** instead: who adopted this type, and when. The ramp then encodes *configuration* rather than fleet, which `/route` cannot separate (A321nXLR over the trailing 12: B6 at 172.3 seats/departure, F9 at 230.0 — a 33% spread on the same airframe; 176.0 → 230.0, 31%, over the full window the chart draws — `docs/design/system.md` § Charts tabulates both), and the legend rail's wording travels with it. **The URL slug is not the BTS code and not the short name either**: 15 of the 112 fact-present short names carry a `/` or a space, so `/aircraft/A320-1/2` is two path segments and can never be a page — `/` and space become `-`, uppercased. `/aircraft/CE-180` names two airframes that both really flew and is a 404 that names and links both rather than picking one. Still unbuilt: where it flies, stage length, the map. |

**`/route/<pair>`'s URL is alphabetical by airport code** (`/route/BNH-HPN`, not the storage
order `HPN-BNH`) — predictable from the two codes alone, no database lookup needed. A
non-canonical but resolvable pair (`/route/LAX-JFK`, `/route/HPN-BNH`) 308-redirects to the
canonical form; an unresolvable code 404s naming it; two real airports with no scheduled
service in the window render a 200 with the finding stated in words and the widened-to-2015
window offered, never a blank panel or a silent fallback. Full mechanics, including why the
naive `origin/dest IN (...)` filter is wrong (18,895-seat inflation, measured on JFK–LAX):
[`../architecture/pipeline.md` § M4b](../architecture/pipeline.md#m4b--the-route-page).

**All four entity pages keep that contract**, so the URL rules are worth stating once: one
canonical URL per entity, every other spelling 308s to it (`/airport/sea`, `/carrier/dl`,
`/aircraft/a320-1-2`), and a 404 always names the offending code and says *which* of the ways it
failed — an unknown code and a real one this domestic-only dataset carries no rows for are
different findings, and `/route/JFK-LHR` and `/airport/LHR` both say so. **Only what resolves is
CDN-cached**: 200s and 308s get `HTML_CACHE` (M5 Task 7 shortened this from the project's 30-day
value to `s-maxage=3600` for `/explore` and all four entity pages — see the citation below), 404s
get `no-store`, because a 404 here is a statement about the current dataset and the dataset is
rebuilt monthly ([`../architecture/hosting.md`](../architecture/hosting.md)). **The carrier 404
makes the same split the other three do, as of M5 Task 6**: `sql/03_queries/
lookup_carrier_code_exists.sql` mirrors the airport version, so `/carrier/ZZ` 404s "unknown
carrier code" and `/carrier/PA` 404s "recognized by BTS ... none of which has filed", naming
all three of `PA`'s holders (two really are Pan American, the third — Florida Coastal Airlines —
merely shares the code) rather than picking one.

**The pages cross-link (M5).** Every resolved dimension cell in every table — `/explore` and
all four entity pages, since they share the one `DataTable` component — links to the entity
page it resolves to: `/route/JFK-LAX` names Delta and now links to `/carrier/DL`, `/carrier/DL`
names an aircraft type and links to `/aircraft/<slug>`, and so on. A cell links only when it
resolved to a real code and that dimension has a page — a city market, an unresolved id, or a
bare `year_month` never gains a fake link. `/explore`'s route cell is the one dimension that is
not a single id (its `column_expr` spans two airport columns), so its link is built and checked
separately, and it is the one place the milestone's sharpest trap lives: the cell displays the
two codes in **airport-id** order but the canonical `/route/` URL is alphabetical by **code**,
and those two orderings disagree for 154 of 22,420 pairs (`CLAUDE.md`, M4b) — reusing the
displayed order as the link would be silently wrong for every one of the 154. That same cell is
also the one that must *refuse* to link: 530 same-airport pairs carry real traffic but
`/route/ORD-ORD` is a 404 by design, so a route cell whose halves match renders as text. Full
mechanics: `docs/design/system.md` § The data table.

**Three links live outside the tables**, because the tables alone left the graph half-connected —
`/airport/` and `/route/` were 23,465 of the sitemap's 23,689 URLs (23,694 as of M6 Task 7's
`/watch` pages, which don't change this 23,465 numerator) with no inbound internal link
at all, crawlable but not browsable. So `/route/<pair>`'s title block links both airport names to
`/airport/<code>`, and the top bar's wordmark links home from every page. Both were in M5's spec
and both were dropped when it became a plan; the whole-branch review caught them by walking the
graph from the front door, which no per-task review could have done.

**M6 re-created the same island one milestone later, and the third link is the fix.** `/watch`
shipped with **zero** inbound internal links — nothing outside `app/src/app/watch/`, `lib/watch.ts`,
`proxy.ts` and `sitemap.ts` referenced it, so the product's entire editorial surface was
reachable only by typing the URL or through `/sitemap.xml`. The top bar now carries a standing
`/watch` link (`TopBar`'s `nav.nav`, `prefetch={false}` for the wordmark's own reason), which
covers all eleven pages in one place, and the front door names it in prose. `TopBar.test.tsx`'s
"links to /watch from every page" is what makes removing it red. **The lesson generalizes: a
new top-level route is not shipped until something already-reachable links to it**, and neither
`sitemap.ts` nor `proxy.ts`'s matcher counts, because both are satisfied by a page no visitor
can navigate to.

> **Build the aircraft-type-mix chart before the load-factor chart.** Everyone does load
> factor. The gauge story is what makes this yours.

## Maps

Tied to entities, never global. A global all-routes map is a hairball.

| Map | Encoding | Why |
|---|---|---|
| **Airport network** `/airport/PDX` — **shipped, M7** | Arcs from one node; weight = seats, style = LF | A **year track** (`?y=<year>`, M7 Task 9) → step through the network growing/contracting one server-rendered permalink at a time. The screenshot people post. |
| **Carrier network** `/carrier/OO` — [tracker](https://github.com/UnderMyBed/upguage/issues) | Full network, **filterable by aircraft type** | "Every route SkyWest flies the E175 on" is one filter and a legible map. |
| **Aircraft type** `/aircraft/A220` — [tracker](https://github.com/UnderMyBed/upguage/issues) | All routes flown by a type | Genuinely novel. |
| **Diff map** — [tracker](https://github.com/UnderMyBed/upguage/issues) | new vs. dropped vs. downgauged | Death Watch + Birth Tracker rendered *spatially*. 10× more visceral. |

**Skip:** a map on the route detail page. A single arc is not information.

**Tech: not deck.gl, not MapLibre.** The spec called for deck.gl's `GreatCircleLayer` over a
MapLibre basemap; what shipped for the airport network map is a from-scratch,
dependency-free, server-rendered SVG engine (`app/src/lib/map/`, M7 Tasks 4-8) — the same
"in the served HTML, visible with JS off" property the aircraft-mix chart established,
extended to a map. No tiled basemap, ever, same reasoning as below, but also no map *library*
at all: a great-circle arc drawn over a projected, pre-simplified Natural Earth coastline
(`docs/design/system.md` § The map has the full account). The three unbuilt maps are
expected to reuse this same engine rather than introduce deck.gl/MapLibre after all — none of
them calls for a client-side mapping library, and the whole point of the from-scratch engine
was to need none.

**Why each unbuilt map is worth building stays here; when it happens lives in the
[tracker](https://github.com/UnderMyBed/upguage/issues).** This table is design rationale, not
a schedule.

> 💰 **No tiled basemap.** Mapbox tiles are usage-priced. Render a **Natural Earth
> coastline/state GeoJSON** as a static layer beneath the arcs — zero tile cost. If you later
> want real tiles, use **PMTiles**: one file on object storage, no tile server.

## Insight presets (`/watch`)

Four leaderboards over `mart_route_health` with editorial framing. Each row links back into the
Explorer for the raw monthly rows behind it. Ship whichever three are ready first; **lead with
Gauge Watch.**

**Not saved Explorer queries.** This section, `system.md` and the shipped `/watch` index all
said they were, through M6. They cannot be: every `meta_pivot_measures` row is a single-window
aggregate and **no pivot measure expresses a delta** (there is no `gauge_delta` in the
catalog), while every preset here ranks on one — Δ load factor, log Δ gauge — against the prior
12 months, which only `mart_route_health` computes. The presets share `DataTable`'s rank column
with the generic Top-N builder (`app/src/lib/topn.ts`) and nothing else. The claim is checkable
by any reader who tries to reproduce Gauge Watch in `/explore` and cannot, which is why it is
called out here rather than quietly deleted.

- **Gauge Watch** — biggest upgauges/downgauges, trailing 12mo. *The differentiator.*
- **Empty Planes** — lowest trailing-12 load factor, with a `gauge_t12 >= 50` floor (min 30
  departures/mo). *The hook.* "Seasonally-adjusted" is the wrong description for `lf_t12`: it
  is a trailing-12-month **sum** of passengers over seats, not a seasonally-decomposed model,
  so a full year of months is already summed together and seasonality is gone by construction
  — there is no separate adjustment step, and no code computes one. The `gauge_t12 >= 50` floor
  excludes very-small-aircraft operators (e.g. a 9-seat commuter) whose load factor swings
  wildly on a handful of passengers and would otherwise dominate a "lowest LF" ranking with
  noise rather than a genuinely underperforming route.

  **Two floors, and the page must state both.** The "min 30 departures/mo" above is
  `t12_departures_performed >= 360` in `watch_empty_planes.sql` (30 × 12), and it is the **more
  restrictive** of the two — 12× stronger than `mart_route_health`'s own 30-per-year floor,
  which every row already clears. Through M6 the page disclosed only `gauge_t12 >= 50`. A page
  that enumerates its filters and omits one cannot be reproduced from what it says; Death Watch
  carries the gauge floor and **not** this one, which is what makes the disclosure per-preset
  rather than shared.
- **Route Birth Tracker** — a carrier × O&D pair that filed **nothing in the prior 12 months**
  and something in the trailing 12. Label it **re-entry, not first appearance** — and
  emphatically not "first appearance since 2015", which is what this line said through M6 and
  what `/watch/new-routes` told every visitor. `watch_new_routes.sql` selects
  `p12_months_present = 0` and nothing else; `mart_route_health` carries **no lookback past the
  prior 12 months**, so the query cannot distinguish a brand-new route from a resumed one.

  Measured on the 2026-04 warehouse: **334 of the 688 qualifying rows (48.5%) filed in at least
  one month before the p12 window**, including **17 of the 25 the page renders**. Worst case
  `MQ AZO–ORD` — **93 distinct months filed, first filed 2015-01** — was presented as brand-new
  service. Also `9E DTW–MDW` (55 months), `9E AUS–RDU` (53), `OH DAY–ORD` (38), `F9 LAX–ORD`
  (31). The old reasoning here ("a route flown in 2014 and resumed in 2019 looks new") had the
  right failure mode and stopped one rung too high: a route flown in **2023** and resumed in
  2025 looks new too, and that is 48% of the rows. The mirror-image limitation is unchanged — a
  route that stopped and resumed *within* the p12/t12 windows has some p12 presence and never
  appears here at all.

  **And the grain is the pair, not the route — so "nobody flew it last year" is false too.**
  `mart_route_health` is one row per **(op_airline_id, undirected route)**, which is why this
  bullet says "carrier × O&D pair". `p12_months_present = 0` is therefore silent about every
  *other* carrier on the same airport pair. Measured: **521 of the 688 qualifying rows (75.7%),
  and 25 of the 25 the page renders**, had a different carrier flying that pair inside the p12
  window. The page's own #1 row, `AS HNL–ITO`, ranks first while HA, UA and WN filed
  **1,787,347 seats** on that pair in the prior window — **4.9×** the subject's own trailing 12.
  `AS DEN–SAN` had **eight** other operators and 1.88M seats; `F9 JFK–LAX` four and 3.19M, 25×
  its own. This one is worth recording as a process finding, not just a data one: it was
  **introduced by the fix wave that corrected the "since 2015" claim** — "new service nobody
  flew last year" read as the *accurate* half of the old sentence and was carried over
  unexamined, so a wave fixing one false claim shipped another of the same class. Any sentence
  about a `mart_route_health` row names the carrier, or it is a claim about a route the query
  never made. All of it is stated on the page (`ReEntryNote`). *Cheap + fun.*
- **Route Death Watch** — risk score desc. *Follows once the score model's in.*
- **Time-machine diff** — "PDX, Jul 2019 vs Jul 2025." Added/dropped/upgauged side by side,
  table + diff map. *Most shareable artifact in the product.*

---

## Route Health score (v0 — deliberately dumb)

Per (op_airline_id, **undirected** route), trailing 12 months vs. prior 12 — `mart_route_health`,
see [../data/model.md](../data/model.md) for the SQL-level rules:

| Component | Signal | Scored? | Oriented so higher = healthier |
|---|---|---|---|
| `lf_delta` | Δ load factor | **yes**, 0.25 | as-is |
| `ln(gauge_t12 / gauge_p12)` | log Δ mean seats-per-departure | **yes**, 0.25 | as-is (a **downgauge is the warning sign**) |
| `ln(t12_departures_performed / p12_departures_performed)` | log Δ departures performed | **yes**, 0.25 | as-is |
| `completion_factor` (capped at 1.5) | departures_performed / departures_scheduled (trailing 12mo) | **yes**, 0.25 | as-is |
| `capacity_delta` | Δ total seats | **displayed only, not scored** (M6) | as-is |

`health_score` = **equal 0.25-weighted** z-score composite of the four scored components
above, each clamped to `±3` before summing, so `|health_score| ≤ 3.0` by construction. Equal
weights, not fitted — this is v0 and deliberately dumb; any other weighting would be an
invented number. **`capacity_delta` is excluded from the score, not merely down-weighted**: in
log space it is *exactly* the sum of the gauge and frequency axes above (`seats = departures ×
gauge`), so scoring it scores those two a second time — see
[../data/model.md § The four-axis composite](../data/model.md#the-four-axis-composite)
for the identity, the measured residual, and the before/after contribution table. It still
appears in the UI as a component, since the components (not the score) are the insight.
Windows are the latest 12 calendar months present (globally, not per-route) vs. the 12 before
that. Excludes routes with **<30 departures *performed*** (not scheduled) in the trailing
12mo.

**A route with no prior-12mo data gets `NULL` deltas and a `NULL` score, never an enormous
"improvement."** It still appears as a row — that row is the Route Birth Tracker's input.
Measured over the full 2015–2026 window: 688 of 8,080 routes are new in exactly this sense
(`p12_months_present = 0`).

**Show the components in the UI, not just the score.** The components are the insight; the
score is a sort key. Label it plainly as a heuristic. Do not over-engineer this.

### `health_score` is `NULL` for three reasons — a route unrankable for lack of a filed schedule must not render as unhealthy

Measured over the full 2015–2026 window (`t12 = 2025-05..2026-04`, `p12 = 2024-05..2025-04`):
**813 of 8,080 routes** have `health_score IS NULL`, for three distinct reasons — which
**overlap by 55 routes, so never sum them.** Full SQL-level accounting:
[../data/model.md § Window rule, floor, and the NULL-prior-window trap](../data/model.md#window-rule-floor-and-the-null-prior-window-trap).

1. **No prior window — 688, the largest group.** A
   genuinely new route (`p12_months_present = 0`). Correctly has no deltas to show.
2. **Zero-measure prior window — 0 today.** The prior window is
   technically "present" but filed zero seats and zero departures, so the ratio is undefined
   the same way division by zero is. Empty in the current window — a property of which 24
   months happen to be the trailing window right now, not a structural absence of the case.
3. **Zero scheduled departures — 180.** `completion_factor` is
   undefined when `t12_departures_scheduled = 0`, which BTS allows for on-demand/
   charter-style operators that file real performed flights against no filed schedule at
   all. Unlike the other two, this route usually has known `lf_delta`, `gauge_delta`,
   `capacity_delta`, and `frequency_delta` — only `completion_factor` (and therefore the
   composite score) is unknown.

**UI requirement: a `NULL` `health_score` must never render as "unhealthy."** All three
groups are `NULL` for a data-availability reason, not a low-score reason — sorting or
filtering that silently treats `NULL` as the bottom of the range would misrepresent up to
688 routes (the largest of the three groups today — "no prior window," not "zero scheduled
departures," which was largest only in the smaller 2015–2017 measurement) as failing on
completion when the real story is "no schedule was ever filed to complete" or "this route
didn't exist yet." Render these rows with an explicit "insufficient data" state,
distinguishable from a genuinely low score, and — for the zero-scheduled-departures group —
still show the four known components even though the composite can't be computed.
