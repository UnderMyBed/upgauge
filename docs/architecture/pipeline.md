# Pipeline & repo layout

## Repo scaffold

```
upgauge/
├── docs/                       see docs/README.md
├── Makefile                    make ingest / make build / make dev
├── pipeline/                   Python 3.12 + uv. Runs in CI only.
│   ├── btscodec.py             the two TranStats ROT13 variants (data/sources.md)
│   ├── fetch.py                DL_SelectFields POST loop + cache → data/raw/
│   ├── normalize.py            raw → data/parquet/t100_segment/year=YYYY/
│   ├── build.py                facts + dims from data/raw/ (M1); also `make verify`
│   ├── marts.py                runs sql/02_marts/ in order → upgauge.duckdb (M2)
│   └── tests/                  the data invariants. These gate the pipeline.
├── sql/
│   ├── 01_staging/             shared by pipeline AND server. Never inline SQL.
│   ├── 02_marts/
│   └── 03_queries/             the Explorer's parameterized queries
├── app/                        Next.js 16, App Router, TS, Tailwind v4
│   ├── src/proxy.ts            hands both entry points the RAW query string (load-bearing)
│   └── src/app/
│       ├── api/pivot/          route handler → @duckdb/node-api → sql/03_queries/
│       └── explore/            the Explorer. route/airport/carrier/aircraft/watch alongside
└── data/                       gitignored
```

**Charts:** Observable Plot (better than Recharts for dense multi-series time series).
**Maps:** **not** deck.gl/MapLibre (the original spec) — a from-scratch, dependency-free,
server-rendered SVG engine (`app/src/lib/map/`, M7 Tasks 4-8), fed by committed, pre-projected
Natural Earth GeoJSON. Superseded on measurement: the map needed the same "in the served HTML,
visible with JS off" property the charts already had, which a client-side library cannot give
for free.

---

## Milestones

**This file owns the ingest and query layers, not the product surfaces.** Pages, charts and
maps are owned by [`../product/features.md`](../product/features.md) and
[`../design/system.md`](../design/system.md); routing and caching by [`hosting.md`](hosting.md);
data rules by [`../data/invariants.md`](../data/invariants.md) and
[`../data/model.md`](../data/model.md).

**Per-task narrative does not belong here.** Git history and commit messages are the home for
"what happened on this branch." Milestone sections below record what a milestone WAS and point
at the doc that owns each rule.

**What was planned, and what actually shipped.** The plan drifted by roughly two milestones and
the terminal one was lost; both columns are kept because the drift is the lesson.

| | planned | actually shipped |
|---|---|---|
| **M1** | Ingest: `DL_SelectFields` POST loop → raw → Parquet, 2015→present, invariant tests passing | ✅ as planned |
| **M2** | Marts built by SQL, reproducible from scratch via `make` | ✅ as planned — [§ M2](#m2--the-marts-layer) |
| **M3** | Explorer: pivot query + URL state + table | ✅ as planned, split M3a/M3b — [§ M3](#m3--the-explorer-split-into-m3a-and-m3b) |
| **M4** | Entity pages, charts, design system applied | ✅ as planned, split M4a–M4d |
| **M5** | Maps (airport + carrier + aircraft), then `/watch` presets | ❌ **neither.** Shipped the link graph: cell links, `/search`, `/sitemap.xml` — [§ M5](#m5--connecting-the-graph) |
| **M6** | **Deploy + Cloudflare cache + edge rate limit + monthly cron + freshness alert** | ❌ **none of it.** Shipped `/watch` and the health score — [§ M6](#m6--gauge-watch-and-the-top-n-builder) |
| **M7** | *(unplanned)* | The airport network map + the either-endpoint filter — M5's map item, two milestones late — [§ M7](#m7--maps-and-the-either-endpoint-filter-they-need-first) |
| **M8** | — | **Deploy.** See the tracker; this is M6's original content, never rescheduled after M6 was repurposed. |

**Seven milestones of building, none of releasing.** Nothing was dropped deliberately — M5's
maps slid to M7, M6's deploy simply fell off the end, and no one noticed because this table was
never updated. **When a milestone is repurposed, say where its original content went.**

Outstanding work now lives in
[GitHub Issues](https://github.com/UnderMyBed/upguage/issues), not in this table.

### M1 — ingest

Endpoint spike, scaffold, `fetch.py`, invariant tests, `normalize.py`, the five dims, and the
reproducibility gate. Two sequencing rules came out of it and still bind:

- **Prove the acquisition path before building on it.** The spike ran first because the
  endpoint was the one part of the spec that turned out *not* to be as documented — see
  [../data/sources.md](../data/sources.md).
- **Resolve invariants against a real extract before writing them as tests.** Tests landed
  after the fetcher and before normalize for exactly that reason: writing an invariant from
  assumption is how you get a green suite that is confidently wrong.

### Fetcher design notes

- **Cache key is `(table, year)`**, never the served filename — BTS regenerates that per
  request, so using it would re-download every year forever.
- **Re-GET the form on every retry attempt.** Cookies and `__VIEWSTATE` must come from the
  same request; a retry that reuses a stale viewstate is rejected.
- **The response is validated before anything touches disk**, so a failure can't leave a
  partial file that makes the next run skip a year it never actually got.
- **Encode the POST body by hand.** `httpx`'s `data=` takes a mapping, but the payload is an
  ordered sequence of pairs — passing a list of tuples silently becomes raw content.
- **A partial ingest must never look like success.** The CLI reports every year, names the
  failures, and exits non-zero.
- `--start` below 2015 is rejected: widening the window is a product decision, not a flag.

**Verified live 2026-07-29** against the real endpoint — 11,730,135 bytes / 367,360 rows /
45 columns for 2015, byte-identical to the phase-0 manual download, and a cached re-run
completing in 0.01 s with no network.

### Normalize design notes

- **The transform is SQL, in `sql/01_staging/normalize_t100_segment.sql`**, with bound
  parameters rather than interpolation. That is what lets the server reuse the definition.
- **Read the CSV as all-VARCHAR and cast explicitly.** Letting DuckDB's sniffer pick types
  turns `AIRCRAFT_TYPE` `079` into `79` and breaks the dim join silently.
- **Pre-flight checks run on the raw extract, before filtering.** The rollup-class check has
  to see a `K` row, and the service filter would already have dropped it.
- **Write to a staging dir and swap**, so a failure mid-write can't leave a half-written
  partition that later reads treat as complete. Replaces rather than appends, so a re-run
  cannot double every row.
- **A missing fetch sidecar is an error, not a default.** A guessed `download_date` would
  silently corrupt amended-filing resolution.
- **Nothing derived is stored** — no `load_factor`/`asm`/`rpm`/`avg_gauge` column exists, so
  nothing downstream can `AVG()` one.

**Verified on real 2015 data:** 367,360 raw rows → **282,036** scheduled-passenger rows,
12 months, only `CLASS='F'` and configs 1/3/4, **16 quarantined (0.006%)**, zero route-key
ordering violations, 8.6 MB Parquet from a 101,182,581-byte CSV.

### Reproducibility

`make verify` is the M1 exit criterion: `build_all` twice from identical raw inputs, sha256
every artifact, report any that differ by name. It reports rather than raises, so a drifting
build names the offending file.

Two things make it hold:

- **`data/raw/` is append-only.** Filenames carry the download date, so a re-fetch adds a
  file instead of overwriting the one that produced published numbers. `latest_raw` feeds the
  build; superseded downloads are audit-only and never read.
- **Parquet writes are pinned to `threads = 1`.** DuckDB's parallel writer is not byte-stable
  (see [../data/invariants.md](../data/invariants.md)). ~8 s cost across the window.

## M2 — the marts layer

`upgauge.duckdb` is a **hybrid**: facts and dims are views over the Parquet tree, and
`mart_route_health` is the only materialized table. Views keep M1's byte-identical Parquet gate
covering everything derived-free, and the mart materializes because trailing-12 windowing over
the full window is the one genuinely expensive thing in the layer.

Scope is `fct_route_month`, `dim_city_market`, and `mart_route_health`. **There is no
leaderboards mart**, and nothing should reintroduce one: `/watch`'s four presets
(`sql/03_queries/watch_*.sql`) read `mart_route_health` directly, add no pivot SQL of their own
— no pivot measure expresses a delta between two windows — and share nothing across them
except `DataTable`'s rank column.

### The runner

✅ **Built.** `pipeline/marts.py` executes `sql/02_marts/*.sql` in filename order — `make
build` un-stubbed, 21 tests in `pipeline/tests/test_marts.py`. Each file declares its own
materialization in a header directive, so the runner needs no separate manifest to drift:

```sql
-- upgauge: view          (or: table)
-- object: fct_route_month
SELECT ...
```

The runner wraps the body in `CREATE OR REPLACE VIEW <object> AS <body>` or
`CREATE TABLE <object> AS <body>`. That DDL wrapper is the only SQL in Python, and it is the
same shape as `normalize.py`'s already-accepted `COPY (<sql file>) TO ...` — the hard rule is
about *query logic*, which stays in `.sql`.

### The catalog views

✅ **Built.** `sql/02_marts/010_fct_segment_month.sql` and the five
`02x_dim_*.sql` / `024_map_mainline_group.sql` files turn the Parquet tree into `make build`'s
six database objects — `fct_segment_month`, `dim_airport`, `dim_city_market`, `dim_carrier`,
`dim_aircraft_type`, `map_mainline_group`. All six are plain `SELECT * FROM read_parquet(...)`
views, nothing materialized: the fact view adds `hive_partitioning = true`, and every dim view
is a single-file read. No derived measure column
(`load_factor`/`asm`/`rpm`/`avg_gauge`/`completion_factor`) exists on `fct_segment_month`, and
quarantined rows are retained with their flag rather than dropped — the view is the fact
table, so this is the last point at which dropping them would be reversible.

**`year` is a content column AND a Hive partition key — `hive_partitioning = true` is for
pruning, not schema.** `normalize_t100_segment.sql` already casts `raw.YEAR` into the Parquet
content, independent of the `year=YYYY` directory it lands in, so `year` shows up in
`fct_segment_month` either way — flipping the flag to `false` does not drop the column.
Measured against the real 3-year warehouse in `data/parquet/` (`EXPLAIN ANALYZE`, JSON
profiling, DuckDB 1.5.5): `WHERE year = 2015` reports `Total Files Read: 1` (of 3) with the
flag on, versus `Total Files Read: 3` with it off — same result (705,332,563 passengers)
either way, so the flag buys I/O, not correctness. Separately, a scratch experiment (two
partition dirs whose content `year` column deliberately disagreed with the directory name)
showed DuckDB does not error or duplicate the column when the two conflict: there is still
exactly one `year` column, and the partition-derived value silently wins over the file's own
content value. Real builds never hit this — the partition directory name and the content
column are written from the same `year` argument in `normalize_year` — but it is a real,
previously-undocumented property of this view.

### Views cannot take bound parameters — so CWD is load-bearing

`CREATE VIEW` captures literal SQL text, so the Parquet root cannot be a `$param` the way every
other path in the pipeline is; it is interpolated at build time. DuckDB resolves relative paths
against the **process CWD, not the database file's directory**, which forces a choice:

- An *absolute* path works in CI and breaks in Docker, because the build machine's
  `/home/runner/...` does not exist in the image. Silently — the file opens fine and every
  query fails on read.
- A *relative* path works anywhere, provided CWD is fixed. So views reference
  `data/parquet/**` relatively, the container sets `WORKDIR /app` with data at `/app/data`, and
  CI builds from the repo root.

A test asserts no absolute path appears in any view definition, because that failure is
invisible until deploy.

**Confirmed empirically, not just by assertion.** With `upgauge.duckdb` built from the repo
root (views referencing `data/parquet/...`), opening that same file from `/tmp` — a foreign
CWD, the way a container would if `WORKDIR` were wrong — and querying `fct_segment_month`
raises `duckdb.IOException`: `IO Error: No files found that match the pattern
"data/parquet/t100_segment/**/*.parquet"`. The database opens fine; only the read fails. **That
is the exact failure shape to expect if the Dockerfile ever ships without `WORKDIR /app`**, and
it is the negative case the portability test has to reproduce deliberately.

### The M2 gate

✅ **Built.** `make verify` runs three checks in sequence and fails if any fails:

1. **Parquet reproducibility:** `build_all` twice into throwaway temp
   dirs from identical raw inputs, sha256 every artifact. **17 artifacts on the full
   2015–2026 window** — 12 fact-year partitions + 5 dims. The dims count is fixed; **the
   fact-year partition count grows with `data/raw/`'s window**, so this number moves when a
   year is fetched and is not a constant to assert against.
2. **Parquet freshness:** the two throwaway builds above only prove
   they agree *with each other* — neither is `--out-dir`, the Parquet that `make build`
   and the database gate below actually read. So `_digest_tree` on one of the throwaway
   builds is compared against `_digest_tree(--out-dir)`, and any difference is named. This
   is what catches `make fetch` adding a year that `make warehouse` never picked up: the
   database gate's object *count* doesn't change when a fact-year partition goes stale,
   because it counts objects, not files, so without this check that staleness is
   invisible to `make verify` and only shows up later as `DATA AS OF` silently failing to
   advance.
3. **Database:** `pipeline.marts.verify_database` builds `upgauge.duckdb` twice
   from the same Parquet and, for every catalog object, exports it through a
   `COPY (SELECT * FROM <object>) TO ... (FORMAT PARQUET)` on a connection with
   `SET threads TO 1` — the same writer setting that makes the Parquet writer byte-stable —
   then sha256s that export. **10 objects:** the 6 views over Parquet (`fct_segment_month`,
   `dim_airport`, `dim_city_market`, `dim_carrier`, `dim_aircraft_type`,
   `map_mainline_group`), the two derived views/tables (`fct_route_month`,
   `mart_route_health`), and the two Explorer allowlist views (`meta_pivot_dimensions`,
   `meta_pivot_measures`). **This count tracks `sql/02_marts/`, not the data window.**

Both counts are measured, not asserted from the file layout — **the counts `make verify`
prints are what to trust over this paragraph.**

**The `.duckdb` file itself is never hashed.** Measured before this gate was written (see
[../data/invariants.md](../data/invariants.md)): three identical builds of the same content
produced three different `.duckdb` digests, reproducibly. So `verify_database` compares
*exported content*, the same way the Parquet gate compares row content rather than raw
catalog bytes. `_digest_object` runs the export on the connection that already holds the
built objects — it cannot go through `pipeline.normalize._writer_connection()` like every
other Parquet write, because that helper opens a fresh connection with nothing in it. It
applies the identical `SET threads TO 1` itself; the docstring flags this as a deliberate,
sanctioned exception to "all Parquet writes go through `_writer_connection()`", because if
that `SET` is ever dropped the gate starts reporting false failures rather than silently
passing.

Real run, full 2015–2026 warehouse:

```
$ make warehouse && make verify
parquet: 17 artifacts byte-identical across two builds
parquet: comparing data/parquet (on disk) against a fresh build from data/raw
parquet: data/parquet matches a fresh build from data/raw (17 artifacts)
database: 10 objects identical across two builds
```

**M2 complete.** `make build` produces `upgauge.duckdb` from `sql/02_marts/`, and
`make verify` proves both the Parquet artifacts and every database object byte-identical
across two from-scratch builds.

## M3 — the Explorer, split into M3a and M3b

M3 split into three parts with different blockers: **M3a**, the pivot query contract (templates,
the allowlist, the URL codec, golden fixtures); the **design session**
([../design/brief.md](../design/brief.md), answered by
[../design/system.md](../design/system.md) with mockups in
[../design/mockups/](../design/mockups/)); and **M3b**, the Next.js app.

**Why the design session sits in the middle.** The data table is the product
([../design/brief.md](../design/brief.md)), so building it means deciding the visual system
whether or not that is planned for. Building against invented styling and retrofitting real
tokens later is the expensive kind of rework, and the brief's constraints — mono tabular
numerals, density over whitespace, the `DATA AS OF` badge — are structural, not cosmetic.

### `pipeline/` is CI-only, which dictates M3a's shape

The Explorer's validator runs **per request, in the server** — TypeScript. `pipeline/` never
runs in prod. So M3a must not write the validator in Python: M3b would reimplement a
security-relevant validator in TS and we would have two, drifting.

M3a therefore ships a **contract plus golden fixtures**, not a query layer:

| Artifact | Purpose | |
|---|---|---|
| `sql/03_queries/pivot_segment.sql`, `pivot_route.sql` | The templates. `{{TOKENS}}` for identifiers, `$params` for values. | ✅ Task 3 |
| `sql/02_marts/300_meta_pivot_dimensions.sql`, `301_meta_pivot_measures.sql` | The allowlist, **as catalog objects** — the server already opens the database, so there is no extra artifact to ship and `make build` regenerates it. | ✅ Task 2 |
| `sql/03_queries/catalog_dimensions.sql`, `catalog_measures.sql`, `data_as_of.sql` | The reads of those catalog objects (and the freshness stamp), **as `.sql` files** rather than string literals in `load_allowlist` — `pipeline/pivot.py:132,140` inlined `SELECT * FROM meta_pivot_…` until M3b prep Task 1 extracted them, so the server's TypeScript can read the identical files instead of copying the inline violation into a second language. `data_as_of.sql` has no Python caller yet; it exists so M3b has no excuse to inline one either. | ✅ M3b prep Task 1 |
| `sql/03_queries/goldens/pivot.json` | Golden fixtures: query state → expected SQL/params. M3b's TypeScript must reproduce them byte-for-byte. One validator semantics, two runtimes, proven to agree. | ✅ Task 7 |
| `sql/03_queries/goldens/urlstate.json` | Golden fixtures: URL round-trips. The permalink contract, settled before any component reads state. Task 1 of M3b prep added an eighth case, `filter_value_encodeuricomponent_divergence`, pinning that Python's `quote(v, safe="")` percent-encodes `! * ' ( )` while JS's `encodeURIComponent` does not — a naive TS port using the JS default would have passed all seven prior goldens and still diverged (119 `unique_carrier_code` values carry BTS's `(1)` suffix; 163 airport names carry an apostrophe). | ✅ Task 7, extended M3b prep Task 1 |
| Python reference implementation (`pipeline/pivot.py`, `pipeline/urlstate.py`) | Legitimately in `pipeline/`: it *generates and verifies* the goldens in CI and never serves a request. | ✅ Tasks 3, 6 |

The allowlist is **curated, not introspected** — which dimensions we offer is a product
decision, not a schema fact. A test cross-checks it against `duckdb_columns()` so a renamed
column fails loudly instead of silently dropping a dimension.

Consequence to accept knowingly: `make verify` now covers a product decision (the Explorer's
vocabulary), not only data. That is the price of the allowlist being un-driftable.

### Only identifiers are substituted, and only after allowlist validation

Values are always bound `$params`. Identifiers — the dimension list, the `GROUP BY`, the sort
column — are substituted, and only ever from the validated allowlist, never from request input.
Same shape as M2's `{{PARQUET_ROOT}}`.

The alternative considered and rejected was a fully static template with no substitution at
all, `CASE WHEN $by_carrier THEN op_airline_id END` per dimension. It makes injection
structurally impossible and needs no allowlist, which is philosophically closer to "can't
average what doesn't exist" — but it defeats the partition pruning M2 fought to restore, and
dynamic sort and Top-N each need their own contortion. Rejected on those grounds, not on
readability.

### Every guard gets its breaking change observed

**The single most common review finding in this project is a test that passed for a reason
other than the one it named.** Six real instances, all from the marts layer:

- `test_distance_is_not_summed` stayed green when `max(distance)` was swapped to `sum(distance)`
  — no fixture route-month had two aircraft types.
- The partition test stayed green with `hive_partitioning` disabled — `year` was already a
  Parquet content column, so the flag was never what exposed it.
- A tiebreak test was guarded by `if row is not None` against a fixture missing that row.
- A guard-rail assertion was unreachable: `parse_mart_file` raised before the assert ran.
- The `make verify` mismatch test used a global counter, so both builds drifted identically and
  the drift it existed to detect was masked.
- All 12 real-data invariant tests had never executed since M1 — the module looked for an
  undated filename the append-only scheme makes impossible.

Every one was found by mutating production code and watching what stayed green. **None was
visible from reading the diff.** So this is a required step, not an aspiration: for each guard,
make the change it exists to catch, observe the failure, revert, and record the output. A guard
never observed failing is not a guard.

## M4a — entity resolution

`/explore` rendered raw catalog ids (`19790`, `14747`, `612`) through all of M3b — a
documented, known gap (see the M3b entry above). M4a closes it: `DL`, `SEA`, `B737-7`.

### Why resolution runs after the pivot, not inside the templates

`meta_pivot_dimensions`' `join_dim`/`join_key` columns existed since M3a for exactly this
join, and joining `dim_carrier`/`dim_airport` straight into `pivot_segment.sql` /
`pivot_route.sql` was the design that was rejected. Doing so would change what the pivot
templates emit, which reopens the M3a contract: all 17 goldens regenerate, and
`pipeline/pivot.py` and the TypeScript renderer have to change in lockstep or silently
drift — two milestones were spent making that contract verifiable in two languages, and
resolution is a display concern, not a reason to reopen it.

Instead, resolution is a separate query stage that runs **after** `runPivot()` returns, keyed
on the ids actually present in the returned page (at most `n` rows). `app/src/lib/resolve.ts`
collects the distinct ids per resolvable column (`collectIds`), issues one bound query per
dimension **present in the result** — not one per dimension in the catalog — and returns a
`Map<resolutionKey, {code, name}>` that the page merges in at render time. The pivot SQL, the
codec, and every golden are untouched; the id stays on the row for sorting, filtering and the
permalink exactly as before. Cost: one extra small indexed lookup per dimension present,
against an in-process DuckDB with no network hop — accepted for keeping the M3a contract
frozen.

### Four resolver files, one per dimension shape

Per CLAUDE.md's "all query logic lives in `.sql`" rule, each resolver is its own file in
`sql/03_queries/`, and the only TypeScript is the merge (collect ids, bind, attach):

- `resolve_carrier.sql` — `op_airline_id` → `dim_carrier.carrier_code` + `name`. One row per
  `airline_id` (v0 collapses Carrier Decode), so this join cannot fan out.
- `resolve_airport.sql` — `origin_airport_id` / `dest_airport_id` / `route_key_low` /
  `route_key_high` → `dim_airport.code` + `name`. `WHERE is_latest` is load-bearing: 5,033
  `airport_id`s carry more than one `airport_seq_id` row, and omitting the filter fans out
  and multiplies result rows — a wrong total under the `DATA AS OF` badge. Exactly one
  `is_latest` row exists per `airport_id` today, so the filtered join is 1:1; a cardinality
  test in `resolve.test.ts` pins that.
- `resolve_city_market.sql` — `origin_city_market_id` / `dest_city_market_id` →
  `dim_city_market.name`. `dim_city_market` has no code column at all, so `code` is a typed
  `NULL` and the name renders directly as the cell value rather than as an `abbr` title.
- `resolve_aircraft_type.sql` — `aircraft_type` → `dim_aircraft_type.short_name` + `name`.
  This one inverts the usual direction: the fact table already stores the join key (a
  zero-padded string code like `'612'`), and what's missing is a human-readable value.
  Returning `dim_aircraft_type.code` would just re-render `'612'` — the exact thing this
  milestone removes — so `code` in the resolver's output is actually `short_name`
  (`B737-7`), not the BTS code, playing the role `carrier_code` plays for carriers. `id`
  stays `VARCHAR`: CLAUDE.md's zero-padded-code rule applies to the join key here too.

`resolve.ts`'s `RESOLVER_FILE` is the only place a dimension's `join_dim` maps to a file
name, and it is keyed on the catalog's own `join_dim` string (`dim_carrier`, `dim_airport`,
…) — never on a dimension's name (`op_airline_id` vs `origin_airport_id` vs
`route_key_low`/`high` all resolve through the same `dim_airport` entry without a
name-based branch anywhere in `collectIds` or `resolveRows`). `route` itself had no
`join_dim`/`join_key` in `meta_pivot_dimensions` before M4a — its `column_expr` names two
airport-id columns but the catalog couldn't describe how to resolve them. The fix was to
the metadata (both keys now name `dim_airport`), not a special case in the resolver.
`RESOLVER_FILE` is exported and `resolve.test.ts` asserts it has an entry for every distinct
non-null `join_dim` the live catalog carries — an unmapped `join_dim` would otherwise be a
silent-degradation path: `collectIds` just `continue`s past it and the affected dimension
keeps rendering raw ids forever, with every other test staying green.

### The `{{IDS}}` bound-parameter token

Each resolver file's `WHERE ... IN {{IDS}}` clause is filled in at request time with a
parenthesised list of **bound parameter names** (`($id0, $id1, …)`), never with values —
the same substitute-a-name / bind-the-value split `render.ts` uses for the pivot templates.
`resolve.ts`'s `substituteIds` counts occurrences of the `{{IDS}}` token before replacing:
`String.prototype.replace` with a string needle only touches the first match, so if the
token appeared a second time anywhere in the file — including inside a comment — the real
`WHERE` clause would end up still holding the literal token, and DuckDB would reject it as a
parse error at execution rather than failing at substitution time where the mistake is
obvious. `substituteIds` throws loudly if the count isn't exactly 1, which is why every
resolver file's header comment above describes the placeholder in prose instead of writing
it out.

Resolution shipped without moving the M3a contract: `make goldens` reproduces all 17 goldens
byte-identical, which is the proof that matters here.

## M4b — the route page

`/route/<pair>` is the first entity page: `/route/JFK-LAX` is a saved pivot query (segment
grain, grouped by operating carrier, filtered to one undirected route) composed on top of the
same pivot layer M3/M4a already built, deliberately reusing `DataTable` / `LegendRail` and
the resolution layer rather than writing bespoke SQL. That reuse is also what makes the
Explorer link free: the page's query *is* a `PivotQuery`, so `encode()` yields the permalink
directly. No chart in M4b and no new dependency — the aircraft-type-mix chart was mounted on
this page in M4c (§ M4c, below), which is where the Plot dependency and the second, wider
query arrived.

### Composite-dimension filtering, added in lockstep

The pivot had no way to filter on `route` — a dimension whose `column_expr` names two
columns (`route_key_low`, `route_key_high`) rather than one. The obvious workaround —
`origin_airport_id IN (a,b) AND dest_airport_id IN (a,b)` — is not equivalent to "the route
between a and b": it also matches same-airport filings (`a→a`, `b→b`), which are not a
curiosity — 12,738 of them exist across 530 airports (full window 2015-01 → 2026-04,
quarantined rows included; `docs/data/invariants.md` § Route identity tabulates all four
window × quarantine answers). On JFK–LAX that workaround inflates
seats by 18,895 under a `DATA AS OF` badge. Full measurement:
[`docs/data/invariants.md` § Route identity](../data/invariants.md#route-identity).

Real support was added instead, to `app/src/lib/pivot/render.ts` and `pipeline/pivot.py` **in
the same commit** (`2c3939b`/`0e78317`/`08ee485`) — a change to one renderer without the
other is exactly the drift the goldens exist to catch. One filter value encodes one whole
route as `"<low-id>-<high-id>"` (`f=route:12478-12892`), and multiple values still OR
together exactly like every other dimension's IN-list — a positional two-values-make-one-pair
convention was rejected because it would make `f=route:a,b,c` ambiguous. The emitted SQL uses
`least`/`greatest` on the pair, never trusting stored column order:

```sql
(least(route_key_low, route_key_high) = $f0_0a AND greatest(route_key_low, route_key_high) = $f0_0b)
```

Both operands are bound, never interpolated — same discipline as every other filter value.
The existing 17 goldens stayed byte-identical; this only added cases (new golden entries
pin the emitted SQL identical between the two languages).

### URL resolution: two orderings that are not the same thing

```
/route/JFK-LAX  ->  parse two codes  ->  reverse-lookup to ids  ->  order by id  ->  canonical check
```

`app/src/lib/routePair.ts`'s `resolveRoutePair` computes two orderings of the same pair
explicitly, because they disagree for **154 of 22,420 routes (0.69%, excluding the 530
same-airport "routes" that are not routes)**:

- **`canonical` (the URL)** — alphabetical by code. Storage order is an implementation
  detail that should not leak into a URL, and alphabetical is predictable from the two codes
  alone without a database round trip.
- **`filterValue` (the query)** — by airport ID, matching `route_key_low`/`route_key_high`,
  fed straight into the composite filter above.

`HPN` (12197) / `BNH` (16954) is the measured example: id order is `HPN-BNH`, but the
alphabetical canonical is `BNH-HPN`. Conflating the two orderings would either query the
wrong route for that 0.7%, or mint a canonical URL nobody would type. `/route/LAX-JFK`
(non-canonical, both codes valid) 308s (`permanentRedirect` — this *is* the canonical URL for
the pair, not a temporary relocation) to `/route/JFK-LAX`; `/route/ZZZZ-LAX` (an unresolvable
code) 404s naming the offending code; two real airports with no service in the window is a
200 with an empty-state message and the widened-to-2015 offer, the same treatment `/explore`
gives a valid query matching zero rows.

That 404 names the offending **half**, not the pair — `resolveRoutePair`'s own `reason` string
is what the branded page renders, so `/route/ZZZZ-LAX` says `unknown airport code 'ZZZZ'` and
`/route/JFK-LHR` says `'LHR' is a recognized airport code, but this dataset is domestic-only
(T-100 Segment) and carries no rows for it` (that distinction is what `airportCodesExist()` /
`lookup_airport_code_exists.sql` exist for). Next's `not-found.js` accepts no props and
`notFound()` takes no argument, so the reason cannot be handed across from `page.tsx`; the
pathname arrives instead as a `proxy.ts` request header and `not-found.tsx` re-derives the
reason server-side. The 200 and the 308 are long-cached, both 404s are `no-store` — mechanism,
rationale and the served-build measurements in
[`hosting.md` § What `proxy.ts` owns](hosting.md#what-proxyts-owns).

### The reverse lookup surfaced an `is_latest` gap M4a's own invariant didn't cover

`app/src/lib/resolve.ts`'s `lookupAirportsByCode` (code → `airport_id`, the direction M4a
never needed) is served by `sql/03_queries/lookup_airport_by_code.sql`. `WHERE is_latest`
alone is **not** sufficient to make a code unique: it is scoped per `airport_id`'s own seq
chain, not per code, so two different `airport_id`s sharing a code can each carry their own
`is_latest = TRUE` row. Measured: 36 codes do (`AUS` returns both the real
Austin-Bergstrom and Robert Mueller Municipal, closed since 1999). Task 4's fix round 1
added a fact-presence clause, which takes colliding codes from 36 to 0 — full accounting,
including why M4a's own in-window invariant test didn't already catch this:
[`docs/data/invariants.md` § Code collisions](../data/invariants.md#entity-resolution-m4a).

That clause was a correlated `EXISTS` and is now a hash semi-join (43–51 ms → 8 ms), because
`proxy.ts` runs it on every `/route/*` request to decide cacheability. The equivalence is
pinned by `test_reverse_lookup_selects_exactly_the_fact_present_current_airports`, which
diffs the shipped file against the `EXISTS` form over every `is_latest` code — the timings,
the rejected variants and the mutation that fails it are in
[`invariants.md` § Entity resolution](../data/invariants.md) and
[`hosting.md` § What the proxy's query actually costs](hosting.md#what-the-proxys-query-actually-costs).

**M4d added the other two reverse lookups — and the aircraft one does not land where this one
did.** `lookup_carrier_by_code.sql` behaves identically to the airport file: the fact-presence
clause is what makes the slug a key (112 colliding `carrier_code`s unscoped, 0 among the 114
airlines that filed). `lookup_aircraft_by_name.sql` does not: fact-presence takes colliding
`short_name`s from 12 to **1**, not to 0, because `CE-180` names two BTS codes that *both*
really flew. So for aircraft the fail-loud guard is the entire defence rather than a
belt-and-braces backstop, and a colliding slug throws `AmbiguousCodeError` carrying every
candidate id — `/aircraft/CE-180` is a reachable URL whose page must name both airframes, not
pick one. Why no scoping fixes it, why narrowing to the trailing 12 months would be the worst
available "fix", the two surviving mutants recorded rather than papered over, and the 16
short names that are not URL path segments:
[`invariants.md` § The other two reverse lookups](../data/invariants.md#entity-resolution-m4a).

### Page composition and truncation

The stat strip's `LOAD FACTOR` and `AVG GAUGE` are computed in TypeScript from the summed
additive measures the same query already returns (`Σ passengers / Σ seats`, `Σ seats / Σ
departures_performed`) — CLAUDE.md's derived-measure rule applied to a page total, not just a
table cell. The carrier limit (50) is a measured guarantee, not a guess: the busiest route
carries 16 distinct operating carriers over a trailing 12 months, 99th percentile 8 — but the
page checks whether the result hit the limit and discloses truncation rather than silently
under-reporting a route's totals if a future refresh ever exceeds it.

Composite filtering is identical in both languages (goldens unmoved), the reverse lookup
resolves to 0 collisions among in-window airports, and `make app-smoke` curls a real served
page for the redirect and both 404 shapes.

## M4c — the aircraft-type-mix chart

Server-rendered stacked area of monthly seats by aircraft type on `/route/<pair>`, drawn by
Observable Plot into a jsdom document and injected as serialized SVG — in the served HTML,
visible with JS off. Encoding rules and the two traps that matter (membership vs shade as two
different orderings; gaps are unknown, not zero) are owned by
[`../design/system.md` § Charts](../design/system.md).

## M4d — `/airport`, `/carrier`, `/aircraft`

Three more entity pages on the composition M4b established. Each page's contract is owned by
[`../product/features.md`](../product/features.md); the routing and cacheability tier they
share — `proxy.ts`'s matcher, `ENTITY_ROUTES`, and the allow-list cacheability predicate — by
[`hosting.md`](hosting.md).

## M5 — connecting the graph

M3/M4 built four islands, each reachable only by typing a URL. M5 is the edges between them:
cross-links on every resolved dimension cell, the `/search` omnibox, `/sitemap.xml` and
`/robots.txt`. Entity resolution rules are owned by
[`../data/invariants.md`](../data/invariants.md); the cache split and the residual 5xx gap by
[`hosting.md`](hosting.md).

## M6 — Gauge Watch and the Top-N builder

A fifth surface, `/watch`, plus the `health_score` composite its presets rank on. The score's
four-axis definition, the `capacity_delta` identity that excludes it, and the NULL-guard rules
are owned by [`../data/model.md`](../data/model.md).

## M7 — maps, and the either-endpoint filter they needed first

Tasks 1-3 added a filter-only `endpoint_airport_id` dimension (`filter_mode = 'either'`,
compiling to an OR across both airport columns) and used it to collapse `/airport/<code>` from
three pivots plus inclusion-exclusion arithmetic down to **one pivot per grain**. Tasks 4-9
built the airport network map on a from-scratch, dependency-free, server-rendered SVG engine
(`app/src/lib/map/`) rather than the deck.gl + MapLibre the spec originally called for. The
projection, panel and arc encodings are owned by
[`../design/system.md` § The map](../design/system.md).

## Toolchain

**`mise.toml` pins every runtime — Python, Node and `uv` itself.** One file, one command
(`mise install`, which `make install` runs first), independent of whatever the system has.
`make check` (lint + test) is the pre-commit gate. Unimplemented `make` targets exit
non-zero rather than succeeding silently, so a half-built pipeline can't look finished.

**The pins are exact, not floating** — `python = "3.12.12"`, `node = "24.13.0"`,
`uv = "0.12.0"`. A floating `"3.12"` moves to 3.12.13 the day it ships and silently
invalidates the `make verify` proof below, which is only as good as the interpreter that
produced it. Bumping is a deliberate commit that re-runs `make verify`.

**`UV_PYTHON_PREFERENCE = "only-system"` is load-bearing.** mise owns the interpreter, so uv
must not quietly download a second 3.12 that nobody pinned. `only-system` makes uv use
what mise put on `PATH` and fail loudly when it is absent, rather than helpfully diverging.

**Every `make` target runs through `mise exec`** (`MISE ?= mise exec --`), so the documented
commands work in a shell that has never run `mise activate` — a fresh clone, a cron, an
editor's task runner. Set `MISE=` to bypass it where the tools are already on `PATH`, which
is what the Docker image will do.

> **One pinning mechanism, not two.** `mise.toml` replaced `.python-version` and made a
> `.nvmrc` unnecessary — two mechanisms for two runtimes is one too many. Changing the
> interpreter invalidates the reproducibility proof, so a runtime bump re-runs `make verify` in
> the same commit.

**`check` excludes `fmt`, and the tree is not format-clean.** It runs `ruff check` and
`pytest`, never `ruff format` — `ruff format --check .` reports 9 of 54 files would be
reformatted, so the first person to run `make fmt` gets a large diff across files their change
never touched. **The bad way out is reformatting only the files a change already touches** —
that smears the same diff across every future commit instead of isolating it in one. Either
reformat once in a commit that does nothing else and add `ruff format --check` to `check`, or
delete `fmt` and leave formatting unenforced.

**CI runs the gates; `make check` on a developer's machine is no longer the only one.**
`.github/workflows/ci.yml` resolves ONE warehouse release tag per run (`resolve`), restores it,
and runs `data-contract`, `check`, `app-check`, `smoke` and `goldens`. `make verify` is nightly
(`verify.yml`) because it needs the 232 MB raw+parquet pair and rebuilds twice.

**The warehouse is deliberately NOT pinned.** CI restores the latest `warehouse-*` release, so an
upstream BTS change reaches CI immediately instead of waiting for someone to bump a tag. Pinning
would make CI green by freezing reality — the same defect class as a gate that passes for the
wrong reason. What makes that survivable is that drift is caught at the **producer**:
`warehouse.yml` diffs each build against the previous release and classifies the delta, filing a
`critical` issue when the dataset's *shape* moves (a renamed aircraft type, a moved dim count) —
the 2026-08-07 failure mode, which reddened 17 assertions while moving no number.

**"Latest release" is `publishedAt`, never `createdAt`, and the tag shape is validated by the
consumer.** GitHub stamps a release's `created_at` from its **tag's commit**, not from the
release: `warehouse-2026.04` carries `created_at=2026-08-08T17:00:48Z`, which is `main` HEAD's
commit date to the second, against `published_at=2026-08-08T19:00:50Z`. This repo's steady state
is publishing off an unchanged `main`, so two releases a month apart carry **identical**
`createdAt`. `gh release list` returns newest-first and jq's `sort_by` is stable, so
`sort_by(.createdAt) | reverse | .[0]` reverses a tie into the **older** tag — measured: with
`warehouse-2026.05` and `warehouse-2026.06` tied, it returned `2026.05`. All three resolvers
(`ci.yml`'s `pick`, `verify.yml`'s `pick`, `warehouse.yml`'s `previous`) therefore sort ascending
on `publishedAt` with `tagName` as tiebreak and take `last`. They also match
`^warehouse-[0-9]{4}\.[0-9]{2}$` rather than `startswith("warehouse-")`: a prefix check
constrains the prefix and **nothing after it**, and on a list containing a tag literally named
`` warehouse-`id` `` the old form selected that tag. Git ref names permit backticks, `$`, `;`,
`&`, `|`, quotes and parens, so every tag that reaches a `run:` body also goes through `env:`
and is referenced as `"$PREVIOUS_TAG"` / `"$WAREHOUSE_TAG"` — Actions splices `${{ }}` into the
script *before* bash parses it, and the publisher job holds `contents: write`, `id-token: write`
and `issues: write`. The only values still spliced textually are `steps.stamp.outputs.*`, which
the `stamp` step proves are `[0-9]{4}[-.][0-9]{2}` before writing them. The three resolvers stay
deliberately divergent in one respect only — `ci.yml`/`verify.yml` exit 1 on an empty result,
`warehouse.yml` tolerates it, because a first-ever publisher run has no previous release.

**The publisher's `make ingest` force-refetches the last two years, and that is load-bearing.**
Restoring the previous release's `data/raw/` is a cache for the years BTS can no longer change,
**not** the mechanism that finds new data — `fetch.py`'s cache is keyed by `(table, year)` and a
new BTS month lands *inside* an already-downloaded year's zip. Traced with the network stubbed
against the real `data/raw/` listing: a plain `make fetch` makes **zero** requests for all 12
years and `make fetch-reference` **zero** for all 3 support tables, so the publisher would have
rebuilt an identical warehouse, stamped the same `warehouse-2026.04`, skipped the publish and
exited **0 — every day, forever, with nothing to notice it.** See
[../data/sources.md § Rules](../data/sources.md#rules) for the fetch contract and why *two*
years (BTS revises closed months) plus every support table (a rename is otherwise invisible).

**The real-data tests are no longer dark, and the accounting is exact.** The per-PR `check` job
restores the warehouse but not `data/raw/`, so **15 raw-dependent tests skip there by design** —
CI greps for the skip reasons that appear only when the *restore itself* broke
(`no built catalog`, `no built Parquet warehouse`) rather than failing on any skip. Those 15 run
nightly in `verify.yml`, which restores raw and runs `make check` alongside `make verify`. So
476 of 491 run per PR, all 491 run nightly, and **nothing runs only on one developer's machine.**

**Node is pinned at 24.13.0** — LTS since 2025-10, and Next.js 16 needs ≥ 20.9.

**`make app-check` (typecheck + `vitest run`) is the app's gate, the way `make check` is
`pipeline/`'s.** `app/` is Next.js 16 (App Router, TS, Tailwind v4, ESLint) with
`@duckdb/node-api` for the route handlers and Vitest for tests, scaffolded under the pinned
Node, with `NPM ?= $(MISE) npm --prefix app` following the same `mise exec` indirection as `UV`.

The Docker image installs the same pinned versions and sets `MISE=` so `make` calls the tools
directly rather than shelling through mise.

> 🔔 **The cron must fail loudly.** If the monthly ingest breaks, nothing errors — the site
> keeps serving happily and `DATA AS OF` just quietly stops advancing. For a product whose
> entire credibility is that badge, silently serving stale data while claiming freshness is
> the worst failure mode available. Alert when `max(year_month)` hasn't moved in ~45 days,
> and surface staleness in the UI, not only in a log.
