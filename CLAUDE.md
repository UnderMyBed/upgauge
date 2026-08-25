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

**Evidence for a SUPERSEDED state is not that, and does not stay.** Write the rule, not the
correction: a doc that keeps the old measurement beside the new one, or narrates what a past
revision of itself got wrong, doubles the figures that must stay true and reads as a story told
to ourselves. `docs/README.md` § How these docs work has the keep/cut test — apply it before
adding a "Correction" or a second measurement of anything.

### What a milestone closeout may add to THIS file

**A rule. Never narrative, never measurements.** A rule is something whose absence would let a
bug recur — the test is *"would removing this let someone re-introduce a defect we already paid
for?"*, not *"is this interesting?"*. Narrative belongs in the commit message. Measurements
belong in generated output, because hand-written ones rot (every closeout from M4c on found one
that had).

This file is loaded into context every session, so its size is a cost paid on every request. It
reached 909 lines before anyone measured it: **596 of them (66.7%) were milestone narrative
already duplicated in `docs/architecture/pipeline.md`**, and closeouts were adding ~110 lines
each while nothing was ever removed. `make check` enforces a line budget as a backstop
(`CLAUDE_MD_BUDGET`, Makefile). Raising it is allowed and deliberate — say why in the commit.
The budget is not the rule; it only catches the rule being ignored.

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

## Where things stand

**M1–M7 complete.** The Explorer (`/explore`), four cross-linked entity pages (`/route`,
`/airport`, `/carrier`, `/aircraft`), `/watch` and its four presets, `/search`, and
`/sitemap.xml` all ship. Charts and the airport network map are **server-rendered SVG, in the
served HTML, visible with JS off** — no client-side chart or map library anywhere in the render
path. `data/raw/` holds the full 2015–2026 window.

**Deployed and serving.** `https://upgauge.shipman.dev` answers behind Cloudflare, on a Hetzner
box its own timer keeps at `:deploy`. `warehouse.yml` polls BTS and publishes the dataset asset,
`image.yml` builds and gates the container, `promote.yml` moves the tag. `make portability` proves
the WORKDIR/data contract by breaking it, and is hand-run — no workflow invokes it.

Current gates (`app-check`/`app-smoke` measured 2026-08-25, `verify`/`goldens` 2026-08-08,
`portability` 2026-08-09, the rest 2026-08-10; the only counts kept here — history lives in git):

| gate | result |
|---|---|
| `make check` | ruff · `actionlint` · pytest. Test total is **generated** — `pipeline/reference/gates.generated.json`, gated by `check-gate-counts`. 49 skip without `data/` |
| `make app-check` | 1,397 app tests · without a built `upgauge.duckdb`, 501 of them fail |
| `make app-smoke` | 604 served-build checks |
| `make image-smoke` | the host set less the 10 host-only gap checks, which print as skipped — **338 when last measured (2026-08-10); NOT re-measured since — the host set has grown by 66 checks since, so 338 is a floor and not the current figure — and it needs Docker plus the pinned release asset** — that is `image-contract.yml`'s form, run **unoverridden** on a PR touching the image contract: pinned tag, needles on. `image.yml` runs the same target against the newest release with `SMOKE_DATASET_PINNED=0`, which reports **fewer** — the dataset-pinned checks skip without incrementing |
| `make portability` | **hand-run, no workflow invokes it** · **zero** served-build checks — three negative cases, each reproducing its own documented failure |
| `make verify` | 17 Parquet artifacts byte-identical · 10 database objects identical · basemap zero-diff |
| `make goldens` | byte-identical |

**The Python test total is no longer written here, and that is the point.** It moved four times
in one session (491 → 493 → 498 → 510), each move a hand-edit to this table — inside the file
whose own rule says measurements belong in generated output. `pipeline/gatecounts.py` states
which gate figures are generated and which are still by hand, and why; the ones still by hand
are in this table and must be re-measured when quoted.

**Numbers in this repo rot, and the rot is not cosmetic.** Every milestone closeout from M4c on
found a figure written into a permanent doc and never re-measured, and a BTS refresh **renamed
aircraft type 699 out from under the entire `/aircraft` slug fixture set**. Generate a figure
rather than restating it. **Page-cardinality figures are generated (`stats_counts.sql`) and every
place stating one is bound to the artifact BOTH ways by `test_stated_counts.py`: a stated figure
must be current, and a file stating one must be registered.** State a count in a new file without
registering it and the gate fails — which is the only reason a sweep of 27 files stays swept.
## Outstanding work lives in GitHub Issues, not here

**<https://github.com/UnderMyBed/upguage/issues>** — each epic a chunk that can be handed to a
swarm, each child task self-contained enough for one agent. **The milestone list and the epic
count live there, never here**: both were stated here and both went stale.

**Never grow a backlog here again.** A hand-maintained one states the same item three ways in
three files and drifts independently: the either-endpoint filter was described as missing in
**four** places for a full milestone after it shipped, two of them on served pages. A doc says
what is TRUE about the system; the tracker says what is PLANNED.

**M8 — the gap between "built" and "reachable" — is CLOSED:** the deploy artifact and
portability test (#1), ingest and freshness alerting (#2), cache correctness (#3), launch
configuration (#4), and an edge rate limit on every path that reaches the origin uncached (#83).
**Bot Fight Mode stays on**, so nothing watches the site on a schedule — that is #96, and it sits
in M9. Everything in M9 is a surface the product works without.

One finding worth keeping here rather than only in the tracker, because it is a rule:

- **`make app-smoke` could certify a build it never ran** (fixed — see the `kill_port` /
  `port_free_or_die` commit and the § above). The gate leaked a server holding its own port, so
  the next run's checks were answered by the previous run's build. Measured: two consecutive
  runs reported `266 ok` for a build that did not contain the change under test.

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

**Read `node_modules/next/dist/docs/` before writing app code** — Next 16 moved APIs and conventions off what training data assumes. `app/AGENTS.md` holds the full note; compaction drops path-scoped files, so it cannot be the only copy of this instruction.

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
| `make check` | **Format + lint + test. Run before every commit.** | ✅ |
| `make test` / `make lint` / `make fmt` / `make fmt-check` | pytest / ruff check / ruff format / `ruff format --check`, which `check` runs FIRST — drift is red, never a surprise diff | ✅ |
| `make fetch` | BTS T-100 zips → `data/raw/` (skips cached years) | ✅ |
| `make fetch-reference` | BTS support tables → `data/raw/` | ✅ |
| `make normalize` | Raw zips → `data/parquet/t100_segment/year=YYYY/` | ✅ |
| `make warehouse` | Facts + all 5 dims from `data/raw/` | ✅ |
| **`make verify`** | **M2 gate: build twice, prove Parquet + database byte-identical** | ✅ |
| `make ingest` | `fetch` + `fetch-reference` + `warehouse`, **force-refetching the last 2 years**. Rejects `ARGS` — two of its four steps must override it | ✅ |
| `make build` | Run `sql/` in order → `upgauge.duckdb` | ✅ |
| `make goldens` | Regenerate the Explorer contract fixtures (`sql/03_queries/goldens/`) from `pipeline/pivot.py` | ✅ |
| `make stats` | Regenerate `pipeline/reference/stats.generated.json`. **CI diff-gates it** — a diff means the upstream dataset moved | ✅ |
| `make gate-counts` | Regenerate `pipeline/reference/gates.generated.json`. **`make check` diff-gates it** — a diff means a test was added without regenerating. Separate artifact from `make stats` so the two reds stay distinguishable | ✅ |
| `make dev` | Next.js dev server (needs node) | ✅ |
| `make app-check` | Typecheck + lint + test the app (`app/`) | ✅ |
| `make app-build` | Production build of the app | ✅ |
| **`make app-smoke`** | **Build, serve, curl. The only gate that catches production-only bugs.** | ✅ |
| `make image` / `image-smoke` / **`portability`** | Build the deployable container · run the served-build checks against it, build identity asserted · **prove the WORKDIR/data contract by breaking it three ways** | ✅ |

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

**`mart_route_health`'s grain is `(op_airline_id, route)` — a carrier–route pair, never a
route.** Any sentence about one of its rows names the carrier, or it is a claim about a route
the query never made. This shipped wrong twice on the same page: `/watch/new-routes` told every
visitor its rows were "new service nobody flew last year" when **521 of 688 qualifying rows, and
25 of the 25 rendered**, had another carrier flying the pair inside the window — `AS HNL–ITO`
ranked first while HA, UA and WN filed 1,787,347 seats on it. When a compound claim is found
false, re-derive **each clause** from the query; do not triage by how true a clause sounds.

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

## Serving, routing and caching

Every rule here was a shipped bug first. Full detail: `docs/architecture/hosting.md`.

**`app/src/proxy.ts` + `skipProxyUrlNormalize` are load-bearing, not an optimisation.** Next
form-encodes the query string before any page or route handler sees it, turning the permalink
format's structural `:` into `%3A` and collapsing `k:a%2Cb,c` into `k%3Aa%2Cb%2Cc` — a data
comma becomes indistinguishable from a separator. Without them **every** filtered query fails on
**both** `/explore` and `/api/pivot`, reserved characters or not. Both entry points read the raw
string from a header and nothing else; **a page can never use `searchParams` for this.**
`proxy.ts` also sets the request pathname as a second header, which each `not-found.tsx` reads
(it accepts no props) — a page missing from the matcher loses its 404's entire message, not just
its cache header.

**`lib/db.ts` memoizes its `DuckDBInstance` on `globalThis`, not in a module-level `let`.**
Turbopack emits that module into a separate server chunk per entry graph — proxy, page SSR,
route handler — so a module-level memo is *three* memos. Measured: one `next start` opened
`upgauge.duckdb` three times, three buffer pools, three snapshots of a file the proxy and the
page must agree about. No unit test can see this (one module graph by construction);
`make app-smoke` asserts the open-handle count is 1.

**The cacheability predicate is an allow-list — `kind === "ok" || kind === "redirect"`, never
`!== "notFound"`.** `resolveAircraftSlug` has four outcomes: `/aircraft/CE-180` is `ambiguous`,
renders a 404, and the `!==` form would pin it in a shared CDN cache for its full TTL.

**A 404 names which way it failed, and names every holder.** An unknown code and a real code
this domestic-only dataset carries no rows for are different findings. `/carrier/PA` is *not*
"Pan American" — `PA` holds three `airline_id`s, two Pan Am eras plus an unrelated Florida
Coastal, and picking one is the silent-pick failure the split exists to refuse.

**`/search` 307s, never 308.** A code resolving uniquely is a fact about *this month's* dataset;
a 308 is cached by the browser permanently, so a code that started colliding in a future rebuild
would leave a wrong permanent redirect no server-side fix could reach. `/search` is also
`no-store` **unconditionally** — `q` is an unbounded, attacker-chosen cache key.

**The route cell displays in airport-ID order and links in code-alphabetical order, and the two
disagree.** 215 of 22,509 pairs. `IFP–IAH` displays that way and must link to `/route/IAH-IFP`.
A `JFK–LAX`-shaped fixture cannot fail this way, so any test for it needs a disagreeing pair.

**`entityLink`'s map is keyed on the dimension's own key, never `join_dim`.** `route`,
`origin_airport_id` and `dest_airport_id` all carry `join_dim = dim_airport`, so a
`join_dim`-keyed map sends route cells to `/airport/`.

**`sitemap` `lastmod` is each entity's own last-filed month, never the build date.**
`/carrier/VX`, dormant since 2018-03, is the fixture that distinction needs.

**A new top-level route is not shipped until something already-reachable links to it.** Neither
`sitemap.ts` nor `proxy.ts`'s matcher counts. `/watch` shipped with zero inbound internal links,
one milestone after M5 existed to remove exactly that kind of island.

## Charts and maps

Encodings live in `docs/design/system.md`. These three are the traps.

**Gaps are gaps, and zero is not the alternative.** T-100 is a *filing*, so a month with no row
is neither "nobody flew" nor "0 seats flew" — drawing it either way invents data. Areas break
into contiguous runs, one `z` series each, and the count is stated on the chart and in its
`aria-label`. 62% of route pairs have such a gap; 41% have an isolated single month, drawn
**stroked**, because a one-month area has no width and erasing a filing is the same dishonesty
as inventing one. This shipped wrong once: `HNL–LAS` drew a straight edge across six unfiled
COVID months, *inside* the band labelled "COVID — in window on purpose".

**Band membership and band shade are two different orderings.** Membership by total seats,
shade by gauge (Σ seats / Σ departures) — so the lightest band is the smallest metal and **an
upgauge darkens the stack**. On JFK–LAX the two sorts share only their first element. A single
sort produces a chart that looks plausible and encodes nothing. A type that flew nothing has an
*unknown* gauge and sorts last, never lightest.

**A per-page map fit reuses the coastline's own baked `fitPanels(BASEMAP_FIT_POINTS)` verbatim
— never union the subject's points into it.** This repo's own written guidance recommended the
union and was wrong; M7 Task 8 disproved it against served pages.


## Data gotchas

Full detail and the measurements behind each: `docs/data/invariants.md`.

- **PREZIP is dead for T-100** — every file there is dated 2015-09-02. The
  `DL_SelectFields.aspx` POST is the only path, it's ASP.NET WebForms (GET for cookies +
  `__VIEWSTATE`, then POST), and TranStats obfuscates URL params with *two* ROT13 variants.
- **The fetch cache is keyed by YEAR, so a plain re-fetch can never see a new month.** BTS
  drops 2026-05 *inside* the already-downloaded 2026 zip, and support tables have no year at
  all — one cached file suppresses them forever, hiding the aircraft **rename** that
  `classify_warehouse.py` exists to catch. Any ingest path must force the current **and
  previous** year (BTS revises closed months) plus every support table. `make ingest` does;
  `make fetch` alone does not, and shipped as a permanent silent no-op in the publisher.
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
- **`make app-smoke` exists because unit tests structurally cannot see a whole class of bug.**
  Green suite, broken production: `__dirname` under Turbopack, `decodeURIComponent` throwing,
  `process.chdir`, the DuckDB platform-switch `require`, and query normalization — every one
  found by building and serving, never by the suite. Run it before merging anything touching
  routing, config, or the query layer.
- **A smoke needle is written in the bytes React EMITS, not the bytes the source contains.**
  `check_not … 'can&rsquo;t be read'`, copied from a JSX `<h1>`, could never fire: JSX decodes
  entities at compile time and React emits raw U+2019, so the check printed `ok`
  unconditionally. Anything with an entity, apostrophe or angle bracket needs a mutation run
  before it counts as coverage.
- **`app/smoke.sh` has produced three self-defects; assume a fourth is possible.** (1) `set -o
  pipefail` + `grep -q` made a check's result depend on where in the page the needle sat, and
  made `check_not` report a silent **ok** for a string that was present. (2) The entity-decoding
  needle above. (3) The teardown matched no process — Next rewrites its title to
  `next-server (v…)` — so every run leaked a server holding its own port and the next run's
  checks were answered by the **previous build**: two consecutive runs reported `266 ok` for a
  build that did not contain the change under test. A gate that passes for the wrong reason is
  the one failure this file cannot tolerate, because nothing else is watching it.
- **A correction is not landed until the user-facing copy carries it.** The "saved Explorer
  queries" claim was fixed in six places and left standing in the one sentence a visitor reads.
  Grep-based sweeps miss **paraphrases** — check by meaning, not by string.
- Marts must rebuild from scratch reproducibly via `make`. No manual steps.
- **The project's `Cache-Control` is NOT one value.** `/api/pivot`'s own successful responses,
  `/sitemap.xml`, and `/robots.txt` get the full `public, s-maxage=2592000,
  stale-while-revalidate=86400`. `/explore` and the four entity pages get the shorter
  `HTML_CACHE` instead, `public, s-maxage=3600, stale-while-revalidate=86400` (M5 Task 7 — see
  below for why). `/search` gets `no-store` unconditionally, regardless of outcome (`q` is an
  unbounded, attacker-chosen cache key). **404s get `no-store`**: the dataset is
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
  **A new page route must be added to `proxy.ts`'s matcher or it ships uncached and without the
  raw-query and pathname headers** — sixteen entries, four of them `opengraph-image`. A static, closed slug set
  (like `/watch`'s four presets) is necessary but not sufficient for the matcher's own cacheability
  branch to skip a database probe — every preset page still runs a `mart_route_health` query the
  proxy commits to a cache header before, so `isDataLayerHealthy()` gates it exactly like
  `/explore` and `/sitemap.xml`/`robots.txt` do. Full detail: `docs/architecture/hosting.md`.
- **Every matcher path declares its legitimate query keys (`lib/canonicalQuery.ts`), and a
  non-canonical query is never a cached 200:** 307 + `no-store` on the ten paths the proxy gates,
  400 + `no-store` from `/api/pivot`'s own handler (a JSON endpoint must not 307), nothing on
  `/search` (`no-store` unconditionally, must never redirect). A CDN's cache key includes the query
  string, so `?x=1…N` was unbounded. **`exempt` means "the proxy does not redirect this path",
  never "the rules do not apply"** — the second reading left `/api/pivot`'s `&&`/trailing-`&` axis
  a 30-day-cached 200 (`splitPairs` skips an empty chunk), on the ELEVENTH cacheable path this file
  had called ten. Byte-equality against the canonical string, not "unknown key present": `?&&` has
  none. `f` is repeatable. It is one canonical KEY SET, never "one spelling" — key order survives,
  and *that module* inspects no value; don't restate it wider.
- **Values are bounded too — `lib/pivot/bounds.ts`, not the key gate.** `t` inside the months this
  dataset covers with `from ≤ to`, `n` under a ceiling, no repeated token in `d`/`m`, and every key
  but `f` spelled ONE way. **A shape check downstream of `pyUnquote` is not a spelling bound** —
  `decode()` unquotes at `urlstate.ts:179` and runs `MONTH_RE` at `:214`, so `t=2015-01:2015-12` had
  110,592 encodings of one admissible value and `MONTH_RE` constrained none of them. Bounding a
  RANGE alone bounds nothing, on any key. Checked on the RAW bytes; SERVER admission, never the
  codec (`decode()` is pinned to `pipeline/urlstate.py` as an exact port), so all three entry points
  call `decodeRequest`. `f` is the residual, NARROWED not closed: an integer-typed dimension's value
  must be a canonical in-range whole number (`render.ts` + `pivot.py`, #87 — a digits-only rule
  admits `distance_group=99999`, which 500s). VARCHAR values, `f`'s repeat count and its spelling
  exemption (`%` is its own escape there) stay open, left to an edge rule matching `/api/` only.
- **Nothing on the proxy path may throw.** `canonicalize()` threw on a leading `?` as a "wiring
  bug"; `proxy.ts` strips only ONE `?` (non-global regex) and has no try/catch, so `GET /watch??x=1`
  500ed every matcher path — and no smoke check used a doubled `?`, so both gates missed it.
- Build the **aircraft-type-mix chart before the load-factor chart**. Everyone does load
  factor; the gauge story is the differentiator.
- **The `/watch` presets are NOT saved instances of a generic Top-N builder**, and the opposite
  claim was stated in three files at once before anyone checked it. Every `meta_pivot_measures`
  row is a single-window aggregate; every preset ranks on a delta between two windows, which no
  pivot measure expresses. The presets read `mart_route_health` directly and share only
  `DataTable`'s rank column with the Top-N builder (`app/src/lib/topn.ts`), which is built and
  first used by `/carrier`'s Top routes / Top origin airports tables.
- **The cron must fail loudly.** A broken ingest doesn't error — the site keeps serving and
  `DATA AS OF` silently stops advancing. Alert when `max(year_month)` hasn't moved in ~45
  days.
- **The warehouse CI restores is unpinned, and drift is caught at the producer.** A red
  `data-contract` job means the upstream dataset no longer matches this commit's reference
  values; every other red in that run is probably a consequence. Fix by `make stats`, then
  re-pin dependants in the same commit. **When a renamed value was the fixture for a transform,
  MOVE the fixture** — a replacement that no longer exercises the path passes against the very
  bug it exists to catch.
