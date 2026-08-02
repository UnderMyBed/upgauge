# Upgauge

A structural intelligence layer over US DOT / BTS airline data. Answers: *"Is this route
healthy, and what is the airline about to do to it?"* Not a flight search tool, not a fare
tracker, not real-time.

**`docs/` is the source of truth — start at [docs/README.md](docs/README.md).** This file
records the rules that are easy to violate accidentally. It does not restate the docs.

## Working agreements

### Docs are part of every change

A change to behavior, a data rule, or a decision **is not done until the relevant doc
reflects it — in the same commit.** Not a follow-up, not a TODO.

**Decompose findings into the topic docs. Never add a new markdown file per
investigation.** Review notes, spike results, and audit findings belong in the file that
owns the subject — `docs/data/invariants.md`, `docs/architecture/hosting.md`, and so on.
One-off artifact files fragment the truth, go stale silently because nothing forces a
revisit, and end up stating the same rule three ways.

**Keep evidence attached to the rule it justifies.** Measured counts, distributions, and
prices go inline next to the constraint they support. A rule without its evidence gets
re-litigated or "simplified" by someone who doesn't know why it exists.

### Use the superpowers skills

Invoke the applicable skill before starting a unit of work, and say which one:

| Situation | Skill |
|---|---|
| Any creative/design work, new feature | `superpowers:brainstorming` **first** |
| A spec or requirements → multi-step work | `superpowers:writing-plans` |
| **A written plan → doing the work** | **`superpowers:subagent-driven-development`** |
| Implementing a feature or bugfix | `superpowers:test-driven-development` |
| A bug, test failure, unexpected behavior | `superpowers:systematic-debugging` |
| Before claiming anything works/passes | `superpowers:verification-before-completion` |

**A milestone is never hand-walked phase by phase in the main conversation.** M1 was, and it
cost real quality: the phase-1 "BTS encoder bug" claim survived four phases before phase 5
disproved it, and `zero_seats`, the `CARRIER`/`UNIQUE_CARRIER` direction, and the
append-only raw rule each shipped wrong and got corrected two phases later. A plan file with
one task per unit of work, each dispatched to a subagent that reports back, is what catches
that at the task boundary instead of three commits downstream. Plan → tasks → subagents.

TDD matters most here: the data invariants are written as **failing tests before** the
pipeline that satisfies them. That is both this project's rule and the skill's shape.

## Status

**M3, M4, M5, M6 and M7 are COMPLETE — M3a, M3b, M4a, M4b, M4c, M4d, M5 (Tasks 1-8), M6
(Tasks 1-8), M7 (Tasks 1-10).** All four entity pages ship, cross-linked, with an omnibox, a
sitemap, a fifth surface (`/watch`), and — as of M7 — a real map. M3a's Explorer pivot query
contract — templates
(`sql/03_queries/pivot_segment.sql` / `pivot_route.sql`), the allowlist as catalog objects
(`meta_pivot_dimensions` / `meta_pivot_measures`), the CI-only Python reference
implementation (`pipeline/pivot.py`, `pipeline/urlstate.py`), the mainline-grouping toggle,
the URL state codec, and the golden fixtures
(`sql/03_queries/goldens/{pivot,urlstate}.json`, `make goldens`) — is done. `make build` runs
`sql/02_marts/` into `upgauge.duckdb` (6 catalog views + `fct_route_month` +
`mart_route_health` + the 2 pivot-vocabulary catalog views); `make verify` proves both the
Parquet layer and the database layer reproducible across two from-scratch builds —
`parquet: 17 artifacts byte-identical`, `database: 10 objects identical`. 443 Python tests
green, zero join orphans. `data/raw/` holds the full 2015–2026 window.

M3b ported that contract into the Next.js app and wired it end to end: the TypeScript pivot
renderer and URL codec (`app/src/lib/pivot/`), the read-only DuckDB query layer
(`app/src/lib/db.ts`), the `/api/pivot` route handler, the `DataTable` / `GaugeRail` /
`ReasonCode` / `LegendRail` components implementing the gauge rail, reason-code gutter and
methodology rail, and `/explore?<permalink>` (`app/src/app/explore/page.tsx`) — a
server-rendered page that decodes the URL, runs the pivot, and renders a real table with the
`DATA AS OF` badge, a stat/meta strip, the legend rail, and the permalink displayed. An
invalid permalink renders a named error (e.g. `unknown dimension 'nope'`), never a silent
fallback to a default view; a valid permalink matching zero rows states the query in words
and offers the widened-to-2015 permalink, never a blank panel.

**`app/src/proxy.ts` + `skipProxyUrlNormalize` are load-bearing, not an optimisation.** Next
form-encodes the query string before any page or route handler sees it, which turns the
format's structural `:` into `%3A` and collapses `k:a%2Cb,c` into `k%3Aa%2Cb%2Cc` — a data
comma becomes indistinguishable from a separator. Without them **every** filtered query fails
on **both** `/explore` and `/api/pivot`, reserved characters or not. Both entry points read
the raw string from one header and nothing else; a page can never use `searchParams` for this.
`proxy.ts` also sets a second header (the request pathname, for `not-found.js` — which accepts
no props) and applies the project `Cache-Control`. Full detail, and the rule that a new page
route must be added to its matcher: `docs/architecture/hosting.md` § What `proxy.ts` owns.

**No unit test can catch that class.** Five bugs on this branch had the shape "green tests,
broken production" — `__dirname` under Turbopack, `decodeURIComponent` throwing,
`process.chdir`, the DuckDB platform-switch `require`, and the query normalization above.
Every one was found by building and serving, never by the suite. That is what `make app-smoke`
is for; run it before merging anything that touches routing, config, or the query layer.

**`lib/db.ts` memoizes its `DuckDBInstance` on `globalThis`, not in a module-level `let`, and
that is the same class of bug.** Turbopack emits that module into a separate server chunk per
entry graph — proxy, page SSR, route handler — so a module-level memo is *three* memos:
measured, one `next start` process opened `upgauge.duckdb` three times, three buffer pools,
and three snapshots of a file the proxy and the page must agree about to keep a 404 out of the
30-day cache. No unit test can see this (one module graph by construction); `make app-smoke`
asserts the open-handle count is 1.

**M4a resolves dimension ids to display codes.** `meta_pivot_dimensions`'s `join_dim`/
`join_key` columns (`op_airline_id` → `dim_carrier.airline_id`, and so on) are now read by
`app/src/lib/resolve.ts`: `/explore` renders `DL`, `SEA`, `B737-7` and `PDX–SEA`, never the
bare `AIRLINE_ID`/`AIRPORT_ID` the catalog is keyed on, satisfying this file's own "Join on
IDs, display `carrier_code`" rule (see Hard rules, below). `dim_carrier` and `dim_airport`
carry only the *current* code (see Hard rules), so the legend rail states outright that
codes and names are current identity, not point-in-time filings — the honesty the display
depends on. A dimension with no code (city market) renders its name directly; an id absent
from the catalog renders as itself, never a dash. `make app-smoke` asserts a real code
renders and the bare id does not, on both a segment and a route query.

**M4b ships the first entity page, `/route/<pair>`** (`app/src/app/route/[pair]/page.tsx`),
composed on the same pivot layer M3/M4a already built — a title block, a stat strip (seats,
passengers, load factor, avg gauge, departures, carrier count, quarantined count — load
factor and avg gauge computed as ratios of summed rows, never averaged), the carriers table,
an Explorer link for the identical query, and the
legend rail. Getting there required two changes to the pivot layer itself, made in
`app/src/lib/pivot/render.ts` and `pipeline/pivot.py` in lockstep (the 17 existing goldens
stayed byte-identical): **composite-dimension filtering**, so `route` — whose `column_expr`
spans two columns — can be filtered at all, using `least`/`greatest` on the airport-id pair
rather than the naive `origin IN (...) AND dest IN (...)` form, which is silently wrong (a
measured 18,895-seat inflation on JFK–LAX — `docs/data/invariants.md` § Route identity); and
`app/src/lib/routePair.ts`'s reverse lookup, code → `airport_id`, which computes the URL's
alphabetical canonical form and the query's id-ordered filter as two explicit, separately
computed values (they disagree for 154 of 22,420 routes, 0.69% — the denominator excludes the
530 same-airport pairs, whose `low == high` makes disagreement impossible). That reverse lookup also
surfaced a resolution gap M4a's own invariant never covered — `WHERE is_latest` is scoped per
`airport_id`, not per code, so 36 codes had more than one `is_latest` row (`AUS` returned both
the real Austin-Bergstrom and a defunct airport closed since 1999) — fixed by scoping the
lookup to airports present in `fct_segment_month`, which takes colliding codes to 0
(`docs/data/invariants.md` § Entity resolution). That lookup is now on the request hot path —
the proxy runs it to decide cacheability — so its fact-presence filter is a hash semi-join
rather than the correlated `EXISTS` it shipped as: 43–51 ms → 17 ms, selecting exactly the
same airports, proven over every code rather than a sampled pair. `/route/LAX-JFK` 308-redirects to
`/route/JFK-LAX`; `/route/ZZZZ-LAX` 404s on a branded page naming the offending **half**
(`unknown airport code 'ZZZZ'`, and `'LHR' is a recognized airport code, but this dataset is
domestic-only` for `/route/JFK-LHR`) — server-rendered from `resolveRoutePair`'s own reason,
not a client-side guess at the pair, and served `no-store` rather than cached for a month; a
real pair with no scheduled service in the window 200s with an empty-state message and the
widened-to-2015 offer, never a blank panel. Full contract:
`docs/architecture/pipeline.md` § M4b.

**M4c ships the project's first chart, on `/route/<pair>`** — a **server-rendered** stacked
area of monthly seats by aircraft type (`app/src/components/AircraftMixChart.tsx`,
`app/src/lib/chart/`). Observable Plot draws into a jsdom `document` and the serialized SVG is
injected, so the chart is in the served HTML and visible with JS off — no client-side chart,
no empty container. It adds **no SQL and no catalog entries**: it composes the existing
segment-grain pivot (`year_month` × `aircraft_type`, seats + departures) through M4b's
composite `route` filter.

The encoding is `docs/design/system.md` § Charts, and **its one trap is that band membership
and band shade are two different orderings**: membership by total seats, shade by gauge
(Σ seats / Σ departures), so the lightest band is the smallest metal and **an upgauge darkens
the stack**. On JFK–LAX the two sorts share only their first element; a single sort produces a
chart that looks plausible and encodes nothing. A type that flew nothing has an *unknown*
gauge and sorts last, never lightest. `--g0` is Other, whose per-route type count and seat
share are stated on its own swatch (measured: top-5 + Other is a median 94.7% of seats but
1,571 of 4,618 multi-type routes fall below 90%, worst 48.2% — not a rounding error). COVID is
drawn, and the crossover annotation is **derived or absent**, never manufactured: 46% of routes
never change their #1 type and JFK–LAX is one of them.

**Gaps are gaps, and zero is not the alternative.** A month the subject filed nothing in is
*unknown*, not zero seats — T-100 is a filing, so "no row" is neither "nobody flew" nor "0
seats flew", and drawing it either way invents data. The area therefore **breaks**: filed
months are split into contiguous runs, each run is its own `z` series, and the count is stated
on the chart's key and in its `aria-label`. This shipped wrong in M4c's first cut and the final
review caught it — `HNL–LAS` filed nothing for 2020-04…2020-09 and the chart drew one straight
edge across all six, *inside* the band it labels "COVID — in window on purpose". 62% of route
pairs have such a gap; 41% have an isolated single month, which is drawn **stroked** because a
one-month area has no width and erasing a filing is the same dishonesty as inventing one.
`docs/design/system.md` § Charts owns the rule, now stated as standing rather than
line-specific.

The chart takes the **full** 2015-01 → `asOf` window while the carriers table keeps its
trailing 12, and the page states both — a decade drawn under a line reading "Trailing 12
months" would claim a window it is not showing. It is drawn from the wider window's rows, so a
route whose table is empty still gets its history (12,062 of 22,950 pairs last filed before the
current trailing-12 window); a pair with nothing in either window gets no chart at all rather
than a second panel repeating the empty state. The legend rail's fleet-shading group is opt-in
(`<LegendRail fleetMix />`) — `/explore` has no chart and must not be told how to read one.
Full contract: `docs/architecture/pipeline.md` § M4c.

**M4c is also the clearest case yet for `make app-smoke`.** The component reached 262 green
unit tests and a clean `make app-build` while being reachable from **no route at all** —
nothing in CI executed its Plot path, so a bundler or `serverExternalPackages` regression would
have shipped with every gate green. `smoke.sh` now curls the built page for the `<svg
role="img">`, for `fill="var(--g0)"`/`var(--g5)` surviving Plot → jsdom → React (which is what
keeps `globals.css` the single source for the ramp), for the COVID label, and for the
annotation as a **falsifiable pair**: absent on JFK–LAX, present and exact on ATL–MCO. Either
half alone is vacuous.

At M4c: 280 app tests green, and `make app-smoke` 55 checks — including a
curl-verified redirect, 404, `Cache-Control` and 404 *body* for `/route/<pair>`, since a
handler returning a redirect object and a served app returning one are not the same claim,
and a 404 whose status is right tells you nothing about what it says. `/route/JFK-LAX` grew
from **32,087 to 96,179 bytes** of HTML with the chart on it, +64,092 (it ships twice per
response, body + RSC payload) — the input to M4d's decision, since M4d mounts this component
three more times. **That size crossing 64 KB also exposed a latent `smoke.sh` bug**:
`set -o pipefail` plus `grep -q` made every check's result depend on where in the page the
needle sat, and made `check_not` report a silent **ok** for a string that was present. Fixed;
see `docs/architecture/pipeline.md` § M4c.

**A smoke needle is written in the bytes React EMITS, not the bytes the source contains.**
`check_not … 'can&rsquo;t be read'`, copied verbatim from a JSX `<h1>`, could never fire: JSX
decodes entities at compile time and React emits raw U+2019, so the check printed `ok`
unconditionally — a dark guard in the one file this repo keeps because the other gates can pass
for the wrong reason. Anything with an entity, an apostrophe or an angle bracket in it needs a
mutation run before it counts as coverage. `/route` also runs its two pivots under
`Promise.all` now (30.1 ms → 20.2 ms warm); M4d copies whatever shape is there.

**M4d ships the other three entity pages — `/airport/<code>`, `/carrier/<code>`,
`/aircraft/<slug>`** — on M4b's composition and M4c's chart, plus the routing tier that makes
them real. Each one has exactly one thing it could not inherit:

- **`/airport` is both endpoints, and that changes every figure on it.** At M4d (through M6) the
  pivot could not express `origin OR dest` (separate dimensions, filters AND-ed), so the page
  assembled `origin + dest − (origin ∧ dest)` over **three** pivots per grain, six per page
  (54.2 ms against `/route`'s 20.2) — **M7 Tasks 1-3 built the either-endpoint filter
  (`endpoint_airport_id`) this lacked and collapsed the six pivots to one per grain, three per
  page**; see M7, below. The third term is not a formality: `fct_segment_month` really
  carries same-airport rows (**3,187 rows / 601,573 seats over the trailing 12 months,
  quarantined rows included** — `docs/data/invariants.md` § Route identity tabulates all four
  window × quarantine answers, which differ by 4x, so never quote one unlabelled), and dropping it
  reads SEA at 53,386,452 seats instead of **53,373,806**. An origin-only page reads 26,710,000
  and looks perfect — carrier and type *counts* are identical either way, so only the seat,
  passenger and destination figures can catch it. **Both unions thread `partial` through the
  subset invariant, and the chart's did not until M4d's final review**: a truncated side drops a
  cell the overlap query still returns, `inclusionExclusion` throws, and the 500 goes out under
  the `s-maxage=2592000` the proxy stamped *before* the page ran — a 500 pinned in a shared CDN
  cache for a month, which is item 4 below with a live trigger. Both limits now disclose
  truncation instead, and a warehouse test asserts the worst case (ORD) comes back untruncated.
- **`/carrier` has to say what it is counting**, on every carrier and whether or not it has a
  table: operated-not-marketed, and codes/names are BTS's current identity. Its table is
  aircraft types (the fleet is the subject); routes and airports wanted the Top-N builder, which
  did not exist at M4d — M6 Task 3 built it and Task 4 gave `/carrier` its Top routes and Top
  origin airports tables (below).
- **`/aircraft`'s slug is a transform, not a key, and its chart is not the same chart.** 16 of
  112 fact-present `short_name`s carry a `/` or a space, so `/aircraft/A321/LR` is two path
  segments and can never be a page — `/` and space become `-`, and resolving inverts that by
  expanding the slug into every name it could have come from (capped at 4 separators; measured
  max is 2). The chart stacks by **operating carrier**, because a type stack on a type page is
  one band, and the ramp then encodes configuration rather than fleet (A321/LR, trailing 12:
  B6 172.3 → F9 230.0; full window, which is what the chart draws: 176.0 → 230.0
  seats/departure across carriers). `/aircraft/CE-180` names two airframes that both really flew
  and is a 404 that names and links both rather than picking one.

**M4b's Critical was a routing bug, and M4d is where it had to not recur.** `proxy.ts` now
carries a table (`ENTITY_ROUTES`) of slug-reader + resolver, one row per entity page, alongside
a six-entry matcher it has to agree with — **and the cacheability predicate is an allow-list,
`kind === "ok" || kind === "redirect"`, not `!== "notFound"`.** `resolveAircraftSlug` has four
outcomes; `/aircraft/CE-180` is `ambiguous`, renders a 404, and the `!== "notFound"` shape
`/route` used would have pinned it in a shared CDN cache for 30 days. **A page missing from the
matcher is now worse than mis-cached**: each `not-found.tsx` reads the pathname header and
throws without it, so its 404s keep the 404 status and lose their entire message — measured, a
7,740-byte error shell with no reason, no code, no `DATA AS OF`. Five served-build mutants pin
all of it (`docs/architecture/hosting.md`).

466 app tests green (`make app-check`), 447 Python (`make check`); `make goldens` leaves
`sql/03_queries/goldens/` byte-identical — M4c and M4d touched no pivot SQL, which is what
M4c's "the chart adds no SQL" property bought. `make app-smoke` is **138 checks** (55 at M4c), one section
per entity page, each asserting the same five things in the same order: it renders, its
`Cache-Control` is the project one, a real code renders and a bare id does not, the chart's
`<svg>` and `<path fill="var(--gN)" d=` ramp fills are in the served bytes, and its 404 names
the code *and* is `no-store` while its 308 keeps the long cache. Page weight: `/aircraft/B737-8`
103,019 bytes, `/airport/SEA` 119,126, `/carrier/DL` 127,688, `/airport/ATL` 130,435
(3,561 / 3,572 (month, type) cells per side). **`/airport/ORD` is the true worst case —
139,520 bytes**, 4,094 / 4,089 per side, union 4,118; the 4,118 previously attributed to ATL
"per side" was ORD's *union*, and `smoke.sh` now weighs both.

Not built yet, at M4: the load-factor time-series chart, the arc maps, `/watch`, the
seasonality heatmap, and OG cards — all specified in `docs/design/system.md`.

**M5 is COMPLETE — connects the four islands M3/M4 built.** Explorer and entity pages could
each only be reached by typing a URL; M5's eight tasks are the edges between them. Full
per-task account: `docs/architecture/pipeline.md` § M5.

Every resolved dimension cell in every table — `/explore` and all four entity pages, since they
share one `DataTable` component — now **links** to the entity page it resolves to
(`app/src/lib/entityLink.ts`'s `entityHref`, keyed on the dimension's own key, never on
`join_dim` — `route`, `origin_airport_id` and `dest_airport_id` all carry `join_dim =
dim_airport`, so a `join_dim`-keyed map would send route cells to `/airport/`). `route`'s own
cell is the one exception (its `column_expr` spans two columns, so there is no single id to
hand `entityHref`) and it is where **the milestone's sharpest trap** lives: `/explore` displays
a route cell in airport-id order but must link to the code-alphabetical canonical `/route/`
URL, and the two orderings disagree for 154 of 22,420 pairs — `IFP–IAH` displays in that order
but links to `/route/IAH-IFP`, the reverse, and is the fixture both the unit tests and
`app/smoke.sh` use, since a `JFK–LAX`-shaped fixture cannot fail this way.

**`/search?q=...` is the omnibox** (`app/src/lib/search.ts`) — one field resolving a route
pair (`PDX-AUS`), an exact code in any of three namespaces **checked concurrently and
collected, never short-circuited** (a code can be a real match in two namespaces at once — LNY,
NEW, WST are the three measured collisions, `LNY` the sharpest since the carrier is named after
the airport), or a ranked name substring (`Portland` matches four airports, not three — `PWM`
is Maine). A unique match **307-redirects, never 308**: `q=PDX` resolving uniquely is a fact
about *this month's* dataset, and a 308 is cached by the browser itself, permanently, so a code
that started colliding in a future rebuild would leave a wrong permanent redirect behind that no
server-side fix could reach. `/search` is also the one route whose `Cache-Control` breaks this
project's usual pattern: `no-store`, **unconditionally**, never the well-formed-vs-not split
every other route gets — `q` is an unbounded, attacker-chosen string, and a per-`q` shared-cache
entry is a cache-fill vector.

**`/sitemap.xml` and `/robots.txt` open the crawl graph**: 23,689 URLs at M5 (22,420 routes +
1,045 airports + 114 carriers + 110 aircraft; **23,694** as of M6 Task 7, +5 for `/watch` and its
four presets — see below), every entity count quarantine-inclusive, `lastmod` each entity's own
last-filed month (never the sitemap's build date — `/carrier/VX`, dormant since 2018-03, is the
fixture that distinction needs). `robots.txt` disallows `/search` (unbounded query space) and
`/api/` (a data endpoint), allows everything else.

**The carrier 404 now makes the same split `/route/<pair>`'s always has** (Task 6):
`sql/03_queries/lookup_carrier_code_exists.sql` mirrors the airport version, so `ZZ` 404s
"unknown carrier code" and `PA` 404s "recognized by BTS ... none of which has filed" — naming
*every* holder, not just the first, since `PA` alone holds three `airline_id`s (20384 and 20386
both "Pan American World Airways", plus 20389 "Florida Coastal Airlines", an unrelated carrier
sharing the code). `/carrier/PA` is **not** simply "Pan American" — that phrasing, upthread in
an earlier revision of this file, was the exact silent-pick failure the split exists to refuse.
The four `<entity>SlugFromPath` readers also collapsed into one-line wrappers around
`app/src/lib/entitySlug.ts`'s `entitySlugFromPath(pathname, prefix)`.

**The 5xx cache gap is narrowed, not closed** (Task 7). `/explore`'s proxy branch used to run no
database query at all before committing to a cache header — the one branch with nothing to
catch its own failure — so `isDataLayerHealthy()` gives it the same fail-safe probe every
entity page already had. The complete fix (a route handler owning its own `Response`, the way
`/api/pivot` already does) was spiked against `/route/<pair>` and **does not build**: Next 16
rejects a `route.js` and a `page.js` at the same segment outright, and the only other shape
(delete the page, hand-render from the handler) gives up layouts, `notFound()`, streaming, and
the RSC flight payload the server-rendered chart depends on. The adopted fallback: `HTML_CACHE`
drops from the project's `s-maxage=2592000` to `s-maxage=3600` for `/explore` and the four
entity pages — bounding a 5xx's public-cache exposure from up to 30 days to up to 1 hour. **It
does not close the gap** — a 500 minted at minute 0 is still cached for up to 59 more minutes.

**Task 8 completed the routing tier and found two bugs that only running the heavy gates could
find.** `proxy.ts`'s matcher grew to **nine** entries (`/search`, `/sitemap.xml`, `/robots.txt`
joined the six from M4d). `app/sitemap.ts` and `app/robots.ts` shipped in Task 5 with no
`dynamic` export, so `next build` tried to prerender `/sitemap.xml` — and the documented build
command changes `cwd` to `app/` before invoking `next build`, breaking `db.ts`'s WORKDIR
contract; `make app-build` failed outright the first time anything actually built this route,
because `make app-smoke` (the only gate that runs a real build) is the one task this repo's
8GB-memory working agreement reserves a dedicated pass for. Both files now carry
`export const dynamic = "force-dynamic"`. Separately, `app/smoke.sh`'s own Cache-Control checks
for `/explore` and all four entity pages were still asserting the pre-Task-7 30-day value —
silently wrong (a red check for a correct header) since Task 7 landed, since that task touched
`proxy.ts` and its own unit test but not this file. Both fixed; Task 7 Part A's fail-safe is
now also verified end to end against a served build with a genuinely broken database copy, not
just unit-mocked.

**Final whole-branch review fix wave: `/sitemap.xml` and `/robots.txt` had reopened the same
gap at 30 days.** The branch that sets their `Cache-Control` set `PROJECT_CACHE`
unconditionally — no `isDataLayerHealthy()` probe, unlike `/explore` immediately above it in
the same file — even though `app/sitemap.ts` runs four DuckDB queries and two of its helpers
throw by design on malformed input. Gated on the same probe `/explore` uses;
`docs/architecture/hosting.md` § "The gap" has the fix and the mutant that verifies it.

**594 app tests green (`make app-check`), 447 Python (`make check`); `make goldens` leaves
`sql/03_queries/goldens/` byte-identical** — M5 touched no pivot template. `make app-smoke` is
**183 checks** (138 at M4d). Page weight: `/route/JFK-LAX` 98,459 bytes, `/search?q=Portland`
10,715 bytes. **The M4d entity pages all grew**, by the links and the shared top bar rather than
by anything structural — SEA 119,126 → 122,152, ATL 130,435 → 133,959, ORD 139,520 → 143,427,
DL 127,688 → 131,316, B737-8 103,019 → 105,358. Roughly +2.3 to +3.9 KB each, ~2.5%: a linked
cell costs an `href` per row, and every page gained the search form. Measured, not estimated;
an earlier draft of this paragraph claimed these figures were unchanged by M5, which was wrong.

**M6 is COMPLETE — Gauge Watch, and the health-score composite it depends on.** Full per-task
account: `docs/architecture/pipeline.md` § M6.

`mart_route_health.health_score` scores **four independent axes at equal weight** — `lf_delta`
raw, `gauge_delta` and `frequency_delta` both **logged** (a halving and a doubling then carry
equal magnitude; the raw ratio does not), `completion_factor` capped at 1.5 — each a clamped
(±3) z-score, summed and quartered. `capacity_delta` is excluded from the score on an identity
Task 1 found and verified to 9.37e-16 over the real warehouse: in log space it **equals**
`frequency_delta + gauge_delta`, so scoring it a fifth time double-counts those two under a
different name. It keeps its own displayed column; only the composite excludes it.

**DuckDB's `least`/`greatest` ignore NULL rather than propagating it — `least(NULL, 3)` returns
`3`, not `NULL` — and this silently fabricates a value wherever it guards a NULL-meaningful
column.** A bare `least(completion_factor, 1.5)` would invent a near-perfect 1.5 completion rate
for the 180 routes that filed no schedule at all; a bare `greatest(least(z, 3), -3)` clamp would
score all 8,080 rows, including the 813 with no health score for a data-availability reason, and
those rows must render "insufficient data," never a number (`docs/product/features.md`'s
three-reason NULL contract). Every guard in `200_mart_route_health.sql` is a `CASE WHEN x IS
NULL THEN NULL ELSE least/greatest(...) END`, never the bare form. Get the arithmetic direction
right when citing this: `greatest(least(NULL, 3), -3)` returns **3**, not -3 — `least(NULL, 3)`
resolves to 3 first, then `greatest(3, -3)` is 3. This exact transposition shipped independently
in three places (`docs/data/model.md`, the mart SQL's own comment, a pipeline test's docstring)
before being caught and fixed in all three, one commit apart from each other.

**`/watch`'s four presets (`app/src/app/watch/[preset]/page.tsx`, `sql/03_queries/watch_*.sql`)
are NOT saved instances of a generic Top-N builder** — that claim, in `docs/product/
features.md`, `docs/design/system.md`, and this file's own M2 pipeline notes, was wrong in all
three places and is now fixed in all three. Every `meta_pivot_measures` row is a single-window
aggregate; every preset ranks on a **delta** between two windows that no pivot measure
expresses. The presets read `mart_route_health` directly and share nothing with the Top-N
builder (`app/src/lib/topn.ts`, M6 Task 3 — its first two callers are `/carrier`'s Top routes
and Top origin airports tables) except `DataTable`'s rank column. Gauge Watch is the one preset
with two directions (Upgauging / Downgauging, one query sorted both ways); Death Watch orders
`health_score ASC NULLS LAST`, currently a no-op since its own `WHERE` clause already excludes
every NULL, kept as forward defense the same way `p12_months_present`'s CASE guard is.

**The route-cell ordering trap (M4b/M5: airport-ID display order vs. code-alphabetical link
order) recurs on `/watch`, and this time it is unit-tested rather than smoke-covered — by
construction, not by gap.** The two orderings disagree for 22 of 8,009 `mart_route_health` rows
(the same-airport-excluded population, not M5's 22,420-route universe), but **no preset's top 25
contains a disagreeing pair**, verified against the real warehouse — so `app/smoke.sh` cannot
reach this class of bug on `/watch` without hand-picking a route outside any preset's natural
ranking, which would test a table the product never actually renders. `XP USA-LAL` is the unit
fixture (`watch.test.ts`), the counterpart to M5's `IFP–IAH`.

**The final whole-branch review's Critical was a false claim on a shipped page, and its shape is
the one to remember: a phrase the plan mandated, pinned by a test that asserted the phrase
rather than the fact.** `/watch/new-routes` told every visitor "First appearance since 2015"
about rows that had filed for years. `watch_new_routes.sql` selects `p12_months_present = 0` —
nothing filed in the **prior 12 months**, which is a **re-entry, not a first appearance**, and
`mart_route_health` carries no lookback past that window. Measured: **334 of the 688 qualifying
rows (48.5%)**, and **17 of the 25 the page renders**, had already filed earlier; `MQ AZO–ORD`
carries **93 distinct months back to 2015-01**. `features.md`'s own reasoning ("a route flown in
2014 and resumed in 2019 looks new") was right about the failure and one rung too high about the
window — a route flown in **2023** and resumed in 2025 looks new too. The test that pinned it
(`page.test.tsx`, `toContain("since 2015")`) is the **eighth** test in this milestone found
unable to fail for the reason it named; its replacement asserts the accurate claim **and** the
absence of the false one, and both halves were mutant-verified independently.

**That fix wave then shipped a second false claim of the same class, and the shape of THAT is
worth more than either bug: the surviving clause was the one that read accurate.** The original
sentence was "First appearance since 2015 — new service **nobody flew last year**." The wave
fixed the first clause and carried the second over unexamined, because next to a provably false
half it read as the true half. It is not. **`mart_route_health`'s grain is `(op_airline_id,
route)` — a carrier–route pair, never a route** — so `p12_months_present = 0` is silent about
every *other* carrier on that airport pair. Measured: **521 of the 688 qualifying rows (75.7%),
and 25 of the 25 the page renders**, had a different carrier flying the pair inside the prior
window; the #1 row `AS HNL–ITO` ranked first while HA, UA and WN filed **1,787,347 seats** on it
in that window, 4.9× the subject's own trailing 12. `AS DEN–SAN` had **eight** other operators.
So the claim was false about **every row on the page**, on a page whose copy had just been
audited. **Any sentence about a `mart_route_health` row names the carrier, or it is a claim
about a route the query never made** — and when a compound sentence is found false, each clause
is re-derived from the query, never triaged by how true it sounds.

**Two more from that wave are standing rules now.** (1) **A new top-level route is not shipped
until something already-reachable links to it** — `/watch` had **zero** inbound internal links,
one milestone after M5 existed to remove exactly that island, and neither `sitemap.ts` nor
`proxy.ts`'s matcher counts as one. `TopBar` carries the standing link (`nav.nav`,
`prefetch={false}`, labelled "Watch" not "Gauge Watch" — the latter is both the index's `<h1>`
and the `gauge` preset's title, and a nav item carrying it made `getByText` ambiguous in two
existing tests). (2) **A correction is not landed until the user-facing copy carries it**: the
"saved Explorer queries" claim was fixed in six places (`CLAUDE.md` ×2, `features.md`,
`system.md`, `pipeline.md` ×2, `topn.ts`) and left standing in the one sentence a visitor reads,
on `/watch`'s own index. Same class: **a page that enumerates its filters and omits one cannot
be reproduced from what it says** — Empty Planes disclosed `gauge_t12 >= 50` and hid
`t12_departures_performed >= 360`, the more restrictive of the two.

**`app/smoke.sh` gained one section per preset (241 checks total, +58 — 227 at M6 Task 8, plus
the final review's eight and its re-review's six) and two served-build
mutants that only running the heavy gates could produce.** Mutant A (matcher entry removed,
rebuilt, served) confirms `/watch/nope`'s 404 loses its entire message (9,941 → 7,816 bytes) and
degrades a *healthy* page's `Cache-Control` to Next's own fallback — closing the exact gap M5's
own review left "unit-verified only, not yet smoke-curled." **Mutant B is a genuine finding, not
a confirmation of what was assumed going in**: a database copy missing `mart_route_health` (not
`meta_pivot_dimensions`) makes `/watch/gauge` 500 **with** the cacheable `HTML_CACHE` header,
not without one — `isDataLayerHealthy()` only ever probes `loadAllowlist()`
(`meta_pivot_dimensions`/`meta_pivot_measures`), which has nothing to do with
`mart_route_health`. This is the already-documented residual 5xx cache gap (below), now shown to
reach `/watch/gauge` too, not only the four entity pages — confirmed as the narrow cause by
dropping `meta_pivot_dimensions` instead, which correctly 500s under `no-store`.

`make check` **461** (447 at M5 + 14 net across Tasks 1, 2 and 5 — reconciled test by test, not
assumed, in `docs/architecture/pipeline.md` § M6), `make app-check` **671** (664 at Task 8, +7
from the final review's fix wave and its re-review), `make app-smoke` **241 checks** (227 at
Task 8, 183 at M5). `make verify` unchanged in shape — `parquet: 17 artifacts
byte-identical`, `database: 10 objects identical` — M6 changed mart *content*, not object count.
`make goldens` leaves `sql/03_queries/goldens/` byte-identical: M6 added no pivot SQL, the
property Tasks 3/4's Top-N builder and the `/watch` presets both rest on.

**M7 is COMPLETE — the airport network map, and the either-endpoint filter it needed first.**
Tasks 1-2 gave `meta_pivot_dimensions` a filter-only `endpoint_airport_id` dimension
(`filter_mode = 'either'`, compiling to `(origin_airport_id IN (...) OR dest_airport_id IN
(...))` in `render.ts` **and** `pipeline/pivot.py`, in lockstep, with two new goldens) — the
either-endpoint OR the pivot layer could not express before, licensing Task 3's collapse of
`/airport/<code>` from **three pivots and inclusion-exclusion arithmetic down to one pivot per
grain**, gated on reproducing SEA's committed 53,373,806-seat figure via a warehouse-coupled
test before a line of the old `endpoints.ts` was touched.

**Tasks 4-8 shipped this project's first map, and it is not the map the spec called for.**
`docs/design/system.md` and `docs/product/features.md` originally specced deck.gl's
`GreatCircleLayer` over a MapLibre basemap; what shipped is a **from-scratch, dependency-free,
server-rendered SVG engine** (`app/src/lib/map/{albers,greatCircle,arcs,networkMap,
basemap}.ts`, composed by `app/src/components/NetworkMap.tsx`) — the same "in the served
HTML, visible with JS off" property the aircraft-mix chart established for M4c, extended to a
map, with **zero** client-side charting or mapping library anywhere in the render path.
Composite Albers, five panels (Task 4: `us`/`ak`/`hi` plus two the mockup's own two-panel math
silently misfiled — `pac` and `car` — each measured against real fact-present airport
coordinates, not assumed); great-circle interpolation with an adaptive, screen-distance-scaled
step count (Task 5); arc encoding by seats/load-factor/departure-floor and the composed `<svg>`
string itself (Task 6); a committed, reproducibly-generated basemap from Natural Earth 1:110m
(Task 7), widened mid-milestone to include real Caribbean coastline for `car` from a second,
finer input once the served pages made the gap visible on `/airport/SJU` (Task 7b — `pac`
remains disclosed-empty, a deliberate scope line, not a defect); and the map mounted for real
on `/airport/<code>` (Task 8), which found and fixed a genuine defect the repo's own written
guidance had recommended the WRONG fix for — a per-page fit must reuse the coastline's own
baked `fitPanels(BASEMAP_FIT_POINTS)` verbatim, never union a subject's points into it.

**Task 9 added year permalinks, not the animated slider `system.md` originally specified** —
superseded on measurement: this map is server-rendered SVG with no client library, so
animating between years means shipping every year's geometry in one response. `/airport/
<code>?y=<year>` is a track of plain, cacheable, shareable links instead, validated by
`proxy.ts` before a response commits to a cache header (`y`'s value set is closed — the
calendar years this dataset covers — which is what licenses validating it rather than
`/search`'s blanket `no-store`).

**Task 10 closed the milestone out, and found the same class of bug the M4c/M5/M6 closeouts
each found in their turn: a number written into a permanent doc, never re-measured once the
real page existed.** The design spec's own arc-byte prediction for ORD (132,178 bytes) was
carried, uncorrected, into `greatCircle.ts`'s own code comment; the real, measured figure on
the actual 960px-wide served page is **64,287** — a transcontinental arc projects to only
~700px there, so the adaptive step count never reaches its own 48-step cap at all, which the
spec's wider assumption did not anticipate. `/carrier/DL`'s documented page weight (131,316)
was **HALF the real, measured figure (262,697)** — the real figure is roughly 2× the stale
one, not the other way around — the M6 Task 4 Top-N tables landing in the same window that
number was last written, never reflected afterward; every other page-weight figure below was
re-measured, not assumed carried over. Two code comments (`networkMap.ts`,
`build-basemap.mjs`'s generated-output template) still described `car` as a subject-derived
fallback panel after Task 7b gave it committed geometry — corrected, `make basemap` re-run,
artifact changed only in that header comment. `app/smoke.sh` gained a nine-check network-map
section on `/airport/ORD` (the milestone's own worst case) plus a permanent gap-check section
(17) proving the residual 5xx cache gap reaches the map path too — a database copy missing
only `dim_airport`'s `lat`/`lon` columns 500s `/airport/ORD` **with** the cacheable
`HTML_CACHE` header, confirmed scoped correctly against a healthy `/route/JFK-LAX` under the
identical broken copy. Every new needle was mutation-run; a one-off matcher-removal mutant
reconfirmed M4d's own finding (a healthy page loses its cache header, a 404 loses its message)
on the map-bearing page specifically.

`make check` **474**, `make app-check` **773**, `make app-smoke` **265 checks** (241 at M6,
+24 across M7 — Task 10's own contribution is the last 12: nine map checks plus three in gap
section 17). `make verify` — **its first real execution against the basemap extension** (Task
7 wrote the Makefile change but was forbidden from running it) — `parquet: 17 artifacts
byte-identical`, `database: 10 objects identical`, and `make basemap`'s own zero-diff check
inside it passed clean. `make goldens` leaves `sql/03_queries/goldens/` byte-identical — M7
added exactly Task 2's two goldens, `urlstate.json` unchanged across the whole milestone.

**Page weights, measured, not estimated, at M7's close**: the map made the four M7-touched
pages the heaviest in the app — `/airport/ORD` **360,473** bytes (was 143,427 at M5; the
milestone's own worst case, three pivots deep), `/airport/ATL` 133,959 → **300,876**,
`/airport/SEA` 122,152 → **277,711**, `/carrier/DL` 131,316 (documented) / **262,697**
(measured — the ~2× drift above). Pages the map never touches moved only by M7's catalog
growth flowing into every page's embedded allowlist: `/route/JFK-LAX` 98,459 → **98,832**,
`/aircraft/B737-8` 105,358 → **105,799**, `/search?q=Portland` 10,715 → **10,908**.

**Final whole-branch review: one Critical, seven Important, five Minor, one fix wave.** The
Critical was M6's own failure shape recurring one milestone later — **M7 built the
either-endpoint filter and left every claim that it doesn't exist standing, including on two
shipped pages.** `/airport/<code>` printed 53,373,806 and then offered two Explorer half-links
each showing 26,710,000 — its own documented "silently about half the airport" figure — under
copy reading "the Explorer cannot express both endpoints in one query." `/carrier/<code>` said
"there is no either-endpoint filter yet (M6 backlog)," naming a backlog item this same commit
retires. Both are now ONE permalink (`/airport`) or a corrected reason (`/carrier`'s Top
origin-airports table stays origin-only because ranking requires *grouping* by the endpoint
dimension and `endpoint_airport_id` is `filter_only` — a different, still-true reason from the
one that used to be printed). The test that pinned the old claim
(`page.test.tsx`, `/cannot express both endpoints/i`) was the **seventh** test found unable to
fail for the reason it claimed in this milestone alone (M7 Tasks 1, 4, 2, 6 and 7 already
found five; Task 8 found a sixth, `basemap.test.ts`'s in-bounds-only fixture) — a mandated
phrase, pinned by an assertion on the phrase, surviving the exact change that falsified it,
M6's `/watch/new-routes` shape again. Replaced with an assertion on the fact (the offered permalink's own filter) and the
absence of the false claim, independently mutant-verified. The same claim was also standing in
`system.md`, `features.md` (×2) and `hosting.md`; all four corrected.

Seven Important findings, all fixed in the same wave: `hosting.md`'s "/airport runs SIX
pivots" table described a query shape M7 Task 3 deleted (re-measured against the real,
current three-pivot shape: 21.6/26.9/22.4 ms individually, **40.0 ms** concurrent against 68.1
serial, a 41% saving); `pipeline.md`'s Task 7 section stated the WRONG per-page fit rule in
bold present tense (the union recommendation Task 8 disproved) and cited a `basemap.test.ts`
fixture Task 8 had already found vacuous — corrected in place rather than left for a reader to
reach the true account 60 lines later; `basemap.ts`/`build-basemap.mjs`/`Makefile` all still
said `car` "always emits \"\"\"" or is generated from one input, when Task 7b gave it two real
committed `<path>`s from a second input file; the legend rail had **no arc group at all** on a
page that draws arcs encoding three independent facts (width/seats, dash/load-factor,
dotted-muted/departure-floor) nowhere else explained — added, mirroring how M4c added
`fleetMix`, and `system.md`'s "the page says so" claim about cross-panel straight lines and
`networkMap.ts`'s `aria-label` (which called every arc a great-circle one, wrong for
cross-panel arcs) were both made true rather than merely asserted; `BASEMAP_FIT_POINTS` was
found to be a **lossy copy** — the generator fit the coastline from raw reference points but
emitted `BASEMAP_FIT_POINTS` rounded to 3 decimals, a no-op for `ne_110m_us.json` (already
3-decimal) but not for `ne_50m_car.json` (committed at 4), so the `car` fit baked into the
artifact and `fitPanels(BASEMAP_FIT_POINTS)` at runtime were subtly different numbers
(sub-pixel, ≲0.1px, not a visible defect, but an unguarded gap in the exact invariant Task 8's
whole fix rests on) — fixed by rounding before fitting, not only before emitting, and a new
test (`generator's own fit matches fitPanels(BASEMAP_FIT_POINTS)`) calls the generator's real,
now-exported function rather than re-implementing it, closing the gap for good; a third stray
"deck.gl + MapLibre" claim was found in `pipeline.md`'s own stack summary, beyond the two
`features.md`/`system.md` had already corrected; and `smoke.sh`'s map section, which checked
267 polylines, an inset label, the window line, the year-track href and the cache pair, never
checked that the **coastline itself** reached the served bytes — a collapsed or empty basemap
renders identically to the legitimately-empty `pac` panel, so two needles
(`data-panel="us"`, `data-name="AK"`) were added and confirmed, against a real built-and-served
`/airport/ORD`, to catch exactly that: with `basemapPathsFor` mutated to always return `""`,
both needles vanished while every other map check (267 polylines, the ALASKA label) stayed
green.

Five Minors, all cheap, all fixed: `CLAUDE.md` itself had inverted the `/carrier/DL` page-weight
drift (131,316 is HALF of 262,697, not "2×" of it — the exact transposition class this file
already warns about for `greatest(least(NULL,3),-3)`); `system.md`'s Reduced-motion note still
described an animated year slider Task 9 replaced with plain links; `features.md`'s
`/airport/SEA` row said "still unbuilt: the route map" three columns away from its own Maps
table saying the airport network shipped; `model.md`'s `endpoint_airport_id` paragraph
conflated "carries join metadata" with "is filter-only" into one incoherent sentence, now two
separate, correct ones; and `networkMap.ts` emitted `stroke-dasharray=""` on every solid arc
(valid nowhere, ~5 KB of no-op bytes across ORD's 267 polylines) — now omitted when empty.

Every rewritten or new assertion in this wave was mutant-verified: reverted to the pre-fix
behavior, confirmed red for the named reason and nothing else, then reverted back. `git status`
clean of every mutation before this account was written.

Gates re-run after the fix wave, all green: `make check` **474** (unchanged — no Python
touched), `make app-check` **780** (773 at Task 10, +7 from this wave — 3 in `LegendRail.
test.tsx`, 3 in `networkMap.test.ts`, 1 in `basemap.test.ts`), `make app-smoke` **267 checks**
(265 at Task 10, +2 — the coastline-presence pair), `make verify` unchanged in shape (`parquet:
17 artifacts byte-identical`, `database: 10 objects identical`, basemap zero-diff against the
committed, corrected artifact), `make goldens` byte-identical (this wave touched no pivot
template).

Next: **M8.** What it owes, each identified by the work above rather than guessed. (Two closed
M6-carried items are retired from this list entirely rather than kept as strikethrough noise:
the either-endpoint filter and the truncation-arithmetic question it made moot both finished
in M7 Tasks 1-3, described above, and neither owes M8 anything further beyond the still-open
"same shape for a future `/city-market`" note.)

1. **The maps: three of four still unbuilt, plus one disclosed gap on the one that shipped.**
   Airport network is **DONE, M7** (`/airport/<code>`, Tasks 4-9) on the from-scratch SVG
   engine described above — carrier network, aircraft type, and the diff map remain
   (`docs/product/features.md` § Maps), and are expected to reuse that same engine rather than
   introduce deck.gl/MapLibre after all, since nothing about the three remaining maps needs a
   client-side mapping library the airport network didn't already need. Also still open: the
   `pac` inset's missing coastline (Natural Earth has no polygon at this scale for Guam/CNMI/
   American Samoa/Midway; 6 fact-present airports reach it, against `car`'s 74 which M7 Task 7b
   already fixed) — disclosed on the page rather than fixed, a deliberate scope line rather
   than a defect, but still a real gap a future task could close the same way Task 7b closed
   `car`'s. The **Time-machine diff** preset ("PDX, Jul 2019 vs Jul 2025," `docs/product/
   features.md`) is the diff-map item wearing a preset's name, not a fifth `/watch` page — a
   two-window diff plus a diff map, so it stays out of scope until the maps themselves exist.
2. **The residual 5xx cache gap** — a page-specific throw whose proxy resolution already
   succeeded (a catalog view the entity resolvers, `/explore`'s probe, `/watch`'s probe (M6), or
   the map's own coordinate lookup (M7) don't touch) is still cached for up to an hour.
   `docs/architecture/hosting.md` § "The gap" has the full account of why the complete fix isn't
   reachable on this Next version. Confirmed to reach three distinct causes now, not two: M6
   Task 8 found `/watch/gauge` via a missing `mart_route_health`; M7 Task 10 found
   `/airport/<code>`'s map via `dim_airport` missing only its `lat`/`lon` columns (not the whole
   view) — `isDataLayerHealthy()` only ever probes `loadAllowlist()`, which has never had
   anything to do with either table.
3. **The interactive Explorer builder** — pick dimensions/measures/filters from a UI rather
   than hand-editing the permalink. The permalink contract (M3a/M3b) is done; nothing renders
   a form over it yet.
4. **The load-factor time-series chart** and the **seasonality heatmap** — both specified,
   neither built. Build the load-factor chart only after confirming nothing else in the backlog
   is a better use of the slot; M4c already made the gauge story the differentiator.
5. **OG cards** — social-preview images per entity page, for the links `/search` and the
   sitemap now make shareable.

## Architecture

Read-only dataset, refreshed monthly, **no writes ever** — so there is no database server.
DuckDB file + Parquet, queried in-process. Always-on box (not scale-to-zero): DuckDB
aggregation wants RAM, and a cold start lands on the first click of every shared link.

```
pipeline/    Python 3.12 + uv. CI only, never runs in prod.
sql/         01_staging/ 02_marts/ 03_queries/ — shared by pipeline AND server
app/         Next.js 16 App Router, TS, Tailwind v4
data/        gitignored. raw/ is the audit trail
```

Charts: Observable Plot. Maps: **not** deck.gl/MapLibre (the original spec) — a from-scratch,
dependency-free, server-rendered SVG engine (`app/src/lib/map/`, M7 Tasks 4-8), the same
"in the served HTML, visible with JS off" property the charts have, extended to maps. Natural
Earth GeoJSON, pre-projected and committed (no tiled basemap, ever — not merely untiled, no
map library in the render path at all).

## Commands

**`mise.toml` pins every runtime — Python 3.12.12, Node 24.13.0, uv 0.12.0 — at exact
versions.** `make` shells through `mise exec`, so the commands below work without
`mise activate`. Unimplemented targets exit non-zero on purpose.

| Command | Description | |
|---------|-------------|---|
| `make install` | `mise install` + `uv sync --extra dev` | ✅ |
| `make check` | **Lint + test. Run before every commit.** | ✅ |
| `make test` / `make lint` / `make fmt` | pytest / ruff check / ruff format | ✅ |
| `make fetch` | BTS T-100 zips → `data/raw/` (skips cached years) | ✅ |
| `make fetch-reference` | BTS support tables → `data/raw/` | ✅ |
| `make normalize` | Raw zips → `data/parquet/t100_segment/year=YYYY/` | ✅ |
| `make warehouse` | Facts + all 5 dims from `data/raw/` | ✅ |
| **`make verify`** | **M2 gate: build twice, prove Parquet + database byte-identical** | ✅ |
| `make ingest` | `fetch` + `fetch-reference` + `warehouse` | ✅ |
| `make build` | Run `sql/` in order → `upgauge.duckdb` | ✅ |
| `make goldens` | Regenerate the Explorer contract fixtures (`sql/03_queries/goldens/`) from `pipeline/pivot.py` | ✅ |
| `make dev` | Next.js dev server (needs node) | ✅ |
| `make app-check` | Typecheck + lint + test the app (`app/`) | ✅ |
| `make app-build` | Production build of the app | ✅ |
| **`make app-smoke`** | **Build, serve, curl. The only gate that catches production-only bugs.** | ✅ |

## Hard rules

**Derived measures are never stored, never averaged.** Compute from summed numerator and
denominator at query time.

```sql
AVG(load_factor)                                  -- WRONG. Plausible-looking garbage.
SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)   -- RIGHT. Always.
```

Enforce structurally: **no `load_factor` column on any `fct_*` table.** Same for `asm`,
`rpm`, `avg_gauge`, `completion_factor`. Can't average what doesn't exist. The #1 bug in
every homemade T-100 tool.

**The one exception: `mart_route_health`.** It stores ten derived columns (`lf_t12` ...
`health_score`), licensed only because it has no time grain — one row per (carrier,
undirected route) is already the finest and coarsest it gets, so there is no `GROUP BY` of
it for an `AVG()` to corrupt. If it ever gains a time grain, the derived columns must come
back out. Full justification and the tests that guard it: `docs/data/model.md`.

**Key on `AIRLINE_ID` and `AIRPORT_ID`, never letter codes.** `CARRIER` (raw IATA) is
reused — 135 of 1,825 codes map to >1 airline. `UNIQUE_CARRIER` doesn't collide, but only
because BTS suffixes it (`2T (1)`), so it's a poor display code. Join on IDs, display
`carrier_code`. `AIRPORT_SEQ_ID` is the point-in-time key.

**`dim_carrier` carries the CURRENT carrier code, not the point-in-time one.** v0 collapses
Carrier Decode to one row per airline. Never join on `carrier_code`, and don't present it as
historical fact. Also: BTS dates arrive as strings like `1/1/1960 12:00:00 AM` — **parse
before sorting**, or Horizon surfaces as `HOZ` and SkyWest as `SEA`.

**Operating carrier is the grain and the truth.** T-100 Segment is filed by whoever operated
the metal — a Delta-branded regional flown by Endeavor files as `9E`, not `DL`. Summing
carriers on a route does *not* double-count. There is no marketing-carrier field; don't try
to infer one.

**`map_mainline_group` is DATE-RANGED and wholly-owned only.** Alaska acquired Virgin
America (2016-12) and Hawaiian (2024-09), both in-window, so a flat map is wrong before each
acquisition and omission is wrong after. Never roll up shared regionals (SkyWest `OO`,
Republic `YX`, Mesa `YV`) or contract carriers — no date range fixes those; they fly for
several mainlines on the same day. Test: no overlapping ranges per `airline_id`, and
Hawaiian rolls up from 2024-09 but not 2024-08.

**Don't reuse the name `carrier_group`.** T-100 already ships `CARRIER_GROUP` /
`CARRIER_GROUP_NEW` — BTS's revenue-based filing classification, unrelated to our rollup.
Ours is `mainline_group`; theirs is `bts_carrier_group`.

**All query logic lives in `.sql` files.** Never inline SQL in Python or TS string literals.
This is what lets the pipeline and the server share definitions and keeps a DuckDB-WASM port
possible.

**Segment only.** Never blend T-100 Segment with Market or DB1B.

**`data/raw/` is APPEND-ONLY.** Filenames carry the download date
(`t100d_segment_us_2015_20260729.zip`), so a re-fetch adds a file rather than destroying the
one that produced published numbers. `latest_raw()` feeds the build; superseded downloads are
audit-only. Parquet is derived and freely rebuilt.

**All Parquet writes go through `_writer_connection()` (`threads = 1`).** DuckDB's parallel
writer is not byte-stable — it drifts *intermittently*, which is worse than consistently.
Never call `duckdb.connect()` directly for a write.

**Stay portable.** `docker run` against the same `.duckdb` file **plus its `data/parquet/`
tree** (the catalog is views over relative Parquet paths, so `WORKDIR` must be the
directory containing `data/` — see `docs/architecture/hosting.md`) must behave
identically. Docker + Parquet + env vars only. **No provider-specific runtimes** (Workers,
D1, KV) — Cloudflare is CDN and rate limiting, nothing more.

## Data gotchas

Full detail and the measurements behind each: `docs/data/invariants.md`.

- **PREZIP is dead for T-100** — every file there is dated 2015-09-02. The
  `DL_SelectFields.aspx` POST is the only path, it's ASP.NET WebForms (GET for cookies +
  `__VIEWSTATE`, then POST), and TranStats obfuscates URL params with *two* ROT13 variants.
- **Passenger filter is `AIRCRAFT_CONFIG IN (1,3,4)`**, not `= 1` — configs 3 (combi) and 4
  (seaplane) carry real passengers.
- **`CLASS` has rollup codes** `K`(=F+G), `V`, `Z`. Summing service classes can double-count.
  Assert their absence.
- **`seats = 0` needs both checks** — quarantine only when config is a passenger config
  **and** departures were performed. 5,713 of 2015's 5,717 zero-seat rows never flew; they
  are ordinary "no service" filings, not anomalies.
- **Rows with no `AIRLINE_ID` exist** (158 in 2015, carrying real traffic) — but all are
  `CLASS='L'` charter, so the service filter removes them in 2015. Outside 2015 it does fire
  in routine handling — 51 rows over 2015–2026 (27 in 2018, 24 in 2022) — see
  `docs/data/invariants.md`.
- **`load_factor > 1.0`** → quarantine, **never clamp.** Quarantined rows are excluded from
  aggregates but surfaced in the UI with count + reason. Showing the dirt is a trust feature.
- **Zero-padded codes stay strings** — `AIRCRAFT_TYPE` `079` becomes `79` if int-parsed, and
  the join breaks silently.
- **No trailing comma / `EMPTYFIELD`** in what BTS serves today. Assert the 45-column count
  instead of writing the workaround.
- **DuckDB's `least`/`greatest` ignore NULL rather than propagating it** — `least(NULL, 3)`
  returns `3`, not `NULL`, and `greatest(least(NULL, 3), -3)` returns **3**, not -3 (resolve
  inside-out: `least(NULL, 3)` is 3 first, then `greatest(3, -3)` is 3). A bare `least`/`greatest`
  guarding a NULL-meaningful column silently fabricates a value instead of preserving the
  absence — `mart_route_health`'s `completion_capped` and its z-score clamps both need this
  (M6 Task 1), guarded with `CASE WHEN x IS NULL THEN NULL ELSE least/greatest(...) END`, never
  the bare form. The wrong sign (-3) shipped independently in three places — `docs/data/model.md`,
  the mart SQL's own comment, and a pipeline test's docstring — before being caught.

## UI constraints

Product truths, not style preferences. The design session owns palette, type, and the
signature element; it does not own these.

- **All numerics monospaced, tabular-figure, right-aligned, fixed decimals.**
- **`DATA AS OF: YYYY-MM` is a first-class element** on every data view, in the accent color.
  The lag is our credibility.
- **Density over whitespace.** Sparklines in rows, hairline rules. No card soup.
- **URL-encoded query state on every view.** Permalinks are the entire growth mechanic.
- **Every insight row is one click from the raw rows that produced it.**
- Derived measures labeled as computed. Quality floor: responsive, visible keyboard focus,
  reduced-motion honored.

## Workflow

- **Invariants are written as failing tests first**, before the pipeline that satisfies them.
- **Run the mutant. A test that has never been red proves nothing.** Across M4c *four* tests
  written into the plan could not fail for the reason they claimed — including the one written
  expressly to catch the two-orderings bug. The pattern was identical every time: **asserting
  an outcome the buggy implementation also produces, instead of varying the input that
  distinguishes correct from buggy.** The two-sort fixture used a type that was both largest by
  seats and smallest by gauge, so both orderings put it first and a single sort passed; the tie
  fixture happened to break its tie toward the previous year's leader, so a flapping
  implementation returned the right answer by accident of row order. Reading the test does not
  reveal this — every one of them was found by breaking the implementation and watching the
  named test stay green. So: **for each test, name the bug it exists to catch, introduce that
  exact bug, and confirm THAT test goes red.** M4c's Task 5 sharpened it further: reversing the
  stack order still emits six paths with six correct fills, so an assertion over the fill list
  passes and only a *geometry* assertion catches it — when the property is an ordering, a
  position, or a window, assert the ordering, the position, or the window, never the set of
  things that happen to be present. Record the mutants run; "tests pass" is not the claim,
  "these mutants died" is.
- Marts must rebuild from scratch reproducibly via `make`. No manual steps.
- **The project's `Cache-Control` is NOT one value.** `/api/pivot`'s own successful responses,
  `/sitemap.xml`, and `/robots.txt` get the full `public, s-maxage=2592000,
  stale-while-revalidate=86400`. `/explore` and the four entity pages get the shorter
  `HTML_CACHE` instead, `public, s-maxage=3600, stale-while-revalidate=86400` (M5 Task 7 — see
  below for why). `/search` gets `no-store` unconditionally, regardless of outcome (`q` is an
  unbounded, attacker-chosen cache key). Precompute leaderboards as static JSON at build time —
  the caching is the cost control, not the hosting tier. **404s get `no-store`**: the dataset is
  rebuilt monthly, so a 404 pinned in a shared cache outlives the condition that caused it.
  `/api/pivot` does this in its handler; a page cannot, and a proxy cannot see the
  downstream status — so **`proxy.ts` caches on "is this a well-formed, known entity",
  resolved before the page runs**, which is the rule every entity page follows.
  **A 5xx from a page is narrowed, not closed** (M5 Task 7): the proxy resolves cacheability and
  writes the header BEFORE the page can throw, so a 500 still goes out under whichever
  `Cache-Control` the proxy already committed to. `HTML_CACHE`'s shorter `s-maxage` (above)
  bounds this to at most an hour of public caching instead of 30 days — a real improvement, not
  a fix; a 500 minted at minute 0 of its hour is still cached for up to 59 more minutes. Not
  fixable from a proxy on this Next version — a `route.ts` sibling to a page fails `next build`
  outright (`docs/architecture/hosting.md` § The gap has the measurement and the three things
  that would still fix it). Do not restate any of this as "errors get `no-store`"; it is 404s
  only, and even those are per-route (`/sitemap.xml`/`/robots.txt` 404 the same way any Next
  route does, uncached by `proxy.ts` since they never leave the 200 path in practice).
  **A new page route must be added to `proxy.ts`'s matcher or it ships uncached and without
  the raw-query and pathname headers** — eleven entries as of M6 Task 7 (`/watch` and
  `/watch/:preset` joined the nine from M5 Task 8). A static, closed slug set (like `/watch`'s
  four presets) is necessary but not sufficient for the matcher's own cacheability branch to
  skip a database probe — every preset page still runs a `mart_route_health` query the proxy
  commits to a cache header before, so `isDataLayerHealthy()` gates it exactly like `/explore`
  and `/sitemap.xml`/`robots.txt` do, even though the slug set alone never needs the database.
  Full detail: `docs/architecture/hosting.md`.
- Build the **aircraft-type-mix chart before the load-factor chart**. Everyone does load
  factor; the gauge story is the differentiator.
- **The `/watch` presets are NOT saved instances of a generic Top-N builder** — this exact
  sentence used to be here, in `docs/product/features.md`, and in `docs/design/system.md`, and
  was wrong in all three (M6 Task 3). Every `meta_pivot_measures` row is a single-window
  aggregate; every preset ranks on a delta between two windows, which no pivot measure
  expresses. The presets read `mart_route_health` directly and share only `DataTable`'s rank
  column with the Top-N builder (`app/src/lib/topn.ts`), which exists and is built (M6 Task 3,
  first used by `/carrier`'s Top routes / Top origin airports tables, M6 Task 4).
- **The cron must fail loudly.** A broken ingest doesn't error — the site keeps serving and
  `DATA AS OF` silently stops advancing. Alert when `max(year_month)` hasn't moved in ~45
  days.
