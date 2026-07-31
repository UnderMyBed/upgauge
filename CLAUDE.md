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

**M3 and M4 are COMPLETE — M3a, M3b, M4a, M4b, M4c, M4d.** All four entity pages ship.
M3a's Explorer pivot query contract — templates
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
computed values (they disagree for 154 of 22,950 routes, 0.7%). That reverse lookup also
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

- **`/airport` is both endpoints, and that changes every figure on it.** The pivot cannot
  express `origin OR dest` (separate dimensions, filters AND-ed), so the page assembles
  `origin + dest − (origin ∧ dest)` over **three** pivots per grain, six per page (54.2 ms
  against `/route`'s 20.2). The third term is not a formality: `fct_segment_month` really
  carries same-airport rows (3,187 rows, 601,573 seats over the trailing 12), and dropping it
  reads SEA at 53,386,452 seats instead of **53,373,806**. An origin-only page reads 26,710,000
  and looks perfect — carrier and type *counts* are identical either way, so only the seat,
  passenger and destination figures can catch it.
- **`/carrier` has to say what it is counting**, on every carrier and whether or not it has a
  table: operated-not-marketed, and codes/names are BTS's current identity. Its table is
  aircraft types (the fleet is the subject; routes and airports want the Top-N builder, which
  does not exist).
- **`/aircraft`'s slug is a transform, not a key, and its chart is not the same chart.** 16 of
  112 fact-present `short_name`s carry a `/` or a space, so `/aircraft/A321/LR` is two path
  segments and can never be a page — `/` and space become `-`, and resolving inverts that by
  expanding the slug into every name it could have come from (capped at 4 separators; measured
  max is 2). The chart stacks by **operating carrier**, because a type stack on a type page is
  one band, and the ramp then encodes configuration rather than fleet (A321/LR: 172.3 → 230.0
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

457 app tests green (`make app-check`), 447 Python (`make check`); `make goldens` leaves
`sql/03_queries/goldens/` byte-identical — M4c and M4d touched no pivot SQL, which is what
M4c's "the chart adds no SQL" property bought. `make app-smoke` is **134 checks** (55 at M4c), one section
per entity page, each asserting the same five things in the same order: it renders, its
`Cache-Control` is the project one, a real code renders and a bare id does not, the chart's
`<svg>` and `<path fill="var(--gN)" d=` ramp fills are in the served bytes, and its 404 names
the code *and* is `no-store` while its 308 keeps the long cache. Page weight: `/aircraft/B737-8`
103,019 bytes, `/airport/SEA` 119,120, `/carrier/DL` 127,688, `/airport/ATL` **130,429** (the
densest chart in the database, 4,118 cells per side).

Not built yet: the load-factor time-series chart, the arc maps, `/watch`, the seasonality
heatmap, and OG cards — all specified in `docs/design/system.md`.

Next: **M5.** What it owes, each identified by the work above rather than guessed:

1. **A first-class either-endpoint filter** in `meta_pivot_dimensions` — one pivot instead of
   three on `/airport`, and the same shape a future `/city-market` needs. It needs composite
   filter semantics in `render.ts` **and** `pipeline/pivot.py` in lockstep, plus a golden; that
   is a milestone-sized change, which is why M4d assembled the OR arithmetically instead.
2. **`lookup_carrier_code_exists.sql`** (~15 lines, mirroring the airport one) so the carrier
   404 can make the split the airport 404 already makes. **1,543 of `dim_carrier`'s 1,776 codes
   have no fact-present holder**, so "recognized by BTS, never filed a segment row" is the
   *majority* carrier 404, not a corner: `/carrier/PA` is Pan American, and today it reads the
   same as a typo.
3. **Collapse the four `<entity>SlugFromPath` readers into one
   `entitySlugFromPath(pathname, prefix)`.** Four copies of the same `decodeURIComponent`-throws
   guard is a guard that will be dropped from one of them. `ENTITY_ROUTES` is the only caller
   that has to change.
4. **The 5xx cache gap**, inherited from M3b and now spanning four pages: the proxy writes the
   long cache before the page can throw, so a 500 is publicly cacheable for a month. Not fixable
   from a proxy — see `docs/architecture/hosting.md` for the three things that would fix it.
5. **`/airport`'s truncation arithmetic** skips the overlap term rather than correcting it, so a
   truncated page's totals are approximate (disclosed on the page). No airport reaches the limit
   today — 959 rows against 5,000 — so this is a latent semantic, not a live bug.

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

Charts: Observable Plot. Maps: deck.gl + MapLibre + Natural Earth GeoJSON (no tiled
basemap — tiles are usage-priced).

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
- Every **successful** response gets `Cache-Control: public, s-maxage=2592000,
  stale-while-revalidate=86400`. Precompute leaderboards as static JSON at build time — the
  caching is the cost control, not the hosting tier. **404s get `no-store`**: the dataset is
  rebuilt monthly, so a 404 pinned in a shared cache outlives the condition that caused it.
  `/api/pivot` does this in its handler; a page cannot, and a proxy cannot see the
  downstream status — so **`proxy.ts` caches on "is this a well-formed, known entity",
  resolved before the page runs**, which is the rule M4d's entity pages must follow too.
  **A 5xx from a page is NOT covered and is knowingly still cached for 30 days** — measured
  on both `/route` and `/explore`, unfixable from a proxy, uncovered since M3b, and written
  up with the numbers in `docs/architecture/hosting.md` § The gap. Do not restate the rule
  as "errors get `no-store`"; it is 404s only.
  **A new page route must be added to `proxy.ts`'s matcher or it ships uncached and without
  the raw-query and pathname headers.** Full detail: `docs/architecture/hosting.md`.
- Build the **aircraft-type-mix chart before the load-factor chart**. Everyone does load
  factor; the gauge story is the differentiator.
- Build the generic Top-N builder once; the `/watch` presets are saved instances of it.
- **The cron must fail loudly.** A broken ingest doesn't error — the site keeps serving and
  `DATA AS OF` silently stops advancing. Alert when `max(year_month)` hasn't moved in ~45
  days.
