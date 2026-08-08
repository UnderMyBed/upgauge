# Pipeline & repo layout

## Repo scaffold

```
upgauge/
├── docs/                       see docs/README.md
├── Makefile                    make ingest / make build / make dev
├── Dockerfile
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
│       └── explore/            the Explorer. route/airport/carrier/aircraft/watch are M4/M5
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

| | |
|---|---|
| **M1** | Ingest: `DL_SelectFields` POST loop → raw → Parquet, 2015→present. **Invariant tests passing.** |
| ~~**M2**~~ | ~~Marts built by SQL, fully reproducible from scratch via `make`.~~ ✅ See [the M2 section](#m2--the-marts-layer). |
| **M3** | Explorer: pivot query + URL state + table. The foundation — get it right. |
| **M4** | Entity pages: route, airport, carrier, aircraft. Charts. Design system applied. |
| **M5** | Maps (airport + carrier + aircraft), then `/watch` presets. |
| **M6** | Deploy + Cloudflare cache + edge rate limit + monthly cron + **freshness alert**. |

### M1 phase order

Phase 0 is complete — see [../data/sources.md](../data/sources.md) for what it established.

| Phase | Work | Done when |
|---|---|---|
| ~~0~~ | ~~Spike the endpoint~~ | ✅ Endpoint driven, data validated, spec corrected |
| ~~1~~ | ~~Scaffold + toolchain~~ | ✅ `make check` green — uv/3.12, pytest, ruff, `btscodec` |
| ~~2~~ | ~~`fetch.py` — per-year POST loop, viewstate, cache, retries~~ | ✅ `make fetch`; verified live against BTS (see below) |
| ~~3~~ | ~~Invariant tests, written red~~ | ✅ 156 tests; rules in `invariants.py` + `mainline_map.py`, validated against a real extract |
| ~~4~~ | ~~`normalize.py` — raw → Parquet, quarantine flags, `download_date`~~ | ✅ `make ingest`; 2015 → 282,036 rows, 8.6 MB Parquet |
| ~~5~~ | ~~Lookups → dims; `map_mainline_group` materialized~~ | ✅ 5 dims build; **zero orphans** joining 282,036 fact rows |
| ~~6~~ | ~~Reproducibility gate~~ | ✅ `make verify` — 7 artifacts byte-identical across two builds (the count **at M1**; M2 added `dim_city_market`, so it printed 8 by M2, and **17** today on the full 2015–2026 window — see [the M2 gate](#the-m2-gate) below) |

**Order rationale:** the spike came first because the acquisition path was the one part of
the spec proven *not* as documented. Tests come after the fetcher but before normalize,
because several invariants had to be resolved empirically — writing them from assumption is
how you get a green suite that's confidently wrong.

`btscodec` landed in phase 1 rather than 2 because it was already proven by the spike, and
leaving it in a scratch directory risked losing reverse-engineering work that took real
effort to recover. It also gives phase 1 something genuine to verify against.

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

Scope is `fct_route_month`, `dim_city_market`, and `mart_route_health`.
~~`mart_leaderboards` is deferred to M5~~ **Superseded by M6.** There is no separate
`mart_leaderboards` table: `/watch`'s four presets (`sql/03_queries/watch_*.sql`) read
`mart_route_health` directly, add no pivot SQL of their own (no pivot measure expresses a
delta), and share nothing across them except `DataTable`'s rank column — the same correction
`docs/product/features.md` and `docs/design/system.md` already carried; this was the third,
missed copy of the same stale claim (M6 Task 8's doc sweep). See § M6 below.

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
CWD, the way the M6 container would if `WORKDIR` were wrong — and querying `fct_segment_month`
raises `duckdb.IOException`: `IO Error: No files found that match the pattern
"data/parquet/t100_segment/**/*.parquet"`. The database opens fine; only the read fails. That
is the exact failure shape to expect if M6's Dockerfile ever ships without `WORKDIR /app`.

### The M2 gate

✅ **Built.** `make verify` runs three checks in sequence and fails if any fails:

1. **Parquet reproducibility** (M1, unchanged): `build_all` twice into throwaway temp
   dirs from identical raw inputs, sha256 every artifact. **17 artifacts on the full
   2015–2026 window** — 12 fact-year partitions + 5 dims. (8 artifacts — 3 fact-year
   partitions + 5 dims — was the count on the 2015–2017 window measured at M2; M3a Task 1
   rebuilt on every year `make fetch` had landed and re-ran the gate. The dims count is
   fixed; only the fact-year partition count grows with the window.)
2. **Parquet freshness** (M2 fix wave 1, new): the two throwaway builds above only prove
   they agree *with each other* — neither is `--out-dir`, the Parquet that `make build`
   and the database gate below actually read. So `_digest_tree` on one of the throwaway
   builds is compared against `_digest_tree(--out-dir)`, and any difference is named. This
   is what catches `make fetch` adding a year that `make warehouse` never picked up: the
   database gate's object *count* doesn't change when a fact-year partition goes stale,
   because it counts objects, not files, so without this check that staleness is
   invisible to `make verify` and only shows up later as `DATA AS OF` silently failing to
   advance.
3. **Database** (M2): `pipeline.marts.verify_database` builds `upgauge.duckdb` twice
   from the same Parquet and, for every catalog object, exports it through a
   `COPY (SELECT * FROM <object>) TO ... (FORMAT PARQUET)` on a connection with
   `SET threads TO 1` — the same writer setting M1 already proved byte-stable — then
   sha256s that export. **10 objects today** (8 at M2, before M3a Task 2 added the pivot
   catalog): the 6 views over Parquet (`fct_segment_month`, `dim_airport`,
   `dim_city_market`, `dim_carrier`, `dim_aircraft_type`, `map_mainline_group`), the two
   derived views/tables (`fct_route_month`, `mart_route_health`), and the two Explorer
   allowlist views M3a Task 2 added (`meta_pivot_dimensions`, `meta_pivot_measures`).

Both counts are measured, not asserted from the file layout — if `sql/02_marts/` ever grows
or shrinks, the counts printed by `make verify` are what to trust over this paragraph.

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

Real run, 2015–2017 warehouse (M2):

```
$ make warehouse && make verify
parquet: 8 artifacts byte-identical across two builds
parquet: comparing data/parquet (on disk) against a fresh build from data/raw
parquet: data/parquet matches a fresh build from data/raw (8 artifacts)
database: 8 objects identical across two builds
```

**Re-run in M3a Task 1, full 2015–2026 warehouse**, after `make fetch` landed all 12 years —
at that point in the branch, before Task 2 added the pivot catalog, this genuinely printed 8
objects. **Re-verified again for this fix wave** (real, verbatim output — the previous
revision of this doc had drifted to a stale, no-longer-true transcript rather than a run
someone actually re-checked):

```
$ make warehouse && make verify
parquet: 17 artifacts byte-identical across two builds
parquet: comparing data/parquet (on disk) against a fresh build from data/raw
parquet: data/parquet matches a fresh build from data/raw (17 artifacts)
database: 10 objects identical across two builds
```

Artifact count moved 8 → 17 (more fact-year partitions, one per calendar year fetched) and
held there since — it depends on `data/raw/`'s window, not on `sql/02_marts/`. Object count
moved 8 → 10 later in the branch, when Task 2 added `meta_pivot_dimensions` and
`meta_pivot_measures` to `sql/02_marts/` — it depends on `sql/02_marts/`, not on how much
data each object's Parquet source spans, so it did not move again when the artifact count
grew from 8 to 17.

**M2 complete.** `make build` produces `upgauge.duckdb` from `sql/02_marts/`, and
`make verify` proves both the Parquet artifacts and every database object byte-identical
across two from-scratch builds.

## M3 — the Explorer, split into M3a and M3b

M3 is split, because its two halves have different blockers.

| | Scope | Blocked on |
|---|---|---|
| ~~**M3a**~~ | ~~The pivot query contract: templates, the allowlist, the URL codec, golden fixtures~~ ✅ Complete — see [Task 7 below](#task-7--golden-fixtures-and-make-goldens-m3a-complete). |
| ~~**design session**~~ | ~~[../design/brief.md](../design/brief.md) — tokens, the data table, the chart, the signature element~~ ✅ Complete — the answer is [../design/system.md](../design/system.md), mockups in [../design/mockups/](../design/mockups/). |
| ~~**M3b**~~ | ~~The Next.js app: route handlers, the table, URL wiring~~ ✅ Complete — see [Task 10 below](#task-10--explore-wired-to-the-url-m3b-complete). |

**Why the split.** `docs/design/brief.md` makes the data table deliverable #1 and says "most of
the product is this table in different clothes. Get it right and everything else follows." M3
builds that table, so the visual system gets decided at M3 whether or not it is planned for.
Building it against invented styling and retrofitting real tokens later is the expensive kind
of rework, and the brief's constraints — mono tabular numerals, density over whitespace, the
`DATA AS OF` badge — are structural, not cosmetic.

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

Across M2's eight tasks, **the single most common review finding was a test that passed for a
reason other than the one it named.** Concretely, and all recorded in the M2 commit messages:

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

Every one was found by mutating production code and watching what stayed green. None was
visible from reading the diff.

So in M3a this is a required step, not an aspiration: for each guard, make the change it exists
to catch, observe the failure, revert, and record the output. A guard never observed failing is
not a guard.

### Task 3 — the templates and `pipeline/pivot.py`, built

✅ **Built.** `sql/03_queries/pivot_segment.sql` and `pivot_route.sql` are the two templates;
`pipeline/pivot.py`'s `render_pivot(q, con)` validates a `PivotQuery` against Task 2's two
catalog allowlists and renders one of them. Task 3 shipped with 11 tests in
`pipeline/tests/test_pivot.py`; Tasks 5–6 added 10 more (mainline-grouping regressions and
sort-under-grouping), and the whole-branch fix wave added 3 more still (filter-key
validation coverage and a `sort_desc` normalization unit test) — **24 tests in the file
today.** See "Step 6 — the injection guards, observed failing" below for which tests have a
demonstrated RED and by which round.

**One validation function, reused for both the dimension list and every filter key.**
`_validate_dimension` is the only place a dimension-shaped identifier is checked — called once
per requested dimension and once per filter key — so a filter cannot become a side door around
the allowlist that the main dimension list already enforces. It checks both that the key
exists and that its catalog `grain` (`'both'` / `'segment'` / `'route'`) admits the query's
requested grain; `'segment'`-only dimensions (`aircraft_type`, `aircraft_group`,
`origin_state`, `dest_state`, `distance_group`) are rejected at `grain="route"` before any SQL
is built, not left to fail at execution against a `fct_route_month` that doesn't carry them.

**No dimension is assumed to be one column.** `column_expr` is substituted verbatim and
comma-joined across requested dimensions, so the `route` dimension's pair
(`route_key_low, route_key_high`) needs no special-cased code — it is already the same shape
`render_pivot` handles for every other dimension. The same property makes a multi-column
dimension deliberately **unsortable and unfilterable directly**: `render_pivot` raises
`PivotError` rather than guess which of the two columns a bare `route`-keyed sort or filter
should mean.

**Sortable identifiers are restricted to what's actually in the SELECT list** — the requested
dimensions (single-column ones only) and measures, by their output alias — not the full
allowlist. `ORDER BY` on a column the query didn't select is a DuckDB `BinderException`
waiting to happen; restricting the sortable set to the selected columns turns that into a
validation-time `PivotError` instead. With no `sort` given, `render_pivot` defaults to the
first requested measure, descending — matching how every Top-N view in the product is read.

**Derived measures are substituted from the catalog's `expr`, never rebuilt.**
`measure_select` is built as `f"{entry['expr']} AS {key}"` straight from
`meta_pivot_measures` — `render_pivot` contains no measure-specific branch, so there is no
second place the no-averaging rule could drift from the catalog. Verified by Mutation 7 below.

**Quarantined rows differ by template, not by convention.** `pivot_segment.sql` computes
`count(*) FILTER (WHERE is_quarantined)` and `string_agg(...) FILTER (WHERE is_quarantined)`
directly off `fct_segment_month`'s row-level flag and reason. `pivot_route.sql` instead `sum`s
`fct_route_month.quarantined_rows` — a count `fct_route_month` already carries from its own
rollup of `fct_segment_month` — and has **no `quarantine_reasons` column at all**, because the
reason string does not survive that rollup. Documented in `pivot_route.sql`'s header so a
consumer does not expect the column at both grains.

#### Step 6 — the injection guards, observed failing

Two are mandated by the plan: dimension validation and sort validation removed, one at a time,
confirming the guard actually guards something. Both — plus eight more mutations covering
every other test in the file — were run and reverted; full detail (each mutation's diff, the
exact `pytest` RED output, and the revert confirmation) is in the Task 3 SDD report rather than
duplicated here. **The 11 tests in the mutation table below have a demonstrated RED, not
merely a passing test that has never been watched fail; the 10 added by Tasks 5–6 (the
mainline-grouping regressions and sort-under-grouping) are covered by those tasks' own
mutation records, not repeated here.**

| Mutation | Test(s) driven RED |
|---|---|
| 1. Dimension validation bypassed entirely | `test_unknown_dimension_is_rejected`, `test_sql_injection_via_dimension_is_rejected`, `test_segment_only_dimension_rejected_at_route_grain` |
| 2. Grain check alone removed (existence check kept) | `test_segment_only_dimension_rejected_at_route_grain` (isolated) |
| 3. Sort validation removed | `test_sql_injection_via_sort_is_rejected` |
| 4. Measure validation removed | `test_unknown_measure_is_rejected` |
| 5. Time range interpolated instead of bound | `test_values_are_bound_never_interpolated` |
| 6. Filter values interpolated instead of bound | `test_filters_bind_their_values` |
| 7. `load_factor` rebuilt as `AVG(load_factor)` in Python | `test_derived_measure_is_computed_not_averaged` |
| 8. `q.limit` ignored, a fixed large limit bound instead | `test_limit_is_bound_and_enforced` |
| 9. `quarantined_rows` dropped from `pivot_segment.sql` | `test_quarantined_rows_are_excluded_and_reported` |
| 10. `{{GROUP_BY}}` left unsubstituted | `test_renders_and_executes` (plus two others that also execute the rendered SQL) |

Every mutation was reverted immediately after its RED was observed; `git status --porcelain`
and a full `pipeline/tests/test_pivot.py` GREEN re-run confirm no mutation survived into the
commit.

**Whole-branch review fix wave, one more mutation observed failing.** The review found the
filter-key slot in `render_pivot`'s filter loop had NO test coverage at all — `_validate_dimension`
was called there but nothing exercised it, so replacing that call with a pass-through
(`entry = {"column_expr": key, "grain": q.grain}`) left **all 409 tests green** and made
`decode("...&f=1%3D1)%20OR%20(1:x...")` render a working WHERE-clause injection
(`AND (1=1) OR (1 IN ($f0_0))`). Fixed by adding `test_unknown_filter_key_is_rejected` and
`test_sql_injection_via_filter_key_is_rejected` to `test_pivot.py`, and a `decode`-level case
in `test_urlstate.py`; the same pass-through mutation drove all three RED, then was reverted.
Also added in this wave: `test_every_sum_is_quarantine_filtered` in
`test_pivot_allowlist.py`, a structural check (every `SUM(` in every `meta_pivot_measures`
`expr` must be immediately `FILTER (WHERE NOT is_quarantined)`) that closes the same class of
gap for the measure catalog — 8 of 12 measures had their FILTER strippable with zero tests
noticing, mutation-confirmed on `departures_scheduled`.

### Task 7 — golden fixtures and `make goldens`, M3a complete

✅ **Built.** `sql/03_queries/goldens/pivot.json` and `urlstate.json` are the handoff
artifact this whole milestone exists to produce: **M3b's TypeScript is verified against
these exact bytes, not re-derived from this module's semantics.** One validator's behavior,
pinned once, checked twice — a Python reference implementation and a TypeScript port proven
to agree, rather than two implementations that could quietly drift apart.

**Data, not SQL, despite the `sql/` path.** Both files live under `sql/03_queries/goldens/`
for proximity to the templates they pin, and both say so explicitly in their own
`_data_not_sql` header field — a stray `.json` under `sql/` would otherwise read as a mistake.
Consumed only by `pipeline/tests/test_pivot_goldens.py`; nothing executes them as SQL.

**9 pivot cases, 7 URL cases** (8 and 6 at Task 7; the whole-branch fix wave added one of
each — see below), generated by `pipeline.pivot.write_goldens()` (`make
goldens` → `python -m pipeline.pivot --write-goldens`) against the same small, deterministic
warehouse `pipeline/tests/test_pivot.py` and `test_urlstate.py` already build from committed
fixtures — reused rather than re-defined, since a golden's rendered SQL/params depend only on
the catalog views and the static template files, never on fact row content. The pivot cases
cover a single-dimension segment pivot, a multi-dimension pivot, a route-grain pivot (the
multi-column `route` dimension), a derived-measure pivot (`load_factor`), a filtered pivot,
a mainline-grouped pivot, a mainline-grouped pivot WITH a carrier filter (pins the
undocumented-until-the-fix-wave gap that the filter doesn't coalesce the way the dimension
does — see `sql/03_queries/pivot_mainline_join.sql`'s header), an ascending-sort pivot, and
the Task 5 regression — sorting by the carrier dimension under mainline grouping. The URL
cases cover a multi-dimension round trip, `grain="route"`, `grouping="mainline"`, an
ascending sort, `sort=None` with `sort_desc=False` (pins that `PivotQuery.__post_init__`
normalizes this to `sort_desc=True` — the fix wave's Important 3), ordinary multi-value
filters, and a filter value containing every character the URL format itself uses
structurally (`,` `&` `%` `:` `=` `+` and a space).

**Every case generated is read by eye before being trusted**, not just asserted equal to
itself: for each pivot case, confirmed no filter/time-range literal leaks into the SQL text
(only into `params`), the derived-measure case has no `AVG(`, the route-grain case uses
`fct_route_month`'s `SUM(quarantined_rows)` rather than the segment template's `count(*)
FILTER`, and the mainline-sort case's `GROUP BY` carries the raw `coalesce(m.parent_airline_id,
f.op_airline_id)` while `ORDER BY op_airline_id` references the SELECT-list alias — the exact
shape Task 5 had to fix. For each URL case, confirmed the reserved-character filter value
round-trips through individually percent-encoded tokens (`,`→`%2C`, `&`→`%26`, `%`→`%25`,
`:`→`%3A`, `=`→`%3D`, `+`→`%2B`, space→`%20`) rather than corrupting the structural
delimiters.

**A real bug caught by running the actual `make` target, not a `-c` shortcut.** The first
`make goldens` run failed: `write_goldens()` builds `_PIVOT_GOLDEN_CASES`/
`_URLSTATE_GOLDEN_CASES` as `PivotQuery` instances, then round-trips the URL cases through
`pipeline.urlstate.encode`/`decode` before writing anything — and `decode(...) == query`
came back `False` despite identical field values. Cause: `python -m pipeline.pivot` runs the
file as `__main__`, a module object distinct from `pipeline.pivot`. Once `write_goldens`
imports `pipeline.urlstate` (which does its own top-level `from pipeline.pivot import ...
PivotQuery`), Python has never seen `'pipeline.pivot'` under that dotted name and imports the
file a *second* time — so `urlstate.decode()`'s `PivotQuery(...)` construction returns an
instance of a different class than the one `write_goldens` built its case list from. A frozen
dataclass's generated `__eq__` checks `type(self) is type(other)`, so two field-identical
`PivotQuery`s from the two module copies never compare equal. Invisible from `python -c
"from pipeline.pivot import write_goldens; write_goldens()"` (a normal import, one module
instance) — only the literal `make goldens` invocation reproduced it. Fixed by having the
`__main__` guard explicitly `import pipeline.pivot as _canonical` before calling `_canonical
.main()`, which registers the canonical module in `sys.modules` first so `urlstate`'s later
import resolves to the same module instance `main()` is already running from.

**Step 4, the proof the goldens pin something.** `sql/02_marts/301_meta_pivot_measures.sql`'s
`load_factor` expr was mutated from
`SUM(passengers) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(seats) FILTER (WHERE
NOT is_quarantined), 0)` to `AVG(passengers::DOUBLE / NULLIF(seats, 0))`, `make build` was
re-run, and `pipeline/tests/test_pivot_goldens.py` was re-run **without** `make goldens`:

```
FAILED pipeline/tests/test_pivot_goldens.py::test_pivot_case_renders_to_the_pinned_sql_and_params[derived_measure_load_factor]
AssertionError: derived_measure_load_factor: rendered SQL no longer matches the pinned golden
-     SUM(passengers) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(seats) FILTER (WHERE NOT is_quarantined), 0) AS load_factor,
+     AVG(passengers::DOUBLE / NULLIF(seats, 0)) AS load_factor,
1 failed, 31 passed in 0.33s
```

Named the exact case, showed the exact diff, and every other case stayed green — the golden
suite doesn't fail wholesale on an unrelated change. Reverted; `git diff` on the mart file is
empty and the full suite is back to 32 passed.

**`make goldens` overwrites unconditionally — the soft spot in this contract.** The target
regenerates both files from whatever `pipeline/pivot.py` does at that moment. It never diffs
first and never refuses. So the failure mode is a developer who breaks the validator, sees
`test_pivot_goldens.py` go red, reaches for `make goldens` to "fix" it, and bakes the
regression into the pinned bytes — after which M3b's TypeScript is verified against the bug,
and the golden suite reports green while doing it. Everything standing between that and a
shipped wrong contract is prose: this paragraph, the Makefile help text, and each file's
`_data_not_sql` header ("read the diff by eye before committing: a golden file is only as
good as its first generation"). The structural fix is a CI job that runs `make goldens` and
fails on any resulting `git diff`, which forces regeneration to be a reviewed commit rather
than an error-recovery reflex — deferred with CI itself, see [Toolchain](#toolchain).

**M3a complete.** The pivot query contract — templates (Task 3), the allowlist as catalog
objects (Task 2), derived measures re-verified against real data (Task 4), the mainline-group
toggle on both real acquisition boundaries (Task 5), the URL state codec (Task 6), and now
the golden fixtures that let M3b's TypeScript be *verified* against this contract instead of
re-implementing its validation semantics from scratch (Task 7) — is done. Next up: the design
session (`docs/design/brief.md`), then M3b.

### Task 10 — `/explore` wired to the URL, M3b complete

✅ **Built.** `app/src/app/explore/page.tsx` is the task that makes the milestone
demonstrable: a permalink like
`/explore?v=1&k=seg&d=op_airline_id&m=seats,load_factor,avg_gauge&t=2025-05:2026-04&s=-seats&n=25&g=op`
now server-renders a real table against `upgauge.duckdb` — the `UPGAUGE` wordmark, a
`DATA AS OF` badge in `--signal`, a stat/meta strip (grain, grouping, window, row count,
quarantined-on-page count), the Task 9 `DataTable` (reused, not rebuilt), the legend rail
(added in fix round 1, below), and the permalink re-encoded and displayed underneath the
table.

**The error path is the product feature, not a fallback.** Only `decode()` is wrapped in a
try/catch — it is the one step that validates untrusted request input against the allowlist,
and its documented failure mode is `UrlStateError`. An unknown key, an off-allowlist
dimension, a malformed time range: all render a full-page named error (e.g. `unknown
dimension 'nope'`) with no table and no default query underneath it, per
[`docs/design/system.md`](../design/system.md)'s "Invalid permalink" state — never a silent
fallback, because a permalink that quietly renders a different query than it encodes would
still screenshot as authoritative.

**`serverExternalPackages` was the one real build-blocker, and it was invisible until the
production build.** `make app-check` (typecheck + Vitest, both against the real DuckDB file)
was green the whole time `db.ts` existed (Task 8), but `next build` failed the first time
anything ran it — `@duckdb/node-bindings` resolves its native binding with a runtime
`require(`@duckdb/node-bindings-${platform}-${arch}`)` switch, one branch per platform/arch,
and only one platform's optional-dependency package is ever actually installed. Left to
Next's default Server Components bundling, the bundler statically resolves *every* branch of
that switch and fails the build on whichever platform packages aren't present on the machine
doing the build. Fixed in `app/next.config.ts` with
`serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"]`, which routes both
packages through plain Node `require` at request time instead of bundling them — exactly the
documented purpose of that option ("dependencies using Node.js specific features"). Nothing
in `make app-check` would ever have caught this: Vitest never runs `next build`'s bundler, so
the gap is real and worth naming for whoever adds the CI job this doc's Toolchain section
already flags as missing.

**Verified against a running production server, not just the test suite.** `make app-build`
succeeded, then `mise exec -- npx next start app` was started from the repo root (the
`file_search_path`/cwd contract `db.ts` and `render.ts` document) and hit with `curl`: the
permalink above returned HTTP 200 with real carrier rows (`op_airline_id` values, summed
`seats`/`load_factor`/`avg_gauge`, the gauge rail, the below-floor gutter) and the `DATA AS
OF` badge; `d=nope` in place of a real dimension also returned HTTP 200 — not a 500 — with
the named error and zero `<table>`/`<tr>` elements in the response body.

**Fix round 1** (review of the initial Task 10 commit) found three gaps between the shipped
page and `docs/design/system.md`'s States table, plus one instance of the vocabulary
duplication this whole milestone exists to avoid:

- **Empty-result state was unhandled.** A valid query matching zero rows (a real filter
  value, e.g. `f=op_airline_id:999999999`, on a real dimension) rendered `DataTable` with a
  header and an empty `<tbody>` — no message, no offer of a broader window, and the design
  doc requires both ("Keep the header, stat strip and legend rail. State the query in words
  and offer the nearest broader window. Never a blank panel."). Fixed: `EmptyState` in
  `page.tsx` states the query in words via `describeQuery()` (grain, every dimension label,
  the window, every filter with its dimension's catalog label) and links to the same query
  widened to `2015-01` — the start of the window `data/raw/` holds — via `widerWindowHref()`,
  which returns `null` (no link) when the query already starts there.
- **The legend rail — signature element 3 of 3 — was entirely missing.** `system.md` calls
  it "the methodology surface... folded into the product\[,] present on every data view," so
  there is no separate how-to-read page to go stale; `/explore` rendered the gauge rail and
  reason-code gutter with nothing on screen explaining either. Fixed:
  `app/src/components/LegendRail.tsx`, ported from
  [`../design/mockups/table.html`](../design/mockups/table.html)'s `<aside class="legend">`
  — the gauge-rail groups (fixed 0–260 axis, `<110` regional, `>210` widebody), the row
  marks (`⌀`/`n`/`Q`, plus the dotted-underline "computed measure" convention), and the
  operating-carrier "reading this" note — minus the mockup's "Arc rendering (maps)" group,
  since this page has no map. Placed in a new `.body` grid (`minmax(0,1fr) 214px`, 24px gap,
  sticky, collapsing below 920px per `system.md`'s layout rule) alongside the table.
- **Dimension values rendered raw IDs, and the docs didn't say so at first.** Fixed in this
  round by adding an explicit gap note recording that `db.ts`/`render.ts` never read
  `meta_pivot_dimensions`' `join_dim`/`join_key` columns. The gap itself was closed in M4a
  (`app/src/lib/resolve.ts` resolves ids to codes for `/explore`); the note that recorded it
  has been deleted rather than amended, per this project's rule that a closed gap gets
  removed, not left with a caveat — see `CLAUDE.md`'s Status section for what M4a shipped.
- **`DERIVED`, a hand-copied `Set` of measure keys mirroring `is_additive: FALSE` in
  `meta_pivot_measures`, was deleted.** `allowlist.meas.get(c)?.isAdditive` already carries
  the same fact and was already loaded on the page; a derived measure added to the catalog
  now picks up its dotted "computed" underline automatically instead of silently missing it
  until a second hand-copied list is remembered.

Re-verified end to end against a running `next start` server after the fix: the demo
permalink's HTML now contains `Chart legend` and the row-mark glyph text; the invalid
permalink still renders the named error with zero table/row elements; a genuinely empty
query (the `op_airline_id:999999999` filter above) renders the "No rows match..." message
and the widened-window link, with the stat strip, `DATA AS OF` badge and legend rail all
still present.

**M3b complete.** The route handler (Task 8), the data table with its gauge rail and
reason-code gutter (Task 9), and `/explore` itself including the legend rail and
empty-result state (Task 10 and its fix round 1) close out the app side of the pivot
contract M3a shipped. 109 app tests green (`make app-check`), 424 Python tests green
(`make check`), `make app-build` produces a working production build. Not built in M3b:
display-code resolution for dimension values (closed in M4a — see `CLAUDE.md`'s Status
section), the time-series and fleet-mix charts, the arc map, entity pages, `/watch`, the
seasonality heatmap, and OG cards — all specified in
[`../design/system.md`](../design/system.md) and left to M4b/M4c+ onward.

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

M4a is built: 424 Python tests green (`make check`), the app suite green
(`make app-check`), `make app-build` produces a working production build, and
`make goldens` reproduces all 17 goldens byte-identical — proof the M3a contract never
moved. See `CLAUDE.md`'s Status section for the current test counts and what M4d+ still owe
(`/airport`, `/carrier`, `/aircraft`, the remaining charts — load-factor lines and the
seasonality heatmap — the maps, `/watch`) — `/route` is the M4b section immediately below,
and its aircraft-type-mix chart shipped in M4c.

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

M4b is built: composite filtering identical in both languages (goldens unmoved), the reverse
lookup fixed to 0 collisions among in-window airports, `/route/<pair>` rendering the title
block, stat strip, carriers table, Explorer link and legend rail, and `make app-smoke`
curling a real served page for the redirect and 404 status codes — see `CLAUDE.md`'s Status
section for current test counts.

## M4c — the aircraft-type-mix chart

Design spec: `docs/superpowers/specs/2026-07-31-m4c-aircraft-mix-chart-design.md`. Encoding
rules: `docs/design/system.md` § Charts. This section records what the *implementation*
needed that neither of those owns.

### The chart adds no SQL and no catalog entries

`app/src/lib/chart/aircraftMix.ts` composes the existing segment-grain pivot:
`dimensions: ["year_month", "aircraft_type"]`, `measures: ["seats", "departures_performed"]`,
`grouping: "operating"`, filtered by the composite `route` dimension M4b added. The type is
resolved to `dim_aircraft_type.short_name` through the map `runPivot` already returns — the
same M4a resolution path `/route`'s carriers table uses, via `displayValue()` rather than a
second local copy of the three-way display contract.

`departures_performed` is fetched even though nothing is *drawn* from it: band shade is
ordered by gauge (Σ seats / Σ departures), which is a different ordering from band membership.
See the next section.

**The row limit (10,000) is a measured bound, not a guess.** Measured over the full
2015-01 → 2026-04 window: the worst-case route produces **1,908 (month, type) groups**, and
the most aircraft types any one route carries is **36** across 136 months — a 4,896-row
structural ceiling. JFK–LAX, the flagship example, returns **996 rows / 20 types / 136
months**. 10,000 clears the measured worst case 5× and the ceiling 2×.

Truncation here would not look like a bug. A stacked area silently missing its tail months
looks like an airline stopped flying the route, rendered under a `DATA AS OF` badge — the same
failure shape as M4b's carrier-limit disclosure, but with no row count on screen to give it
away. `aircraftMix.test.ts` therefore pins the returned row count *exactly* (996) and asserts
it stays strictly below the limit, rather than trusting the arithmetic above.

### Two orderings, and testing them is harder than implementing them

`toBands()` sorts the same five types twice, on two different keys:

| | key | direction | produces |
|---|---|---|---|
| **membership** | total seats | descending | which 5 types get a band; the rest → Other |
| **shade** | gauge (Σ seats / Σ departures) | ascending | which of `--g1`…`--g5` each band gets |

Measured on JFK–LAX, where they genuinely disagree — the two sorts share only their first
element:

| by seats (membership) | | by gauge (shade) | |
|---|---|---|---|
| 1. A321nXLR | 17,485,274 | `--g1` A321nXLR | 128.1 |
| 2. B767-3/R | 7,852,109 | `--g2` A320-1/2 | 148.4 |
| 3. B767-4 | 3,119,079 | `--g3` B757-2 | 164.2 |
| 4. B757-2 | 2,900,388 | `--g4` B767-3/R | 216.6 |
| 5. A320-1/2 | 2,132,256 | `--g5` B767-4 | 239.2 |

Bands are returned in **shade order**, `--g1` first, so the array is directly usable as the
stack order: light at the bottom, dark on top. That gradient is the entire reason the
categories are ordered rather than merely distinguishable.

**A two-element fixture cannot test this rule, and that is not obvious.** The task brief's own
headline test used one — a "Small" type with the most seats and the smallest gauge, on the
reasoning that "the largest by seats is the smallest by gauge, so the orderings are reversed."
They are not: seats-descending and gauge-ascending both put that type first, so the two orders
*coincide* and an implementation that sorts once and reuses the order passes. Confirmed by
mutation, not by reading. Reversing two elements requires the type with the **most seats** to
also have the **largest gauge**; the shipped fixture does that, and the mutation now goes red.

Two derived decisions, both with their own test:

- **An unknown gauge sorts last, not lightest.** A type with 0 performed departures has no
  gauge — real, not hypothetical: type `650` (DC-9-50) appears on JFK–LAX with 0 seats and 0
  departures, so `seats / departures` is `0/0`. `gauge()` returns `null` and nulls sort last,
  matching DuckDB's own `NULLS LAST` default for `ORDER BY ASC`. The plausible alternative —
  `departures === 0 ? 0 : …` — makes an aircraft that flew nothing the *lightest* band on the
  chart, a claim about metal size drawn from no evidence.
- **Ties break on `code`,** arbitrary but deterministic. The property that matters is that the
  same data always produces the same chart.

`OtherSummary.seatShare` is a share of the route's **total** seats, not of the remainder, and
its series is **empty** rather than zero-filled when `typeCount === 0` — so the renderer's
`typeCount > 0` gate never draws an invisible band.

### Two absences that look alike and are not

Every band carries a point for every month **the subject filed**, zero-filled where that
particular type did not fly — a stacked area needs every series sampled at the same x or the
bands misalign. It carries **no point at all** for a month the subject did not file. The two
cases are one word apart in English and opposite in meaning, and M4c shipped handling only the
first: `toBands` zero-filled across the months present *somewhere* in its input, and the
renderer built its x domain from the same set, so a month absent from **every** type was not on
the axis and Plot drew a straight edge across it. The encoding rule and the measured damage:
[`../design/system.md` § Charts](../design/system.md), third standing rule.

`toBands` now also returns a `MonthAxis`:

| field | is |
|---|---|
| `span` | every month from the first filing to the last, contiguous, filed or not |
| `gaps` | the months in `span` nobody filed |
| `run` | month → id of the contiguous run of filed months it belongs to |
| `solo` | the run ids covering exactly one month |

The renderer keys Plot's `z` (series identity) on the **run** and `fill` on the **band**, so
one `areaY` mark emits one path per (band, run) and a broken band keeps one shade across all
its pieces. That forced one other change: `order` had to become the rank **function**
(`(d) => d.rank`) rather than the array of z values it was, since z is no longer the band.
Stack order is unchanged — rank is the band's index in shade order.

Runs of exactly **one** month go into a second mark with `stroke` set. A one-month area has no
width: d3 emits `M x,y1 L x,y2 Z`, which fills to nothing. **9,486 of 22,919 route pairs (41%)
have at least one isolated interior month**, so dropping them would have traded the
interpolation bug for an erasure bug on nearly half of all pages. Stroked, an isolated filing
is a hairline column in its own shade at its own height in the stack.

**Verified on the served build, not only in jsdom.** `/route/HNL-LAS`, x-axis year ticks read
out of the chart's own axis: 2020 at x=447.83, 2021 at x=528.37, so one month is 6.71 px. The
`--g5` band arrives as **two** paths — the first ending at x=461.0 (2020-03, +1.96 months) and
the second beginning at x=508.1 (2020-10, +8.98) — with 47.1 px, exactly seven month-widths, of
blank between them. `/route/JFK-LAX`, which filed in all 136 months, is **one** path spanning
x=46.0 → 950.0. `smoke.sh` asserts that multiplicity (`count`, not `has`: the needle
`<path fill="var(--g5)" d=` is present either way and only its count distinguishes a broken
area from a smoothed one) as a pair across the two routes.

### The derived annotation, and what counts as a leader

`app/src/lib/chart/crossover.ts` implements `system.md`'s rule that annotations are derived,
never hand-written: the annotation is the most recent year in which the #1 aircraft type by
seats differs from the previous year's. Three rules decide what that means, none of which the
design docs owned before M4c and each of which suppresses an annotation that would otherwise
mislead:

- **A tie has no leader.** Breaking a tie by input order, by `code`, or by `label` emits an
  annotation whose *direction* depends on nothing the reader can see, and which flips the day
  the row order changes. The year is simply not a candidate.
- **A leader must have flown** (`seats > 0`). T-100 carries ordinary no-service filings with
  `seats = 0` (`CLAUDE.md`, data gotchas — 5,713 of 2015's 5,717 zero-seat rows never flew), so
  a year in which nothing flew has no dominant type, and "X overtakes Y" drawn from two zeroes
  is a claim about nothing.
- **A year with no leader is skipped, not treated as a wall.** A leading → a tied year → B
  leading is a *genuine* crossover; it is what one looks like mid-transition, and it is reported
  against the later year, the one B actually leads. Strict calendar adjacency would silently
  delete real events, and would delete them most often at exactly the transition the annotation
  exists to describe.

**`null` is the common case, not an edge case:** only **12,416 of 22,919 routes (54%)** ever
change their #1 type, and JFK–LAX is not one of them — the A321nXLR leads every year 2015–2026
even as its share falls 44.8% → 35.2%, which is a real upgauge story but not a crossover. So
the chart renders no annotation on nearly half of routes, and must never manufacture one or
fall back to naming the largest type: that is not an event, it would appear on every chart, and
it would teach readers to ignore annotations. The rule is year-grain by construction — a
monthly #1 flips on seasonality.

The annotation names types by **display label**, which is current identity from
`dim_aircraft_type`, the same caveat the legend rail already states for carrier and airport
codes.

### The component: what Plot does not give you

`app/src/components/AircraftMixChart.tsx` is a synchronous Server Component taking a row set
and a title, and nothing else — it never names what it is describing, because M4d mounts the
identical component on `/airport`, `/carrier` and `/aircraft`. Four decisions the encoding
docs do not own:

- **`role="img"` is injected into Plot's root `<svg>`, not put on a wrapper.** Plot exposes
  `ariaLabel` and `className` but no `role`, and the attribute has to be on the SVG itself:
  `role="img"` is what makes the subtree presentational, so a screen reader announces the one
  description instead of reading out the `aria-label`ed group Plot wraps every axis in. A
  wrapping `<div role="img">` would hide those groups too but leaves the SVG unlabelled the
  moment it is extracted, so the component does a single anchored replacement of Plot's own
  root tag.
- **The COVID band's edges land ON the 2020-03 and 2021-06 samples, not around them.** Every
  month is plotted at its first day (UTC — a local-midnight `Date` moves a month's sample
  across the year boundary west of Greenwich), so `2021-06-01` is exactly where June 2021's
  seats are drawn. It is clamped to the window and dropped entirely when the two are disjoint;
  an unconditional rect puts a `--panel-2` slab at a meaningless x on any chart starting after
  2021.
- **The crossover annotation's text anchor flips at the window's midpoint.** ~30 characters
  against the ~10% of the frame a 2025 crossover leaves would run off the right edge.
- **Fewer than two months is stated in words, never drawn.** A one-month stacked area has a
  degenerate x domain and serializes to zero width — a blank panel under a `DATA AS OF` badge,
  the failure `/explore` and `/route` already refuse. `system.md`'s own sparkline rule says the
  same thing: one month is not a trend.

The colour key (`.ckey`) carries Other's disclosure — how many types it aggregates and its
share of seats — on the swatch itself, because that number is per-subject and the legend rail
is static.

**Measured, full shape (136 months × 6 bands): 30,372 bytes of HTML** for the whole block,
against Task 1's 28,609 for the bare SVG. It ships twice per response (body + RSC flight
payload, see `hosting.md`), so ~61 KB, and M4d mounts it three more times.

### The mount: two windows on one page

`/route/<pair>` now runs **two** pivot queries, **concurrently** — `Promise.all`, not two
sequential `await`s. They share nothing and the mix query is the larger of the two (996 rows
against 5), so the serial form paid for both in turn: 30.1 ms against 20.2 ms, warm, in
process. Numbers and method: [`hosting.md` § What the proxy's query actually
costs](hosting.md). The carriers table keeps its trailing 12 months; the chart gets the
**full** `2015-01 → asOf`. That is not an oversight to be tidied
into one window later — a twelve-point fleet-mix stack shows nothing, and the story the chart
exists to tell (the A321's rise on JFK–LAX) takes eight years to read. The consequence is a
disclosure obligation, and the `.window` line carries it: it names **both** ranges, because a
page drawing a decade under a line reading "Trailing 12 months" is claiming a window it is not
showing. `page.test.tsx` reads the chart's own `aria-label` for the window it actually drew,
not the line — a chart handed the trailing 12 renders a perfectly plausible twelve-point area
and would pass any check that only read the prose.

**The chart is drawn from the wider window's rows, not from the table's.** 12,062 of the
22,950 route pairs in this database last filed before the current trailing-12 window
(measured), so a route whose table is empty but whose chart has ten years of history is the
majority case, not a corner. Gating the chart on the table's `isEmpty` — the obvious way to
write the mount — would blank the only panel on those pages with anything in it. When the full
window is empty too (BNH–JFK: zero rows, 2015–2026) no chart is drawn at all: the empty state
below already states that finding in words and offers the widened permalink, and a second
panel repeating it in the chart's own voice is the card soup `CLAUDE.md`'s density rule rules
out.

**The legend rail's fleet-shading group is opt-in** (`<LegendRail fleetMix />`), for the same
reason `LegendRail` already omits the mockup's map group: `/explore` draws no chart, and a rail
explaining a monochrome gauge ramp on a page with no ramp on it is exactly the stale "how to
read this" the rail exists to replace. The group carries the **methodology** — one ramp ordered
by seats per departure, so a darkening stack is an upgauge; membership is a *different*
ordering — and deliberately no numbers. How many types Other holds and its share of seats are
per-subject facts, already on the chart's own `.ckey` next to the swatch they describe; a
static rail cannot know them, and stating them twice is how two copies drift.

**Page weight, measured on the served build:** `/route/JFK-LAX` is **32,087 bytes before the
chart and 96,179 after** — **+64,092**, close to the ~61 KB the component predicted from its
own block (30,372 × 2 for body + RSC payload) plus the legend group and the second window
line. (It was 96,112 before the final review added `font-family: var(--font-mono)` to the
chart's root style — 33 bytes, twice per response.) That is the input to M4d's decision, which
mounts this component on three more pages: at
three charts a page the arithmetic lands near 220 KB of HTML per response, which is where a
shared `Suspense` boundary, a narrower default window, or dropping the RSC copy stops being
premature. `app/smoke.sh` prints the current number on every run rather than asserting a
threshold — a threshold in a shell script is a number nobody measured.

### The gate that was missing

Before the mount, `AircraftMixChart` had **262 green unit tests and a clean production build
while being reachable from no route at all.** Nothing in CI executed its Plot path. A
`serverExternalPackages` or bundler regression would have shipped with every gate green — which
is the exact shape of the five M3b bugs `app/smoke.sh`'s own header lists, and the reason that
file exists. Plot + jsdom + Next's server bundler is a seam no unit test crosses by
construction.

`app/smoke.sh` section 9 closes it, on a real built-and-served page: the `<svg role="img">` is
in the HTML (not an empty client-side container), the `aria-label` describes the series,
`fill="var(--g0)"` **and** `fill="var(--g5)"` survive Plot's ordinal scale → jsdom's serializer
→ React's HTML escaping (so `globals.css` stays the single source and the spec's hardcoded-hex
fallback stays unused), the COVID label is present, the rail explains the ramp, and the rest of
the page still server-renders above it.

The annotation is checked as a **falsifiable pair**, because either half alone is vacuous:
absence on JFK–LAX (no crossover — 46% of routes) is satisfied by a component that never
renders an annotation, and presence is satisfied by one that manufactures an annotation on every
chart, which is the specific failure the spec forbids. So both run: `/route/JFK-LAX` must
contain no `overtakes`, and `/route/ATL-MCO` must contain the derived
`B757-2 overtakes A321nXLR · 2018` — measured against the built warehouse, and pinned as the
whole derived string rather than the bare word so a refresh that moves it fails loudly instead
of passing on a coincidence.

### The smoke harness was silently reporting the wrong answer

Mounting the chart is what found this, and it is the more valuable half of the milestone's
verification work. `smoke.sh` runs under `set -o pipefail` and every check was
`printf '%s' "$body" | grep -q…`. **`grep -q` exits the instant it matches**, so on a body
larger than the 64 KB pipe buffer the `printf` still feeding it dies of SIGPIPE and the
*pipeline's* status is 141 — even though the needle was found.

`/route/JFK-LAX` was 32,087 bytes through all of M4b, comfortably under the buffer, so this
never fired. At 96,112 it fired immediately and *positionally*: measured on the served build,
needles at byte offsets 1,489 (`DATA AS OF`) and 2,723 (`<svg role="img"`) returned 141 while
identical lookups for needles at 6,773 and beyond returned 0. Five checks reported FAIL for
strings that were plainly in the page.

The false FAIL is the harmless half. **`check_not` took 141 down its else branch and printed
`ok` for a needle that WAS present** — a gate passing for the wrong reason, in the one file
this repo keeps specifically because the other gates can pass for the wrong reason. Every
`check_not` in the file was one page-size increase away from going dark, including M4c's own
"a route with no crossover emits no annotation".

Fixed by dropping `-q`: without it grep reads its input to the end, `printf` always completes,
and the status is grep's own. The helpers now route through `has`/`has_re` with the reasoning
written above them, because the `-q` is exactly the kind of thing a later reader adds back as
an optimisation.

**Two of M4c's own smoke checks were then found weak by mutation, not by reading** — the same
lesson `CLAUDE.md`'s workflow section now generalises. With the chart mutated out of the page,
`fill="var(--g5)"` stayed green: the legend rail's fleet swatch is a `<rect>` drawn from the
same token. The needle is now `<path fill="var(--g5)" d=`, which is a claim about a mark with
geometry rather than about the rail standing next to it. Recorded mutants: mounting `false` in
place of the chart element kills 5 chart checks; `hasMix = false` (chart, window line and
legend group all gone) kills 8 of 10. The two survivors are survivors by design — "the rest of
the page still server-renders" is a guard that *must* hold with the chart gone, and "no
crossover, no annotation" is satisfied by an absent chart, which is precisely why it is paired
with a positive on ATL–MCO that the same mutant does kill.

### A needle that could never appear, and a `check_not` with nothing to lean on

The `-q` fix above made every check report grep's own status. It did **not** make every check
*meaningful*, and the final review found two that were not — neither of them a SIGPIPE problem.

**A dark needle.** `check_not … 'can&rsquo;t be read'` was copied out of
`explore/page.tsx`'s `<h1>This permalink can&rsquo;t be read</h1>`. **JSX decodes HTML entities
in text at compile time**, and React's serializer escapes only `& < > " '` — U+2019 goes out as
raw UTF-8. The literal string was never in the response, so the check printed `ok`
unconditionally, *including* in the case it exists to catch: `/explore` rejecting the
reserved-character permalink, the M3b regression that motivates `proxy.ts`. A guard that cannot
fail is worse than no guard, because it reads as coverage. It is now a regex spanning the
apostrophe (`permalink can.{1,6}t be read`), the same shape line 222 already used — and
confirmed by mutation: forcing `/explore` to reject that permalink turns it red.

**The whole file was swept for the class.** `grep -n '&[a-zA-Z]\+;\|&#'` over `src/` finds
entities in five files (`page.tsx`, `not-found.tsx`, `explore/page.tsx`, `LegendRail.tsx`), and
`can&rsquo;t be read` was the **only** smoke needle overlapping any of them. Two adjacent
classes were checked too and are sound: `unknown airport code 'ZZZZ'` survives because that
check reads the RSC flight payload, where the string is JSON-encoded and the apostrophes are
intact (React escapes `'` to `&#x27;` in the HTML body — both forms are in the same response,
and `smoke.sh` documents which one it is reading); and `data-below-floor="true"` is emitted by
`DataTable` as that exact literal.

**The last unpaired `check_not`.** `/` asserted only the *absence* of `vercel.com/new`, so an
empty body, an error shell or a 500 satisfied it. It is now paired with two positives on the
same body — the page's own `h1`, which nothing else in the app renders, and `DATA AS OF`, which
is what makes `/` a data view rather than a splash.

**The rule this generalises to:** a smoke needle crosses JSX, so it must be written in the
bytes React emits, not in the bytes the source contains. Anything with an entity, an
apostrophe, or an angle bracket in it needs a mutation run before it counts as coverage.

M4c is built: **280 app tests** green (`make app-check`), **443 Python tests** green
(`make check`), `make app-build` clean, `make app-smoke` green at **55 checks**, and
`make goldens` byte-identical — this milestone touches no SQL, so any golden movement would
have been a bug.

## M4d — `/airport`, `/carrier`, `/aircraft`

Three more entity pages on the composition M4b and M4c established. The shared page contract
is not restated here; § M4b and § M4c own it. What follows is what each page had to decide for
itself. Full design and the entity counts:
`docs/superpowers/specs/2026-07-31-m4d-entity-pages-design.md`.

### `/airport/<code>` — an airport is both endpoints

The composition is `/route`'s: title block, stat strip, full-window aircraft-mix chart,
trailing-12 carriers table, Explorer link, legend rail. `lookup_airport_by_code.sql` (M4b) is
reused unchanged, so the fact-presence filter and the collision guard that took `AUS` from two
answers to one come along with it, and `AmbiguousCodeError` propagates as a loud 500 exactly as
it does on `/route` — airport codes collide 0 times among fact-present airports (measured), so
a catch block would be untested code on the happy path.

**Every figure on this page must match `origin_airport_id = X OR dest_airport_id = X`.** An
origin-only page is not visibly broken: it renders every stat, every carrier row and every
chart band in the right shape, and is silently about half the airport. Measured at SEA
(`airport_id` 14747) over 2025-05 → 2026-04:

| | origin OR dest | origin only |
|---|---|---|
| seats | **53,373,806** | 26,710,000 |
| passengers | **43,896,637** | 21,941,241 |
| destinations | **143** | 140 |
| Alaska's seats | **26,091,482** | 13,061,110 |
| carriers | 13 | 13 |
| aircraft types | 25 | 25 |

The last two rows are why the tests are built the way they are: **carriers and aircraft types
are identical either way**, so a suite written around "13 carriers appear" passes against the
bug this page exists to exclude. Each assertion pins a figure the wrong query cannot produce.

**The pivot vocabulary cannot express that OR, so the page assembles it as inclusion-exclusion
over three ordinary pivots** — `origin`, `dest`, and their overlap — summed as
`origin + dest − (origin ∧ dest)` in `app/src/app/airport/[code]/endpoints.ts`.
`meta_pivot_dimensions` offers `origin_airport_id` and `dest_airport_id` separately,
`render.ts` AND-s filters together, and the one composite dimension (`route`) filters whole
route *pairs*. Adding an either-endpoint filter would mean a new catalog entry plus a second
composite-filter semantics implemented in `render.ts` **and** `pipeline/pivot.py` in lockstep,
which is M5's call, not a page's. The two side queries carry the *other* endpoint as a second
dimension, so one pair of queries answers both "which carriers" and "how many destinations".

**The third term is not a formality** — same-airport (`origin = dest`) filings exist in
`fct_segment_month` and satisfy both halves; see [data/invariants.md § Route
identity](../data/invariants.md#route-identity) for the counts. Its one exception is
truncation: each side is a `LIMIT`-ed pivot, so a truncated side can drop rows the overlap
query still returns, and the union then skips the subtraction instead of driving a measure
negative (`partial`). Found by the truncation test, not by reading.

**The page said outright that the Explorer could not express its query** (through M6), and
offered the two halves it *could* — `origin_airport_id`, `dest_airport_id` — as separate
permalinks, labelled as halves. A single link claiming "the identical query" would have been a
lie about the exact thing that distinguished this page from `/route`. **This entire
inclusion-exclusion shape, and the two-permalink copy above, is M4d-through-M6 history, not
M7's shipped behavior** — M7 Task 3 built the either-endpoint filter this section's own
"strongest argument for M5 adding one" line below was asking for, and the page now offers ONE
permalink reproducing its own totals exactly. See § M7 Task 3, below, for the current shape;
final whole-branch review found the old two-permalink copy and this section's back-reference to
it both still standing, unqualified, one milestone after the fix shipped.

**Cost: 54.2 ms of DB work against `/route`'s 20.2 ms**, in-process through `runPivot` /
`fetchAircraftMix` against the built database, SEA, warm, median of 8, at DuckDB's default
thread count. Six pivots (three per union, two grains) under one `Promise.all`; serially the
same six are 64.3 ms. Full table: [hosting.md § What the proxy's query actually
costs](hosting.md#what-the-proxys-query-actually-costs). That is the standing price of an OR
the pivot layer cannot express, and the strongest argument for M5 adding one.

**Two limits, both measured rather than guessed — and both figures were mis-attributed until
M4d's final review.** Every count below is per side unless the row says otherwise; the union of
the two sides is always larger, and quoting a union as a per-side bound understates the headroom.

| Bound | Worst airport | origin side | dest side | union | limit |
|---|---|---|---|---|---|
| (carrier, other endpoint) groups, trailing 12 (2025-05 → 2026-04) | ORD (13930) | 879 | 855 | 959 | 5,000 |
| (month, aircraft type) groups, full window (2015-01 → 2026-04) | ORD (13930) | 4,094 | 4,089 | 4,118 | 10,000 |

SEA produces 374 departing and 293 arriving on the first, and 2,832 / 2,801 (union 2,886) on the
second; ATL — which `smoke.sh` weighed as "the worst case" — is 3,561 / 3,572 on the second, well
under ORD. **Reaching either limit now discloses truncation on the page rather than throwing.**
The chart's union originally called `unionMix` with no options, so a truncated side that dropped
a cell the overlap query still returned reached `inclusionExclusion`'s throw — a 500 on a
response the proxy had already stamped `public, s-maxage=2592000`, i.e. a 500 pinned in a shared
CDN cache for thirty days on a page that would serve fine the moment the limit was raised. Both
unions now thread `partial`, and `endpoints.test.ts` asserts ORD comes back **untruncated**, so a
refresh that approaches the bound fails a test rather than degrading a page.

**An empty trailing-12 table is normal, and unlike `/route` the chart is never empty.** Every
airport that resolves is fact-present by construction, so there is always history somewhere in
the full window — ISN (Sloulin Field International) filed 58 months and stopped in 2019-10, and
its window line names `2015-01 → 2019-10`, the range actually drawn.

**`destinations` excludes the airport itself.** Its own same-airport filings stay in every
measure — they are real activity — but SEA is not one of SEA's destinations: 144 distinct
other-endpoint ids including itself, 143 without.

### `/carrier/<code>` — the page has to say what it is counting

The composition is `/route`'s, one dimension over: title block, stat strip, full-window
aircraft-mix chart, trailing-12 table, Explorer link, legend rail. The table is **aircraft
types operated** (17 for DL, measured) because the fleet is this product's subject.
`AircraftMixChart` mounts unchanged — the page is a filter on `op_airline_id`, not a new
dimension — so nothing in M4c had to move.

**M6 Task 4 gave this page its Top-N builder's first two callers** (`lib/topn.ts`, built in
Task 3): a **Top routes** table and a **Top origin airports** table, each `topNQuery`
(dimension = the grouping, `measures[0]` sorted descending, `grouping: "operating"` by
default) filtered on this page's own `op_airline_id`, limit 25, joining the page's existing
`Promise.all` rather than adding a sequential await. Routes use the builder directly — DL
touches 1,873 distinct routes over the trailing 12 months (measured), so the table is a top-25
view of that, not the whole set. **Airports are `origin_airport_id` only, headed "Top origin
airports", never "airports served."** At M6 this was because the pivot had no either-endpoint
filter at all (M6 backlog item 1) — **M7 Task 3 built one** (`endpoint_airport_id`,
`filter_only`, `filter_mode='either'`) and `/airport/<code>` uses it. This table stays
origin-only for a DIFFERENT, still-standing reason: ranking airports means GROUPING by the
endpoint dimension to produce one row per airport, and `endpoint_airport_id` is deliberately
`filter_only` — it can narrow a query to one fixed airport (exactly what `/airport` needs) but
is rejected as a grouping dimension, since grouping by it would put one segment row into both
its origin's group and its dest's group and double-count on summing (the same class of
failure T-100's `CLASS` rollup codes guard against). Rendering this table from an origin-only
query without saying so would repeat the exact failure class `/airport` already paid for:
dropping a union term read SEA at 26,710,000 seats instead of 53,373,806. For DL, origin-only
counts 186 airports (measured) against 188 either-endpoint airports — a small gap today, but
the heading has to be honest about which question the query answers regardless of how large
the gap happens to measure. The page states the real limitation in words under the table, not
just in the heading — corrected by the final whole-branch review from a first draft that
(after M7 Task 3 shipped) still blamed a missing filter rather than the filter's own
`filter_only` shape.

**Two `CLAUDE.md` hard rules stop being background here and become the page's own claims,
because the entity *is* the carrier.** Both read as bugs if left unsaid:

- **Operating carrier is the grain.** A Delta-branded regional flown by Endeavor files as
  `9E`, so `/carrier/DL` legitimately *excludes* it. Someone who knows the network reads DL's
  seat count as too **low** unless the page says what it is counting. There is no
  marketing-carrier field and none is inferred.
- **`dim_carrier` holds the CURRENT code and name.** v0 collapses Carrier Decode to one row per
  airline, so a 2016 month on this page is labelled with today's identity, not the one filed.

`LegendRail` already states both **generically**, on every data view, and that is deliberately
not treated as sufficient. A rail entry phrased in the abstract does not attach to the number a
reader is looking at, so `/carrier` states both **about its own subject**, in the content
column, above the rail — naming the carrier, its code, and the consequence (the excluded flying
is counted, under someone else's code).

That distinction is what makes the tests falsifiable rather than decorative. Each claim is
asserted on **two** carriers (DL and AS) against the text of `.body > div` only:

| the bug | what catches it |
|---|---|
| claim deleted | both halves fail |
| claim hard-coded to Delta (every example in the spec is Delta) | the AS half fails |
| claim left to the shared rail | both halves fail — `.body > div` cannot see the `<aside>` |
| topic word present, substance absent | the assertion is on `no marketing-carrier field` and
  `DL-branded … counted there, not here`, not on the word "operating" — which already appears
  in this codebase's grouping toggle, its measure labels and its rail |

Both sentences are built as **single template strings**, not adjacent JSX expressions. React's
SSR emits `<!-- -->` between adjacent text nodes, so `what {name} ({code}) filed` puts comment
markers inside the sentence in the served bytes: `textContent` skips them and every unit test
stays green while a `smoke.sh` grep stops matching. That is M4c's window-line bug exactly, and
these two sentences are the ones a served-build check most wants to grep.

**The 404 says "nothing filed under this code", not "unknown code".** 1,543 of `dim_carrier`'s
**1,657 distinct** codes have no fact-present holder (measured — 1,776 is the table's *row*
count, one per `airline_id`; 1,657 − 114 fact-present carriers = 1,543), so "recognized by BTS, never filed" is the
**common** carrier 404, not the exotic one — `PA` (Pan American World Airways, three
`airline_id`s, zero T-100 Segment rows) reaches it by the same path as `ZZ`, which is in
`dim_carrier` not at all. `routePair.ts` splits its two cases apart only because
`lookup_airport_code_exists.sql` already existed to tell them apart; there is no carrier
equivalent and this milestone adds no SQL, so the sentence shipped is the one that is **true of
both** — it talks about filings, not about recognition. A copy-paste of the airport wording
would state something false about Pan Am.

**An empty trailing-12 table is normal here.** 45 of the 114 fact-present carriers last filed
before the current window (measured, 39%) — Virgin America stopped in 2018-03 — so the chart is
routinely the only panel on the page with anything in it, and the window line must name
`2015-01 → 2018-03` rather than the window it asked for. Same rule, same reason, as M4c's
`drawnFrom`/`drawnTo`: naming a range you are not drawing is the fabrication that section
already forbids. Both caveats above render whether or not there is a table — they qualify the
subject, not the rows.

**`AmbiguousCodeError` is deliberately not caught here.** Carrier codes collide 0 times among
fact-present airlines (measured), so a catch block would be untested code on the happy path; a
loud 500 is `resolve.ts`'s documented contract and matches what `/route` does with the identical
error. `/aircraft` is where that error is reachable on today's data and must be rendered.

**`carrierSlugFromPath` lives in `app/src/lib/carrier.ts`, not beside its sibling in
`rawPath.ts`** — three of these pages were built concurrently and `rawPath.ts` is one file three
tasks would have been editing at once. The four copies (route, airport, carrier, aircraft)
should collapse into one `entitySlugFromPath(pathname, prefix)` now that they all exist.

### `/aircraft/<slug>` — the slug is not a key, and the chart is not the same chart

Two things are different here from the other two entity pages, and both were forced by the data
rather than chosen.

**The slug is a transform of `short_name`, not `short_name`.** 15 of the 112 fact-present short
names carry a `/` or a space (`docs/data/invariants.md` § Entity resolution), so
`/aircraft/A320-1/2` parses as *two* path segments and can never match a single dynamic segment.
`app/src/lib/aircraftSlug.ts`'s `slugFor()`
replaces both characters with `-` and uppercases; `/aircraft/a320-1-2` 308s to `/aircraft/A320-1-2`,
never to the unroutable raw name. It was 16 names and the worked example was `A321/LR` until BTS
renamed that type to `A321nXLR` on 2026-08-07 — `docs/data/invariants.md` § Entity resolution has
the rename and why the fixture had to move rather than be renamed.

That transform is many-to-one, so resolving a slug means **expanding it back into every
`short_name` it could have come from** — each `-` was a `-`, a `/`, or a space — and handing the
whole set to Task 1's `lookup_aircraft_by_name.sql`. The alternative, rewriting that file's
`WHERE` to compare slugs, would make its name a lie and would move the collision guard out from
under `insertUniqueByCode`, which keys on the short name. The expansion is `3^n`, so it is
**capped at 4 separators** (81 candidates) and refused above that: the measured maximum over all
111 fact-present slugs is 2, and without a cap `/aircraft/-------------------` asks DuckDB to
bind `3^19` parameters. `aircraftSlug.test.ts` pins that maximum against the live catalog, so a
BTS refresh that ships a five-separator type fails a test rather than a request.

**`/aircraft/CE-180` is a reachable URL with no answer, and it renders one anyway.** `CE-180`
names BTS code `030` (CESSNA 180) *and* `031` (CESSNA 180A/B); both really flew and no scoping
resolves it. It is a **404** — literally true, no entity lives at that URL, and a 404 gets
`no-store`, which is right for an answer that changes when the dataset does. But the 404 body is
not an apology: `not-found.tsx` re-runs the resolution, catches `AmbiguousCodeError`, resolves
both codes to their full designations through the ordinary resolver, and renders each with a
working Explorer permalink — the Explorer is keyed on the BTS code, so it can show what this page
cannot. Candidates are sorted by code; the error preserves driver row order by design, which is
right for a message and wrong for a page that would otherwise list them differently across
restarts.

**The chart stacks by carrier.** `AircraftMixChart` and `fetchAircraftMix` now take a
`MixDimension` as a trailing, defaulted argument, so `/route`, `/airport` and `/carrier` are
untouched. Why, what the ramp then means, and the measured configuration spreads that justify it:
`docs/design/system.md` § Charts. `pipeline/pivot.py` and `app/src/lib/pivot/render.ts` were not
touched and `make goldens` leaves `sql/03_queries/goldens/` byte-identical — the generalization is
entirely in the query *composition* layer, which is what M4c's "the chart adds no SQL" property
bought.

**Two derived-measure traps this page has and `/route` does not.** An aircraft type *has* a
nominal seat count, so averaging the carrier rows' `avg_gauge` looks like it would recover it. It
would not: it weights Sun Country's 186-seat 737-800 equally with Southwest's 175-seat one
regardless of how many either flew. And the filter value is the BTS `code` as a **string** — 13
fact-present types carry a leading zero, and `Number('036')` renders an empty page for a type that
filed in 120 months. `/aircraft/SKYHAWK` is the test that catches it; every other type this page
is tested on (614, 655, 699) survives an int-parse unchanged.

### Routing and cacheability — the step none of the three pages could take for itself

All three pages above were built, unit-tested and merged **while being reachable from no
matcher entry at all**, which is the same shape as M4c's chart being green from no route: the
tier that decides what a served response says about itself is invisible to every gate except
`app/smoke.sh`. This is where M4b's Critical lived, and by M4d the cost of repeating it had
grown — each new `not-found.tsx` reads the pathname header `proxy.ts` sets and throws without
it, so a missing matcher entry does not merely mis-cache a page, it **strips the entire message
off every 404 on it** (measured; the full before/after table is in
[hosting.md](hosting.md#what-omitting-one-actually-costs--measured-not-assumed)).

`proxy.ts` therefore stopped being a chain of `else if`s and became **one table,
`ENTITY_ROUTES`** — a `slugFromPath` prefix reader plus a resolver per page — next to a matcher
list it has to agree with. A table because the failure being defended against is a fifth page
whose author copies three lines out of four; a table puts both halves in one screen. At most one
resolution runs per request (prefix test, break on first match), so four entity pages cost what
one did.

**The predicate changed from `!== "notFound"` to an allow-list of kinds, and that is the whole
finding.** `resolveAircraftSlug` has four outcomes; `/aircraft/CE-180` is `ambiguous`, renders a
404, and would have been long-cached by the shape `/route` uses. Full reasoning, the airport
case-redirect asymmetry, the served-build cache table and the five mutants that pin it:
[hosting.md § `Cache-Control` lives here](hosting.md#cache-control-lives-here-and-it-is-status-blind-by-construction).

**`app/smoke.sh` gained one section per page, each asserting the same five things in the same
order** — the page renders; its `Cache-Control` is the project one; a real code renders and a
bare id does not; the chart's `<svg>` and its `<path fill="var(--gN)" d=` ramp fills are in the
served bytes; and its 404 names the code *and* is `no-store` while its 308 keeps the long cache.
The order is written into the file as a checklist for the next page, because M4b's bug was
precisely that this file copied `/explore`'s body checks and not its header check. Three needles
are worth noting as choices rather than obvious:

- `>14747<`, not a bare `14747`, for "no raw `AIRPORT_ID`". SEA's id legitimately appears in the
  page's two Explorer permalinks (`f=origin_airport_id:14747`), so the literal form of the
  handoff note would have been a permanently red check. The claim that matters is that no *cell*
  renders the id.
- `53,373,806` on `/airport/SEA` — the both-endpoints seat total. Carrier and aircraft-type
  counts are identical either way (13 and 25), so only the seat/passenger/destination figures
  can tell an origin-only regression from a correct page.
- `Seats by aircraft type` is asserted **present** on `/airport/SEA` and **absent** on
  `/aircraft/B737-8`. An absence check whose needle no page in the app serves is an absence
  check that can never fire.

Page weight on the served build, recorded rather than thresholded (M4c's `/route/JFK-LAX` was
32,087 bytes before its chart and 96,153 after):

| URL | bytes of HTML |
|---|---|
| `/route/JFK-LAX` | 96,153 |
| `/aircraft/B737-8` | 103,019 |
| `/airport/SEA` | 119,126 |
| `/carrier/DL` | 127,688 |
| `/airport/ATL` | 130,435 — 3,561 / 3,572 (month, type) cells per side, union 3,592 |
| `/airport/ORD` | **139,520** — the true worst case, 4,094 / 4,089 per side, union 4,118 |

`/airport/ATL` was recorded here and in `smoke.sh` as "the worst case in the database, 4,118
cells per side". It is neither: 4,118 is **ORD's union**, and ORD is denser than ATL on both
sides. `smoke.sh` now weighs both.

Nothing in the harness holds a fixed response buffer — the bodies land in shell variables — but
the `grep -q`/`SIGPIPE` hazard the file's header describes was invisible until a page crossed
64 KB, and every page in this milestone is now past 100 KB, so the numbers are kept where the
next person will see them.

## M5 — connecting the graph

M3/M4 built four islands: the Explorer and four entity pages, each reachable only by typing a
URL. M5's whole job is the edges between them — cross-links, an omnibox, a sitemap — plus
closing the cache gap M4d's own review flagged and never fixed. Eight tasks; the design spec is
`docs/superpowers/specs/2026-07-31-m5-connect-the-graph-design.md`.

### Tasks 1-3 — the link map, the top bar, and cross-linking every table

**Task 1** added `app/src/lib/entityLink.ts`'s `entityHref(dimKey, hit)`: a dimension key →
entity-page-prefix map, keyed on the dimension's **own key**, never on `join_dim` — `route`,
`origin_airport_id` and `dest_airport_id` all carry `join_dim = dim_airport`, so a
`join_dim`-keyed map would send every route cell to `/airport/`. The map lives in TypeScript
on purpose: `meta_pivot_dimensions` governs which dimensions exist, not which have a page, and
folding a routing decision into a catalog view `make goldens` also reads would make the
Explorer's data contract answerable to a frontend routing choice.

**Task 2** extracted the top bar (`app/src/components/TopBar.tsx`) — wordmark, `DATA AS OF`,
and, new, the search field: a plain `method="GET"` form posting `q` to `/search`, no client JS,
present on every page including 404 states. It also added a `<link rel="canonical">` to all
four entity pages and consolidated the site's one base-URL definition
(`app/src/lib/siteUrl.ts`'s `BASE_URL`, `process.env.UPGAUGE_BASE_URL ?? "http://localhost:3000"`)
after fix round 1 found a hardcoded `https://upgauge.shipman.dev` — a straight violation of
CLAUDE.md's portability rule (Docker + env vars, no baked-in hostname) that would have pointed
every canonical tag and sitemap `<loc>` at the wrong host for a fork or a staging deploy. The
same fix round wrapped each entity page's slug resolver in React's `cache()` at the **page**
layer, not inside the shared resolver module `proxy.ts` also imports — `cache()` only memoizes
inside an active React Server Component render (it reads the current dispatcher; outside one it
degrades to calling straight through, unprovable by this project's Vitest suite — see
[hosting.md's own section on this](hosting.md#reacts-cache-needs-an-active-rsc-dispatcher--unprovable-by-unit-test)),
so wrapping the shared module would have silently changed `proxy.ts`'s semantics for a
concurrent task's file.

**Task 3** wired the link map into `DataTable`'s `DimensionCell` — the one chokepoint all five
table-rendering surfaces (`/explore` + four entity pages) already shared — so a resolved cell
that has a page renders as `<a href={entityHref(...)}>`, wrapping the existing `<abbr>` rather
than replacing it. `route`'s cell is the one exception: its `column_expr` spans two columns, so
there is no single id to hand `entityHref`, and its href is built separately
(`routeHrefFromCodes`, `entityLink.ts`) from the two resolved airport hits directly. **This is
the milestone's sharpest trap**, restated from M4b: `/explore` displays a route cell in
**airport-id** order (`route_key_low, route_key_high`) but the canonical `/route/<pair>` URL is
**code-alphabetical**, and the two orderings disagree for 154 of 22,420 pairs. Reusing the
displayed order as the link is silently wrong for every one of the 154 — `IFP–IAH` displays in
that order but must link to `/route/IAH-IFP`, the reverse, and is the fixture both the unit
tests and `app/smoke.sh` use, because a `JFK–LAX`-shaped fixture cannot fail this way (its two
orderings agree, along with 22,266 of the other 22,419 pairs).

### Task 4 — the omnibox

`/search?q=...` (`app/src/lib/search.ts`, `app/src/app/search/page.tsx`,
`sql/03_queries/search_by_name.sql`). Resolution order, each step a definitive answer or a
fall-through:

1. **A route-pair pattern** — two tokens joined by `-`, an en dash, or a space
   (`routePairTokens`) — resolved only if both sides are real, distinct, fact-present airport
   codes. Unambiguous by construction: airport/carrier/aircraft codes never contain the
   separators this shape requires, so it cannot collide with a single-code namespace.
2. **An exact code in any of the three namespaces — airport, carrier, aircraft — checked
   CONCURRENTLY and collected, never short-circuited.** This is the fix for the bug the task
   brief names directly: an if/else-if chain (try airport, else carrier, else aircraft) would
   resolve a colliding code by whichever branch runs first, silently. Measured, fact-present,
   `is_latest`-scoped: exactly three codes are both an airport and a carrier — `LNY` (Lanai
   Airport / Western Aircraft dba Lanai Air — the sharpest of the three, since the carrier is
   named after the airport, so a silently-chosen answer would still read as plausible), `NEW`
   (Lakefront / New England Airlines), `WST` (Westerly State / Friday Harbor Seaplanes).
   Airport ∩ aircraft and carrier ∩ aircraft are both 0 today, which is a property of the
   current dataset, not a guarantee, so every namespace is checked regardless.
3. **A name substring, ranked** (`rankByStartsWith`) — a result whose name **starts with** the
   query ranks above one that merely contains it, ties broken by the underlying query's own
   order. No fuzzy distance, no traffic-based boost — both are numbers nobody could justify.
   `Portland` matches four fact-present airports, not three (`HIO`, `PDX`, `PWM` — Maine, not
   Oregon — `TTD`); `Alaska` returns 8 rows (`DUT` Unalaska Airport plus 7 carriers), where the
   ranking is what puts `AS` ahead of the `DUT` substring false positive.

A unique match **307-redirects, never 308**: unlike every other redirect in this product
(`/airport/sea` → `/airport/SEA`, a second spelling of one fixed URL, derived from the slug
alone and therefore permanently valid), `q=PDX` resolving to exactly one entity is a fact about
**this month's dataset**. A 308 is cached by the requesting browser itself, forever, independent
of any CDN — if a future rebuild ever made a code collide, every browser that had ever visited
under a 308 would keep redirecting to the old answer past the point it stopped being true. A
collision (LNY, NEW, WST) renders both candidates and is explicitly **not** a redirect. An
unbounded substring hit list discloses its cap (`SEARCH_RESULT_CAP = 50`) and the true count
rather than truncating silently — CLAUDE.md's empty-result rule, generalized to free text.

### Task 5 — sitemap, robots.txt, and the four `lastmod` queries

`app/sitemap.ts` (fed by `app/src/lib/sitemap.ts` and
`sql/03_queries/sitemap_{routes,airports,carriers,aircraft}.sql`) emitted **23,689** URLs at
M5 — 22,420 routes + 1,045 airports + 114 carriers + 110 aircraft; **23,694 as of M6 Task 7**,
which added `/watch` and its four presets (see § M6 Task 7 below) — every count
**quarantine-inclusive**: a quarantined row is still a real filing whose page still 200s, and
excluding it would silently drop 4 airports, 2 aircraft types and 31 route pairs that serve
today. `lastmod` is each entity's **own last-filed month**, `max(year_month)` per entity, never
the sitemap's build date — `/carrier/VX` (Virgin America, last filed 2018-03) is the dormant
fixture this distinction needs, since an active entity's own last-filed month and the current
build window coincide, so a bug that reports the build date instead would still pass a test
anchored on an active carrier. `app/robots.ts` disallows `/search` (unbounded query space, no
canonical content of its own) and `/api/` (a data endpoint, not a page), allows everything
else, and points at the sitemap. The aircraft sitemap query dedupes on the URL **slug**, not the
BTS code — `sitemap_aircraft.sql` already excludes `CE-180` (two codes, one short name); a
second guard, `dedupeAircraftBySlug`, catches the other direction (two DIFFERENT short names
slugging to the same value), which has no live example today but is a property of the data, not
the transform, so it throws rather than silently picking one if a future refresh ever creates
one.

### Task 6 — the carrier 404 split, and collapsing four copies of one guard

`sql/03_queries/lookup_carrier_code_exists.sql` mirrors the airport existence-only lookup
(`lookup_airport_code_exists.sql`), so `resolveCarrier`'s 404 now makes the same split
`/route/<pair>`'s always has: `ZZ` 404s "unknown carrier code" (absent from `dim_carrier`
entirely); `PA` 404s "recognized by BTS ... none of which has filed a T-100 Segment row" and
names **every** holder, not just the first — `PA` alone is three `airline_id`s (20384 and
20386, both "Pan American World Airways", plus 20389 "Florida Coastal Airlines", an unrelated
carrier sharing the code by coincidence), and 94 of the 1,543 never-fact-present codes are
multi-holder the same way (worst case 3, `PA`). This is the **common** carrier 404, not the
exotic one: 1,543 of `dim_carrier`'s 1,657 distinct codes have no fact-present holder (1,657 −
114 fact-present; 1,776 is the table's row count, one per `airline_id`).

Separately, the four `<entity>SlugFromPath` readers (`routeSlugFromPath`, `airportSlugFromPath`,
`carrierSlugFromPath`, `aircraftSlugFromPath`) — deliberately four independent copies of the
same `decodeURIComponent`-throws guard at M4d, since the three M4d pages were built
concurrently and one shared file would have been three agents editing one file — collapsed into
one-line wrappers around `app/src/lib/entitySlug.ts`'s `entitySlugFromPath(pathname, prefix)`.
`airportSlugFromPath` is the one wrapper that is not a bare partial application: it additionally
maps the bare-prefix empty slug to `null` rather than `""`, so an empty code segment opts a
request out of entity resolution entirely rather than sending `""` into `resolveAirportCode` as
a slug to reject. `AIRPORT_PREFIX` moved out of the route directory
(`app/airport/[code]/resolveAirport.ts`) into `app/src/lib/airport.ts` alongside it, so
`proxy.ts` and `entityLink.ts` no longer import from a route segment's own file.

### Task 7 — the 5xx cache gap, narrowed but not closed

M4d inherited a gap open since M3b and widened its blast radius from one page to four: the
proxy resolves a request's cacheability and writes the header **before** the page can throw, so
a 500 — `dataAsOf()`, `loadAllowlist()`, `runPivot()`, an OOM — went out under whatever cache
the proxy had already committed to. Two parts, because the full fix turned out not to exist for
this Next version.

**Part A closed one concrete scenario outright.** `/explore` was the one proxy branch that ran
no database query at all before choosing its header — every `ENTITY_ROUTES` row already ran a
real resolution and declined the cache on its own failure, but `/explore` had nothing to catch
because nothing was attempted. `isDataLayerHealthy()` (`proxy.ts`) gives it an equivalent probe:
call `loadAllowlist()`, exactly what `ExploreView` calls first, before its own `decode()`/
`runPivot()` try/catch, and default to `no-store` on any throw.

**Part B spiked the complete fix — a `route.ts` for `/route/<pair>` that owns its own
`Response` and can set `Cache-Control` per outcome, the way `/api/pivot` already does — and it
does not build.** Next 16 rejects a `route.js` and a `page.js` at the same route segment
outright (`Conflicting route and page at /route/[pair]`), confirmed against `next build`, not
reasoned about. The only remaining shape — delete `page.tsx` and hand-render its tree from
`route.ts` — was ruled out by the task's own exit condition before being coded: a Route Handler
sits entirely outside Next's page-rendering pipeline, with no access to layouts,
`notFound()`/`permanentRedirect()`, streaming, or the RSC flight payload the server-rendered
chart depends on. The adopted fallback: `HTML_CACHE` (renamed from the single `CACHE` constant)
drops from `s-maxage=2592000` to `s-maxage=3600` for `/explore` and the four `ENTITY_ROUTES`
pages only — `/api/pivot` is untouched (its own route handler already sets `no-store` on
errors). This narrows a 5xx's public-cache exposure from up to 30 days to up to 1 hour; **it
does not close the gap** — a 500 minted at minute 0 is still cached for up to 59 more minutes.
Full measurement and the mutation coverage proving the new value is load-bearing:
[hosting.md § "The gap"](hosting.md#the-gap-a-5xx-still-gets-a-long-cached-header--m5-task-7-narrowed-it-didnt-close-it).

### Task 8 — routing, cache, smoke, docs: making the new routes real

The task this milestone's own Critical (M4b's cache-matcher bug) was hiding in a second time.
`proxy.ts`'s matcher grew from six entries to **nine** — `/search`, `/sitemap.xml`,
`/robots.txt` — each an exact-path branch rather than an `ENTITY_ROUTES` row (none has a
dynamic segment or a per-slug resolution). `/search` gets `no-store` **unconditionally**, not
the well-formed-vs-not split every other row makes: `q` is an unbounded, attacker-chosen string,
so there is no proxy-side resolution that would make caching any of it safe, and a per-`q`
shared-cache entry is a cache-fill vector on a box whose entire cost model is that caching
bounds origin load. `/sitemap.xml` and `/robots.txt` get the project's 30-day value outright —
both are built from the same catalog queries regardless of who's asking, carrying none of an
entity page's per-request resolution risk.

**Running the heavy gates for the first time since Task 5 shipped the sitemap found two real
bugs, both invisible to every gate except `make app-smoke`.** `app/sitemap.ts` and
`app/robots.ts` shipped with no `dynamic` export, so `next build` tried to **prerender**
`/sitemap.xml` at build time — and the build tool's own documented command
(`npm --prefix app run build`, what `make app-build`/`make app-smoke` both run) changes `cwd` to
`app/` before invoking `next build`, not the repo root every other DB-touching route's
`force-dynamic` export exists to make irrelevant. `make app-build` failed outright:
`IO Error: Cannot open database ".../app/upgauge.duckdb" ... database does not exist`. Both
files now carry `export const dynamic = "force-dynamic"`, the same export every other
DB-touching route already had. Separately, `app/smoke.sh`'s own Cache-Control checks for
`/explore` and all four entity pages were still asserting the **old** 30-day value after Task 7
shortened it to `HTML_CACHE` — Task 7 touched `proxy.ts` and `proxy.test.ts` but not this file,
so those checks had been silently wrong (a red check for a correct header) since Task 7 landed,
caught only because this task is the one this repo's working agreement reserves a dedicated,
memory-capped pass for. A third latent bug in the same family: the `/carrier/PA`/`/carrier/ZZ`
404-body checks predated Task 6's split and asserted a substring ("no carrier with code '<C>'
has filed") that neither actual post-split sentence contains — corrected to assert each case's
real phrase and the absence of the sibling's, the same discipline `/route`'s and `/airport`'s
404 splits already use.

`sql/03_queries/sitemap_routes.sql` was rewritten to read `fct_segment_month`'s own
`route_key_low`/`route_key_high` columns instead of recomputing `least`/`greatest(origin_airport_id,
dest_airport_id)` — every other route-grain query already reads those columns directly; verified
byte-identical output over all 3.36M rows before and after, so this is convention alignment, not
a bug fix.

**Task 7 Part A's fail-safe was verified end to end, not just unit-mocked, per whole-branch
review.** `proxy.test.ts` pins `isDataLayerHealthy()` with a mocked rejection — precise, but it
never crosses Next's own routing or a real DuckDB open. `app/smoke.sh` now reproduces
`hosting.md`'s own original measurement method directly: copies `upgauge.duckdb` (never the
original — nothing in this repo writes to it), drops `meta_pivot_dimensions` from the copy via
Python's `duckdb` binding (already a pipeline dependency), points a **second**, short-lived
`next start` at the broken copy via `UPGAUGE_DB`, and confirms `/explore` comes back `500`,
`no-store` — never the old 30-day value, never `HTML_CACHE` either. The primary server is
killed first: this repo's own 8GB-memory working agreement does not run two `next start`
processes at once, so this section runs last in the file.

## M6 — Gauge Watch and the Top-N builder

M5 connected the four islands; M6 adds a fifth surface, `/watch`, and fixes the health-score
composite that both `mart_route_health`'s D1 status and every preset's ranking depend on. Eight
tasks; the plan is `.superpowers/sdd/2026-07-31-m6-watch-and-topn/`.

### Tasks 1-2 — the composite: an identity, a NULL trap, and a re-measurement

`mart_route_health.health_score` scores **four independent axes at equal weight (0.25 each)**:
`z_lf` (raw `lf_delta`), `z_gauge` and `z_freq` (both **logged** ratios — `ln(t12/p12)` — because
the raw ratio is unbounded and asymmetric, a halving and a doubling should carry equal
magnitude, and they don't in raw form), and `z_completion` (`completion_factor` capped at 1.5).
Each is a z-score against the other scored rows (`(x - avg(x)) / stddev_samp(x)`), clamped to
±3 so no single axis can move the composite by more than 0.75.

**`capacity_delta` is deliberately excluded from the score, though it stays a displayed
column.** Task 1 found the identity that licenses this: in log space, `capacity_delta` is
*exactly* `frequency_delta + gauge_delta` — verified to 9.37e-16 over all 7,392 finite rows on
the real warehouse. Scoring it as a fifth axis would score gauge and frequency a second time
under a different name, silently doubling their combined weight to 40% of the composite while
`completion_factor` — no fewer real, but collinear with nothing — carried its nominal 20%.

**The `least`/`greatest` NULL trap, found twice independently (the completion cap, then the
score clamp) and each time the wrong way round in a first draft:** DuckDB's `least()` and
`greatest()` **ignore NULL** rather than propagating it — `least(NULL, 3)` returns `3`, not
`NULL`. A bare `least(completion_factor, 1.5)` therefore fabricates a near-perfect 1.5
completion rate for the 180 routes that filed no schedule at all (`completion_factor IS NULL`
for them, not low), and a bare `greatest(least(z, 3), -3)` clamp scores all 8,080 rows,
including the 813 that have no health score for a data-availability reason and must render as
"insufficient data," never a number. Both guards are `CASE WHEN x IS NULL THEN NULL ELSE
least/greatest(...) END`, not the bare form. **Get the arithmetic direction right when citing
this**: `greatest(least(NULL, 3), -3)` returns **3**, not -3 (`least(NULL, 3)` is 3 first, then
`greatest(3, -3)` is 3) — an earlier draft of `docs/data/model.md`, `200_mart_route_health.sql`'s
own comment, and `pipeline/tests/test_route_health.py`'s docstring all stated -3, independently;
the first two were corrected in Task 2's review round, the test docstring was missed until Task
8's own doc sweep found it.

**Task 2 re-measured the composite against the real warehouse** rather than trusting the design
doc's synthetic numbers: four axes span 1.5x mean `|z|` where the original five-axis, double-
counted design spanned 25.0x. The three-reason NULL population is unchanged at 813 of 8,080 (688
no prior window, 180 no filed schedule, 55 overlap) — the contract `docs/product/features.md`'s
"never render NULL as unhealthy" rule rests on, and the same population `/watch/death-watch`'s
own scope note states on the page.

### Task 3-4 — the Top-N builder, and its first two callers

**`app/src/lib/topn.ts` adds no SQL and no catalog entries — the same property M4c's chart
has.** A "Top N `<dimension>` by `<measure>`" view *is* an existing pivot: one dimension, the
first requested measure sorted descending, a limit. What did not exist was one place deriving
both the query (`topNQuery`) and its Explorer permalink (`topNPermalink`) from a single spec, so
a page could not silently link to a different query than the table above it renders.

**This is also where a claim already wrong twice over got corrected a third time.** M3's own
spec, `docs/product/features.md`, and `docs/design/system.md` all described `/watch`'s presets
as "saved instances of the Top-N builder." They cannot be: every `meta_pivot_measures` row is a
single-window aggregate, and every preset ranks on a **delta** between two windows (`lf_delta`,
`gauge_delta`, `health_score`) that no pivot measure expresses. The presets read
`mart_route_health` directly and share nothing with the Top-N builder except `DataTable`'s rank
column. `features.md` and `system.md` were fixed in Task 3; this file's own M2 section carried
the same stale claim ("`mart_leaderboards` is deferred to M5 ... a generic Top-N builder that M3
has not built yet") — missed until Task 8's doc sweep.

Task 4 gave the builder its first two callers, on `/carrier/<code>`: a **Top routes** table (the
builder used directly, DL touches 1,873 distinct routes over the trailing 12 months) and a **Top
origin airports** table, headed exactly that and never "airports served" — at M6, the pivot had
no either-endpoint filter at all (M6 backlog item 1), so an honest heading was the only fix
available. **M7 Tasks 1-3 built that filter (`endpoint_airport_id`), and the heading is still
"Top origin airports" today, for a different reason**: the dimension is `filter_only`, so
`render.ts`/`pipeline.py` both reject it as a GROUP BY (grouping by it would put one segment row
in both its origin's group and its dest's group and double-count on summing) — it can narrow a
query to one fixed airport (which is exactly how `/airport/<code>` uses it) but not rank many
airports, which requires grouping BY airport. The table's own footer states this
(`app/src/app/carrier/[code]/page.tsx`). Full account: this file's own M4d section, "M6 Task 4 gave this page
its Top-N builder's first two callers."

### Task 5 — the four preset queries, and a bug Task 5 shipped and Task 6 found

`sql/03_queries/watch_gauge.sql`, `watch_empty_planes.sql`, `watch_new_routes.sql`,
`watch_death_watch.sql` each read `mart_route_health`, excluding same-airport rows
(`route_key_low <> route_key_high` — 71 of 8,080) throughout. `watch_gauge.sql` is the one
preset with two directions (Upgauging / Downgauging, same query sorted oppositely on
`gauge_delta`); its `{{DIRECTION}}` token is substituted from a closed two-value set
(`"ASC"`/`"DESC"`, chosen by looking up the requesting preset's own `directions` registry entry
in `lib/watch.ts` — never a value bound into `ORDER BY`, which DuckDB has no bound-parameter form
for). `watch_death_watch.sql` orders `health_score ASC NULLS LAST` — **currently a no-op**, not
load-bearing: its `WHERE health_score IS NOT NULL` already excludes every NULL before `ORDER BY`
runs (verified byte-identical output with the clause present or removed), so there is nothing
left for `NULLS FIRST` vs. `NULLS LAST` to arbitrate. It is retained as forward defense for a
future variant that relaxes the `WHERE` clause (e.g. showing unscored routes sorted last instead
of dropping them), the same "documentation, not the load-bearing mechanism, kept anyway"
treatment this file already gives `p12_months_present`'s CASE guard.

**Task 5 shipped `runPreset()`'s `{{DIRECTION}}` substitution broken for the one preset it
exists for, and its own tests could not have caught it.** `maskComments`'s first draft only
stripped `--` line comments before counting `{{DIRECTION}}` occurrences — and
`watch_gauge.sql`'s own header comment *names* the token, which is a second textual occurrence.
Every call to `runPreset("gauge", ...)`, either direction, threw `"expected at most one
{{DIRECTION}} token, found 2"` unconditionally. Task 5's own `watch.test.ts` never exercised the
"gauge" slug — only Empty Planes' and Death Watch's `runPreset()` paths, neither of which carries
the token at all. Found live, wiring up the page, in Task 6; fixed by masking comments before
counting, not by editing the SQL. Task 6's own review round hardened `maskComments` further —
block comments and string-literal-embedded comment markers, the identical failure shape one
syntax variant away from recurring, closed even though no shipped `watch_*.sql` file uses either
today.

**The route-ordering trap is unit-tested, not smoke-covered, and that is a property of the data,
not a gap in the gate.** `routeCellHref` (used for each preset row's route link) wraps
`routeHrefFromCodes` rather than re-deriving the canonical ordering a third time (M5 Task 3
already built one copy for `/explore`, M4b another for `/route` itself). Watch rows arrive in
**airport-ID order** (`route_key_low, route_key_high`) while `/route/<pair>` is
**code-alphabetical** — the same M4b/M5 trap, over `mart_route_health`'s own population: the two
orderings disagree for **22 of 8,009** rows (`route_key_low <> route_key_high` rows only), not
M5's 154-of-22,420 (a different, larger population — every route pair the warehouse has ever
seen, not just the 8,009 that clear `mart_route_health`'s ≥30-departures floor). `XP USA-LAL` is
the unit fixture (`watch.test.ts`), because **no preset's top 25 contains a disagreeing pair** —
verified against the real warehouse, not assumed — so `app/smoke.sh` cannot reach this class of
bug on `/watch` the way it reaches it on `/explore` (M5's `IFP–IAH` fixture) without hand-picking
a route pair outside any preset's natural ranking, which would test a table `/watch` never
actually renders.

### Task 6 — the page, and Death Watch's NULL contract

`WatchPresetView` (`app/src/app/watch/[preset]/page.tsx`) renders every preset's **components**,
not just the composite (`docs/design/system.md`: "the components are the insight, the score is a
sort key") — `lf_t12`, `lf_delta`, `gauge_t12`, `gauge_delta`, `capacity_delta`,
`frequency_delta`, `completion_factor`, plus the raw trailing-12 seats/departures/quarantine
counts, alongside the labeled-as-heuristic health score. A NULL score renders as **"insufficient
data,"** never DataTable's usual em-dash: `docs/product/features.md`'s "never render NULL as
unhealthy" requirement forbids it, and in a page whose primary sort is ascending health score, an
em-dash reads as the worst row on the page.

**The NULL branch is the common case on three of four presets, measured against the real
warehouse, not the exception a defensive-code reading would suggest**: Route Birth Tracker is
688 of 688 rows (100%) — by construction, since "new" means `p12_months_present = 0`, i.e. no
prior window exists to diff against, so every row on that page has no score. Gauge Watch is 122
of 7,321; Empty Planes 92 of 4,466. **Route Death Watch is the one preset where the branch is
provably unreachable**, since `watch_death_watch.sql` filters `health_score IS NOT NULL` before a
row ever reaches `runPreset()` — its own page carries a scope note instead ("813 of 8,080 routes
... excluded from this leaderboard entirely, never silently ranked worst").

Both floors specific to a preset, not the mart, are stated on the page rather than left implicit:
`gauge_t12 >= 50` (Empty Planes, Death Watch — the CRJ-200's seat count, a real airframe
boundary) and the same-airport exclusion (all four). Task 6's review round added an end-to-end
test rendering the real Route Birth Tracker preset (nothing before it exercised the real
column-building path against 100%-NULL data), verified by two mutants: pointing the score column
at the raw `health_score` field, and reverting `formatHealthScore`'s NULL branch to an em-dash —
both turn it red.

### Task 7 — routing, cache and crawl

`proxy.ts`'s matcher grows from nine entries (M5) to **eleven**: `/watch` (exact path, same
shape as `/search`) and `/watch/:preset` (dynamic segment, shaped like an `ENTITY_ROUTES` row but
with no row of its own — its cacheability branch answers "known" from the static `PRESETS`
registry, not a per-slug `resolve()`). **Cacheability is the allow-list AND the health probe,
not either alone**: the preset set is static, so the allow-list can answer "is this a real page"
with no database read, but every preset page still runs a `mart_route_health` query, and this
file still has to commit to a `Cache-Control` header before that page runs. A slug allow-list
with no probe would stamp `HTML_CACHE` on a page about to 500 — the exact bug M5's own final
whole-branch review found on `/sitemap.xml` (unconditional `PROJECT_CACHE`, no probe, justified
by "it takes no user input" even though `app/sitemap.ts` runs four DuckDB queries that throw by
design). `/watch`'s branch reuses `isDataLayerHealthy()` unchanged — **and Task 8 found that
reuse is not sufficient for every failure mode**, below.

`/sitemap.xml` grows from 23,689 to **23,694** URLs: `/watch` plus its four presets, dated by the
dataset's own `asOf` month rather than a per-entity last-filed month (`watchEntries()`'s own
header: a dataset-wide leaderboard has no per-entity filing date to anchor to — there is no
"Gauge Watch's own last-filed month," only the warehouse's).

### Task 8 — the served-build gate, a residual-gap finding, and the close-out

`app/smoke.sh` gained one section per preset (`/watch`, `/watch/gauge`, `/watch/empty-planes`,
`/watch/new-routes`, `/watch/death-watch`) following the same five-things-in-order discipline
§§8-12's own header comment states for the four entity pages — renders, `Cache-Control`, a real
code vs. a bare id, the rank column — plus Gauge Watch's own falsifiable pair (its two tables
sort oppositely; AS LAX–OGG leads Upgauging, DL BOS–CVG leads Downgauging, each present on its
own side and absent from the other) and the shared `/watch/nope` 404 (names the slug, `no-store`,
never long-cached). **227 checks total (was 183 at M5), +44.**

**Final whole-branch review fix wave** (one Critical, two Important, five Minor — all fixed in
one pass; the ledger and the full report are in
`.superpowers/sdd/2026-07-31-m6-watch-and-topn/`). The Critical was a **false claim on a shipped
page**: `/watch/new-routes` read "First appearance since 2015" about rows that had filed for
years, because `p12_months_present = 0` selects a **re-entry**, not a first appearance — 334 of
688 qualifying rows (48.5%), 17 of the 25 rendered, `MQ AZO–ORD` at 93 distinct months back to
2015-01. Corrected in the frame (`lib/watch.ts`), on the page (`ReEntryNote`, which states the
computed prior-12 window and the measured count), in `watch_new_routes.sql`'s header, in
`docs/product/features.md` § Insight presets and in `docs/design/system.md` § `/watch`
leaderboard; the test that pinned the false phrase was replaced with one asserting the accurate
claim **and** the absence of the false one, both halves mutant-verified.

The two Important findings were **reachability and copy**: `/watch` had zero inbound internal
links (fixed by `TopBar`'s `nav.nav` plus a front-door paragraph — `features.md` § the links
outside the tables), and the index's own frame still called the presets "four saved Explorer
queries", M6's own headline correction left standing in the one sentence a visitor reads. The
Minors: the 23,689 → 23,694 sweep's fourth and fifth copies (§ Task 5 above and
`sitemap.test.ts`), Empty Planes disclosing only one of its two floors (`DeparturesFloorNote`,
`t12_departures_performed >= 360`), `.frame` and `.watch-list` having no CSS rule at all, the
`health_score` column's left-aligned `td.id` becoming a *declared* rather than undeclared
deviation, and a stale five-component docstring in `pipeline/tests/test_route_health.py`.
`app/smoke.sh` gained 8 checks for the served-build halves of these — 235 total.

**Re-review of that wave found one new defect of the same class, plus one vacuous needle.** The
wave's own copy stated the wrong **grain**: `mart_route_health` is one row per
`(op_airline_id, route)`, so `p12_months_present = 0` says nothing about the other carriers on
that airport pair, and both the carried-over frame clause ("nobody flew last year") and the new
`ReEntryNote` ("A route qualifies by…") claimed otherwise. Measured: **521 of 688 (75.7%) and
25 of the 25 rendered** had another carrier flying the pair inside the prior window — `AS HNL–ITO`
leads the page while HA, UA and WN filed 1,787,347 seats on it, 4.9× its own trailing 12. Fixed
in the frame, `ReEntryNote`, `watch_new_routes.sql`'s header, `features.md` and `system.md`, with
a new test (`states the carrier-route grain, never route grain`) and three mutants. The vacuous
needle: `check … "$BODY" 'href="/watch"'` against `/` could not fail, because `/` renders
`TopBar` and `TopBar` emits that href — deleting the front-door prose link left it green. Now
bounded to `<main>` via `between()`, with a paired `check_not` proving the bound still excludes
the top bar and a `check` proving the wordmark needle is live at all. `ReEntryNote` also stopped
saying "this database carries no lookback" (false — `fct_route_month` spans 2015-01 onward, and
is what both measurements were taken from); the limitation is `mart_route_health`'s.
**241 checks total.**

Two traps found writing these needles, both the same class M4c already shipped once:

- **The rank column's negative check cannot be a bare `check_not ... '>0</td>'`.** Measured on
  the served build, `t12_quarantined_rows` legitimately renders bare `"0"` for an unquarantined
  row (`<td class="num">0</td>`, several per page) — a plain substring check red-flags a
  *correct* table on its own data. The fix scopes the negative check to the rank `<td>`
  specifically (`check_not_re ... '<td[^>]*rank[^>]*>0</td>'`), the same discipline that already
  distinguishes a real needle from a vacuous one everywhere else in this file.
- **The 404's slug needle has to span the RSC flight payload's own string-escaping**, the same
  way `/route`'s `ZZZZ-LAX` 404 check already does: `{slug}`'s JSX interpolation splits the
  sentence into separate flight-payload string fragments (`"preset ‘\",\"nope\",\"’"`), so a
  needle written as one contiguous phrase never matches. Verified by mutation, not assumed: with
  `/watch/:preset` removed from the matcher (Mutant A, below), this exact needle goes red because
  the only surviving occurrence of `"nope"` is the router-state echo, not the composed sentence —
  confirming the needle actually discriminates the two.

**The two served-build mutants, run against a real served build and reverted before commit:**

- **Mutant A — `/watch/:preset` removed from the matcher, rebuilt, served.** `/watch/nope`'s 404
  body drops from 9,941 bytes (naming the preset) to 7,816 (a bare error shell, in the same range
  M4d measured — ~7,740 bytes — for the identical failure one page family over), because
  `not-found.tsx` throws without the pathname header the proxy no longer sets. **A page that
  renders fine is damaged too**: `/watch/gauge`'s own `Cache-Control` degrades from `HTML_CACHE`
  to Next's own force-dynamic fallback, `private, no-cache, no-store, max-age=0,
  must-revalidate` — losing correct caching on a healthy page, the exact M4b-shaped bug this
  file's matcher discipline exists to catch a second time. This closes the gap M5's own
  whole-branch review left explicit in `hosting.md`: "unit-verified only, not yet smoke-curled" —
  `proxy.test.ts` calls `proxy()` directly and never crosses Next's routing layer, so this class
  of regression was provably invisible to every gate except a served build.
- **Mutant B — a database copy missing `mart_route_health` (not `meta_pivot_dimensions`),
  served against `/watch/gauge`.** **This is a genuine finding, not a restatement of the brief's
  first-draft expectation**, which assumed the response would come back *without* a cacheable
  header. Measured instead: `isDataLayerHealthy()` calls `loadAllowlist()` alone
  (`catalog_dimensions.sql`/`catalog_measures.sql` — `meta_pivot_dimensions`/
  `meta_pivot_measures`), which `mart_route_health` has nothing to do with, so the proxy commits
  to `HTML_CACHE` before `WatchPresetView`'s `runPreset()` ever runs against the broken table —
  and the page then throws. **`/watch/gauge` 500s WITH the cacheable `HTML_CACHE` header, not
  without one.** Confirmed as the narrow cause, not guessed: dropping `meta_pivot_dimensions`
  *instead* (leaving `mart_route_health` intact) correctly 500s under `no-store` — the same probe
  that closes the gap for `/explore` closes it here too, for the one failure mode it actually
  covers. This is CLAUDE.md's already-documented, not-yet-closed **residual 5xx cache gap** (a
  page-specific throw whose proxy resolution already succeeded), now shown to reach `/watch/gauge`
  too, not only the four entity pages. `app/smoke.sh` asserts the real, measured behaviour — a
  cacheable 500 — as a known-open gap, not something this task closes: closing it would mean
  giving `isDataLayerHealthy()` a `mart_route_health`-specific probe of its own, the identical
  extra-DB-round-trip-per-request tradeoff `/route`'s own gap (`hosting.md` § "The gap") was left
  open rather than pay.

`make goldens` left `sql/03_queries/goldens/` byte-identical — no task touched a pivot template,
which is the property Tasks 3/4's "adds no SQL" claim rests on. `make check` is **461** (447 at
M5 + 6 Task 1 + 0 net Task 1's review round + 5 Task 2 + 1 Task 2's review round's sixth test +
2 Task 5 = 461 — not the 460 a first pass at this arithmetic gets by counting only Task 2's
initial commit). `make app-check` is **671** (664 through Task 8, +7 from the final review's fix wave and its re-review), and `make app-smoke` **241 checks**. `make verify` stays `parquet: 17 artifacts
byte-identical`, `database: 10 objects identical` — M6 touched mart *content* (the composite
formula) but not the object count.

## M7 — maps, and the either-endpoint filter they need first

Backlog item 1 from M6: `/airport/<code>` assembles "this airport at either end" from THREE
pivots and inclusion-exclusion because the pivot layer could not express an OR across two
columns. The plan is `.superpowers/sdd/2026-08-01-m7-maps/`.

### Task 1 — the filter-only endpoint dimension enters the catalog

`endpoint_airport_id` joins `meta_pivot_dimensions` as `column_expr = 'origin_airport_id,
dest_airport_id'`, `filter_only = TRUE`, `filter_mode = 'either'`. `route` gains the same
`filter_mode` column, `'pair'`, so the two composite dimensions that share a column count are
distinguishable by what they compile to. No emitted SQL changed (`make goldens`: zero diff) —
Task 1 only extends the catalog's shape; Task 2 is what makes either mode compile. Full account:
`docs/data/model.md`.

### Task 2 — `either` filter semantics and `filter_only` rejection, in lockstep

Two behaviors, added to `app/src/lib/pivot/render.ts` and `pipeline/pivot.py` in the same task so
`make goldens` proves them byte-identical rather than trusting two hand-written implementations
to agree:

1. **A filter on an `either`-mode dimension compiles to an OR across both its columns**, sharing
   one parameter list between both `IN`s — `(origin_airport_id IN ($f0_0, $f0_1) OR
   dest_airport_id IN ($f0_0, $f0_1))`. This is what a future `/airport` can run as ONE pivot
   instead of M4d's three-pivot inclusion-exclusion assembly: same-airport rows satisfy both
   sides of the OR and are counted once, which is exactly what the third inclusion-exclusion
   term existed to achieve arithmetically.
2. **A `filter_only` dimension used as a *grouping* dimension is rejected**, not silently
   accepted — `dimension 'endpoint_airport_id' cannot be grouped by; it is filter-only`.
   Grouping by it would put one segment row (ORD→LAX) into both the ORD group and the LAX
   group, so summing the column double-counts every row it touches. `validateDimension` /
   `_validate_dimension` grew a `forGrouping`/`for_grouping` parameter, `True` only at the
   dimension-list call site, `False` (the default) at the filter call site — the ONE function
   that already validates both a dimension key and every filter key stays that way.

**The sharpest risk was the `either` branch swallowing `pair`.** `route` and
`endpoint_airport_id` both span two columns, but they mean opposite things: `route` is ONE route
pair (`least()`/`greatest()` equality), `endpoint_airport_id` is two alternatives (OR). Both
renderers branch on `filterMode`/`filter_mode`, never on column count, before falling through to
the `pair` branch — a route filter compiled as an OR would match same-airport rows again and
reopen the measured 18,895-seat inflation on JFK-LAX that `pair`'s own `least()`/`greatest()`
rendering exists to prevent. Mutant 4 (below) pins this branch condition directly, not merely the
`either` output.

Two new goldens (`filter_either_endpoint_airport`, `..._multiple`), 11 → 13 cases;
`urlstate.json` is unchanged — an `either` filter's URL encoding is identical to every other
dimension's, so the codec needed no new case. Four mutants run and reverted, each against the
real warehouse or the fixture allowlist, never merely re-read:

| # | Mutation | Gate | Test(s) reddened |
|---|---|---|---|
| 1 | Delete the `either` branch from `render.ts` only | `npm test -- render` | The 2 golden-comparison tests (`filter_either_endpoint_airport[_multiple]`) plus the 2 hand-written either-filter tests — the golden fixture itself is what catches the one-sided TS/Python drift, since `pipeline/pivot.py` still emits the OR and the committed golden still pins it |
| 2 | Emit `AND` instead of `OR` across the two columns | `npm test -- render` | The same 4 tests — the OR-specific substring assertion in each |
| 3 | Remove the `forGrouping`/`filter_only` check | `npm test -- render` | `rejects a filter-only dimension used as a grouping dimension` (exactly one) |
| 4 | Set `route`'s `filter_mode` to `'either'` in `300_meta_pivot_dimensions.sql`, `make build` | `pytest pipeline/tests/test_pivot.py -k route`, then (corrected re-run) full `make check` and `make app-check` | See correction below — the original claim here ("only the Python test... TS is blind to this one") was FALSE and has been retracted |

**Correction, first review round: the mutant-4 claim above was wrong, and wrong in a way this
project's culture treats as its own defect class — an unverified assertion about test
coverage, written into permanent documentation.** The original report ran only `pytest
pipeline/tests/test_pivot.py -k route` (Python, scoped) and `npm test -- render` (TypeScript,
scoped to one file), and concluded from that narrow slice that "the TS suite is blind to this
mutant" because `render.test.ts`'s allowlist is a hardcoded fixture. That conclusion did not
follow from the evidence gathered — a scoped run cannot support a claim about the whole
suite's coverage. Re-run properly (full `make check`, full `make app-check`, mutation
verified present in both the SQL file and the rebuilt `upgauge.duckdb` immediately before each
run): **`app/src/lib/db.test.ts` reddens on two tests** — `reads filterOnly and filterMode from
the catalog by name, not a default` (asserts `route`'s `filterMode` is `'pair'` directly) and
`allowlist.fixture.ts stays in sync with the real catalog > matches meta_pivot_dimensions and
meta_pivot_measures exactly` (the live-vs-fixture equality Important 2 of the whole-branch
review added) — because `db.ts`'s `loadAllowlist()` reads the real catalog, unlike
`render.test.ts`'s hardcoded `FIXTURE`. **The corrected statement:** `render.test.ts`'s own
unit tests are fixture-based and do not couple to the catalog, but `db.test.ts`'s fixture-sync
test does, so the catalog change IS covered on the TypeScript side — just not by the file the
original report happened to run. The blast radius under this mutation is far larger than
either test file alone: every page and route handler that filters on `route` in practice now
routes through the `either`/OR branch instead of `pair`'s `least()`/`greatest()`, and 30 more
tests redden across `src/app/explore/page.test.tsx` (4), `src/app/route/[pair]/page.test.tsx`
(20), `src/lib/chart/aircraftMix.test.ts` (5), and `src/app/api/pivot/route.test.ts` (1) — 32
TypeScript tests total, not zero. (A further 12 failures appeared in
`src/app/airport/[code]/endpoints.test.ts` in the same run, from a concurrent, unrelated
in-progress refactor of `endpoints.ts` missing `unionSides`/`unionMix` exports — confirmed
unrelated by their `TypeError: ... is not a function` shape, nothing to do with `route`'s
`filter_mode`, and excluded from this count.) Mutation reverted and rebuild re-verified clean
before this correction was written.

`make check` **472** (464 measured immediately after Task 1, before this task's own tests existed
+ 4 hand-written `test_pivot.py` tests + 4 from the 2 new golden cases, each of which adds 2
parametrized `test_pivot_goldens.py` cases — reconciled against the actual `pytest` count at each
step, not assumed, since this file's own arithmetic for M6 was wrong on a first pass). TS:
`render.test.ts` went 34 → 40 (+4 hand-written either/pair tests, +2 golden-loop — the TS golden
comparison runs ONE test per case, unlike Python's two, so 13 − 11 = 2 new cases add only 2 TS
tests against Python's 4). `make app-check`'s repo-wide total moved 688 → 694 across this task's
own gate runs, but that +6 is NOT Task 2's delta — a concurrent M7 task landed its own new test
file in the same window; Task 2's own isolated contribution to that total is the +6 in
`render.test.ts` above. `make goldens` leaves `urlstate.json` byte-identical; `pivot.json` gains
exactly the two new cases above (11 → 13).

### Task 3 — `/airport` collapses from six pivots to two

The task Tasks 1-2 existed to license, and the highest-risk one in the milestone: it deletes
working, tested arithmetic (`inclusionExclusion`/`unionSides`/`unionMix`, plus the `partial`
flag threaded through every call site of it, `app/src/app/airport/[code]/endpoints.ts`) and
replaces it with a different query that has to reproduce the exact numbers the old one
committed.

**The gate, run before anything else changed.**
`pipeline/tests/test_airport_endpoints_real_data.py` (new, warehouse-coupled) renders a segment
pivot filtered on `endpoint_airport_id` for SEA (`airport_id` 14747) over the trailing 12
months (2025-05..2026-04) directly through `pipeline.pivot.render_pivot` — no TypeScript
involved yet — and asserts the seat total is **53,373,806**, the figure `endpoints.ts` has
committed since M4d. A second test proves the third term the old inclusion-exclusion needed is
now unnecessary: the naive `origin_airport_id` total plus the naive `dest_airport_id` total is
**53,386,452** (the exact double-counted figure `docs/data/invariants.md` records for the naive
two-half sum), and the gap between that and the either-filter's own total is exactly **12,646**
seats — the 18 same-airport (`origin = dest`) rows at SEA. Both tests **passed immediately**,
not after Step 3's TypeScript rewrite: Tasks 1-2 already proved the filter itself correct, so
this task's own risk is entirely in what `endpoints.ts` does with it, not in the filter.

**The one thing SQL still can't do for this page: say which end is "the other one."**
`endpoint_airport_id` is `filter_only` (Task 2), so it can appear in a filter but not in
`dimensions` — grouping by it would put one segment row into both the origin's group and the
dest's group and double-count the measure. So the single pivot groups by the two REAL columns
instead — `(op_airline_id, origin_airport_id, dest_airport_id)` — and a small TypeScript
function, `otherEndpoint`, reads each returned row and picks whichever column is NOT the subject
airport (or the airport itself, when both columns are it — the same-airport case). This is the
one piece of logic Task 3 still owns; everything else the old three-pivot assembly did (the OR,
the same-airport de-duplication) SQL now does on its own, inside one `GROUP BY`.

**A property that made the collapse safe to reason about**: neither `carrierRows` nor
`airportTotals` (the table and the stat strip) needed to change AT ALL. Both already summed or
`Set()`-ed over however many `EndpointRow`s they were handed, so it was never load-bearing that
the old union pre-folded each route's two directions (and the same-airport case) into one row
per `(carrier, endpoint)` before those functions ran. The new pivot returns MORE rows per
`(carrier, endpoint)` pair than the old union did (both directions of a route are now separate
rows, since the query groups by real `origin`/`dest` columns rather than a pre-folded "other
endpoint"), and the totals come out identical either way — proven by `page.test.tsx`'s full,
warehouse-backed render of `/airport/SEA`, which passed unmodified (163 tests across every
entity page, same run).

**Row-count consequence, re-measured rather than assumed.** The new single-pivot query is NOT
the same query the old "per side" / "union" figures described: the old union collapsed each
route's two directions into one row before Task 3 (via its own key function); the new pivot
keeps them separate, because it groups by real `origin`/`dest` columns rather than a derived
"other endpoint." Checked against the 25 busiest airports by trailing-12 segment-row count, not
assumed from ORD alone: the traffic query (`AIRPORT_ENDPOINT_LIMIT = 5000`) produces **1,732**
groups at ORD (was 879 origin / 855 dest / 959 union under the old mechanism) and 666 at SEA;
5,000 clears the new worst case 2.9x. The chart's mix query is unaffected in this respect — its
grain, `(year_month, aircraft_type)`, never carried a direction — so ORD's figure is unchanged
at **4,118**, matching the old union exactly.

**Mutants (all three from the plan, run against the real warehouse, reverted after each):**

| # | Mutation | Where | Result | Reverted |
|---|---|---|---|---|
| 1 | Filter on `origin_airport_id` instead of `endpoint_airport_id` | `test_airport_endpoints_real_data.py`'s own query (proving the SEA gate is sensitive to the filter choice) | `test_either_endpoint_filter_reproduces_the_committed_sea_figures` red at **26,710,000** | yes |
| 1b | Same mutation applied to the SHIPPED `airportTrafficQuery` in `endpoints.ts` | production code | 4 tests in `page.test.tsx` red, all showing 26,710,000 in place of 53,373,806/43,896,637/82.24%/26,091,482 | yes |
| 2 | `OR` → `AND` in `pipeline/pivot.py`'s `either`-mode branch (Task 2's own code, verified here from the consumer side) | `pipeline/pivot.py` | Both SEA tests red — the AND collapses the filter to just the origin=dest intersection, reading 12,646 (the overlap alone) | yes |
| 3 | Duplicate the same-airport contribution: replace the either-filter total with the naive `origin + dest` sum, inline in the test | `test_airport_endpoints_real_data.py` | `test_either_endpoint_filter_reproduces_the_committed_sea_figures` red at **53,386,452** | yes |

Mutant 1b is not one of the plan's three but was run anyway: mutants 1-3 as briefed exercise the
Python reference implementation and the new pipeline test, not the shipped TypeScript file
Task 3 actually rewrote. Confirming the same wrong number (26,710,000) surfaces through
`page.test.tsx` when `endpoints.ts`'s own query is mutated closes that gap.

**Deleted from `endpoints.test.ts`: 9 tests, all exercising `inclusionExclusion`/`unionSides`/
`unionMix`,** functions that no longer exist — `counts an arrival-only filing`, `sums the two
directions of one route`, `counts a same-airport filing ONCE`, `refuses an overlap row it never
saw`, `skips an overlap row a truncated side no longer carries`, `still subtracts a full overlap
row`, `skips an overlap CELL a truncated mix side`, `still refuses an unexplained overlap cell`,
`applies the same arithmetic to the chart's cells`. **Added: 5** — 4 for `otherEndpoint`'s
per-row derivation (departure, arrival, same-airport, and "both directions stay separate rows")
plus 1 pinning `airportTrafficQuery`'s filter and dimension shape. **Kept unchanged, only prose
retitled** (no assertion or fixture touched): the 3 warehouse-backed `fetchAirportMix` tests and
the 5 `carrierRows`/`airportTotals` aggregation tests — neither function's inputs or contract
changed. Net: 17 → 13 tests in this file.

`page.tsx`'s truncation-disclosure copy lost its "on each side" / "on at least one side"
phrasing (there is only one side now) and its carrier-endpoint description became
carrier-origin-destination, matching the new query's actual grouping; the rendered numbers and
every other line of copy are untouched.

`make test` 472 → **474** (the 2 new warehouse tests, both confirmed PASSED not skipped).
`make check` clean. `make app-check`: 718 tests green at the time of this task's own final run,
typecheck and lint clean — the repo-wide total is not this task's delta alone (concurrent M7
tasks landed their own test files in the same window, the established caveat this section
inherits from Task 2's own account above). `make goldens` untouched (`sql/03_queries/goldens/`
byte-identical — this task added no pivot SQL). `make app-smoke`: **241 checks**, unchanged from
M6 Task 8 (Task 3 is a refactor of what a page computes FROM, not what `smoke.sh` checks for),
all green, including the served-bytes assertion `airport: counts BOTH endpoints, not just
departures` against the literal string `53,373,806` curled from a real, built, served
`/airport/SEA`. Entity-page byte weights ticked up a few hundred bytes across ALL FOUR entity
pages (not only `/airport`) between the M6 baseline and this run — most plausibly the Task 1-2
catalog growth (`endpoint_airport_id` and `route`'s new `filter_mode` column) flowing into every
page's embedded allowlist, not this task's own change; not isolated further, flagged for the
reviewer.

### Task 4 — composite Albers with five panels and antimeridian normalization

The projection every later task in this milestone renders through (`app/src/lib/map/
albers.ts`), ported from the committed design mockup (`docs/design/mockups/map-network.html`)
with its math kept **verbatim** and two panels added. The mockup shipped three panels (`us`,
`ak`, `hi`) and two region tests written in lower-48-centric terms — the exact shape of bug
this project's own "measure before shipping a spec's arithmetic" rule exists to catch:
`docs/data/invariants.md` § Airport coordinates measured **six fact-present airports east of
the antimeridian** (GUM, UAM, ROP, TIQ, SPN, all ~144-146°E, plus Alaska's own SYA/Shemya at
+174.11°) and the mockup's `lon < -150 && lat < 30` Hawai'i test independently catching
American Samoa (14.3°S) and Midway (28.2°N) — stretching a panel meant to span Hawai'i's own
2.3° of latitude across 42°.

**The fix is two-part, and neither half alone closes the gap.** (1) `normalizeLon` (`lon > 0 ?
lon - 360 : lon`) runs at every call site that decides a panel, never only inside one shared
helper — SYA's raw +174.11° fails every western-hemisphere test unless it is normalized to
-185.89° first, and a helper that normalized internally but was skipped by one caller would
silently misfile it. (2) Two new panels, tested **before** `hi` rather than folded into it:
`pac` (Guam/Saipan/Tinian/Rota, American Samoa, Midway) and `car` (Puerto Rico, the USVI) —
`regionOf`'s own ordering is `pac`, `car`, `hi`, `ak`, `us` last as the unconditional fallback,
most-specific first, because `us`'s test is unconditional and would swallow every point before
a more specific panel ever ran if it came first (a real mutant, not a hypothetical — reversing
the order is one of the mutants below).

**`fitPanels` fits each panel to only the points that land in it, independently** — same-scale-
per-panel, not one global scale across all five — and the returned `Map` **omits any panel
with zero points**: most airports never touch `pac` or `car`, and a page must not draw a
labelled empty inset frame for a panel nothing in its own network reaches. `project()` falls
back to the `us` panel's fit and parameters when a point's own panel has no fit at all (a lone
Alaska or Hawai'i destination on an otherwise conterminous network), mirroring the mockup's own
`FIT[rg]||FIT.us` fallback so projection is a total function, never a throw.

**Raw Albers grows northward; screen `y` grows downward.** `albersRaw` negates the `y` term
for exactly this reason — asserting that two projected points are merely *present* cannot
catch an unnegated axis, since both projections still produce valid-looking numbers; only
their *relative order* (does a point known to be north of another render with a smaller `y`)
catches it, which is why `albers.test.ts` asserts ordering, not presence, for this property.

Ten tests (`albers.test.ts`): `normalizeLon` on and off the antimeridian, `regionOf`'s five
panels including the two-test discriminators above, `fitPanels` omitting an empty panel,
`project`'s `us`-fallback, and the y-negation ordering property. Mutants run and reverted: (1)
delete `normalizeLon`'s conditional (reddens the SYA/GUM antimeridian tests), (2) reorder
`regionOf` to test `us` first (reddens every non-`us` panel test — the exact "unconditional
fallback swallows everything" failure the comment above describes), (3) remove the y-negation
(reddens the ordering test, not a presence test). `make app-check` did not yet have a
repo-wide baseline worth quoting at this point in the milestone (three more map tasks landed
in the same window before any gate ran end to end) — see Task 8's own count for the first
post-map-milestone total. `make goldens` untouched — no pivot SQL.

### Task 5 — great-circle interpolation with an adaptive step count

Pure spherical math (`app/src/lib/map/greatCircle.ts`), ported from the same mockup script,
kept deliberately independent of `albers.ts` — this module must never import a projection,
because interpolation happens on the unit sphere and projection is something the *caller*
applies afterward to whichever points come out. `greatCircle(a, b, steps)` slerps `steps + 1`
points from `a` to `b`; a great circle between two points at equal latitude bows **poleward**
of the straight line between them, which is the entire reason to interpolate on the sphere
rather than lerp `(lat, lon)` directly — a lerp would cut the corner.

**The degenerate-endpoint guard exists for a case this module cannot rule out by itself.**
`om < 1e-9` (coincident or antipodal-adjacent endpoints) would otherwise divide by
`sin(om) = 0` and propagate `NaN` into every one of the `steps + 1` points. Same-airport rows
are excluded upstream by Task 6's `renderNetworkMap` before this function is ever called on
one — but 359 of 1,045 fact-present airports carry at least one same-airport row (`docs/data/
invariants.md` § Route identity), so this function stays safe regardless of what calls it
rather than trusting every future caller to have already filtered.

**Step count scales with screen distance, not angular distance** (`stepsFor`,
`round(projectedLengthPx / 22)`, floored at 4, capped at 48) — a 40px hop needs a handful of
points and a transcontinental arc needs dozens, but "transcontinental" is a property of how
far apart the two points land **on the canvas**, not how far apart they are on the globe: two
points can be far apart in degrees and close together in the panel they both happen to share.
Cap 48 and floor 4 are the mockup's own constants, kept verbatim; `PX_PER_STEP = 22` is new.
The comment this constant used to carry claimed the adaptive scheme cost 132,178 bytes on
ORD against a flat-48's 192,231 — a number computed before Task 8 wired the real page and
never re-measured once it existed. Re-measured against the real served page (M7 Task 10):
adaptive costs **64,287** bytes, not 132,178, and a flat 12 (previously claimed to save more,
77,384) actually costs **77,572** — *more* than adaptive, not less, because most of ORD's 267
arcs are short regional hops that adaptive floors at 4 steps, cheaper than a flat 12 across
the board, while the long-haul minority never reaches the 48 cap at all on a 960px-wide
canvas (a transcontinental arc projects to ~700px, `round(700/22) = 32`). The corrected
figures live in `greatCircle.ts`'s own comment and in Task 8's account below, which is where
the real page's measurement belongs.

Six tests (`greatCircle.test.ts`): the poleward bow (a midpoint's latitude exceeds both
endpoints'), the degenerate-endpoint guard (no `NaN` in the output), `stepsFor`'s floor, cap,
and linear region. Mutants run and reverted: removing the `om < 1e-9` guard (reddens the
degenerate-endpoint test with `NaN` assertions, not a crash — the function still returns an
array, just one full of `NaN`), and removing the `Math.max`/`Math.min` clamps in `stepsFor`
(reddens the floor and cap tests independently, proving each bound is load-bearing on its
own). `make goldens` untouched — no pivot SQL.

### Task 6 — arc encoding, draw order, and the composed SVG string

Two files. `arcs.ts` is pure encoding — one destination's seats, departures, and load factor
in, one stroke out, no rendering: width `0.7 + 2.9·√(seats/max)` (the mockup's own formula,
seats scale width and nothing else), dash `"5 3"` when load factor is below 70% **and** the
arc clears the departure floor, and a complete override below the **30-departure floor**
(fixed 1px, dotted `"1 3"`, `--ink-3`, opacity 0.75) that consults load factor at all — a
floor arc's own story is "barely flown," and dashing it too would try to draw two independent
facts through one channel. `loadFactor === null` (no departures to divide by) is treated as
*not low* rather than low or high — there is no evidence either way, the same "unknown is not
zero" rule `docs/data/invariants.md` states for gauge generally. Colour is never the sole
channel for anything here (CLAUDE.md) — every stroke is one of two CSS variables (`--ink`,
`--ink-3`), never a hue, so `globals.css` stays the one source of truth the way it already
does for M4c's chart ramp.

**`arcOrder` is an ordering property, not a filter — CLAUDE.md's own standing warning names
this exact shape of bug.** Ascending by seats (tiebroken on code, for determinism across
identical-seat arcs) so the caller draws thinnest first and heaviest last, meaning heavy arcs
sit visually on top of thin ones. The SET of stroke widths produced is identical whether or
not this sort runs — a test asserting the set rather than the sequence would stay green under
a dropped sort, exactly the M4c stack-order mutant CLAUDE.md already documents. `networkMap.
test.ts`'s draw-order test therefore reads `stroke-width` values off the rendered markup **in
the order they appear**, not as a set.

`networkMap.ts` composes `albers.ts` (Task 4) and `greatCircle.ts` (Task 5) into one function,
`renderNetworkMap`, returning a complete `<svg>…</svg>` string — no chart or map library
anywhere in the path, the same "in the served HTML, visible with JS off" property M4c's chart
established. Draw order (itself part of the contract, since a set-based test cannot catch a
misordering): inset frames for panels the network actually reaches → the injected basemap, if
any (an optional input, never an import — Task 7 wires it with no change here) → arcs in
`arcOrder` → destination nodes → labels for the top 8 by seats → the origin marker → the
window line and the same-airport-seats note.

**Same-airport rows are excluded from the drawn arc set here, never upstream, and never
relying on the caller to have already filtered** — a same-airport great circle has zero
angular length, and `greatCircle`'s degenerate branch (Task 5) would emit `steps + 1`
identical points, several hundred bytes drawing an invisible mark on top of the origin disc.
Their seats are **not** dropped from the total — `sameAirportSeats` is a separate field the
caller supplies, never derived from the already-filtered arc list, so a map that dropped these
seats from its own stated total as well as its arcs would silently disagree with the stat
strip on the same page. Both halves are required; shipping one without the other is a defect
(`docs/design/system.md` § Arc encoding states this as a standing rule, not a one-off note).

**An arc crossing a panel boundary cannot be a great circle** — the projection is discontinuous
across panels — so `renderNetworkMap` draws it as a straight two-point line into the inset
instead, rather than attempting to interpolate across a boundary that has no continuous
mapping.

Draw-order and encoding tests bring `networkMap.test.ts` to a substantial suite by the time
Task 8 extends it further (see that task's own count); nine tests in `arcs.test.ts` cover the
width formula, the dash threshold, the floor override, the `loadFactor === null` non-dashing
case, and `arcOrder`'s tiebreak. Mutants run and reverted: removing `arcOrder`'s sort (reddens
the sequence-reading draw-order test, not a set-based one — the property this task's own
brief called out as the one a naive test would miss), and drawing a same-airport row as an arc
instead of excluding it (reddens the "268 vs 267" polyline-count property, the same class of
assertion Task 10's own smoke check later pins on a served build). `make goldens` untouched —
no pivot SQL.

### Task 7 — the pre-projected basemap, generated reproducibly

`/airport/<code>`'s network map (Task 6) draws arcs over a coastline and state-outline
basemap. That basemap is a **committed, pre-projected artifact**
(`app/src/lib/map/basemapPaths.generated.ts`), not a runtime fetch and not a tiled layer —
this project bans tiled basemaps outright on cost grounds (`docs/design/system.md` § The
map), and `make verify` must build offline and reproducibly, which a network fetch at build
time cannot be.

**Input, committed rather than fetched at build time**: `app/geo/ne_110m_us.json`, Natural
Earth 1:110m Cultural Vectors, Admin 1 — States, Provinces, fetched as GeoJSON from the
`nvkelso/natural-earth-vector` mirror
(`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_1_states_provinces.geojson`,
same 1:110m vintage as Natural Earth's own shapefile release), filtered to the 51 US
features (`iso_a2 == 'US'`: 50 states + DC), properties trimmed to `name`/`postal`,
coordinates rounded to 3 decimals (~110m, matching source resolution). Natural Earth is
public domain. **Fetched once, filtered, and committed** — the same discipline this project
already applies to its Parquet writer (`threads = 1`, since an intermittently-drifting
writer is worse than a consistent one): a build step that reaches the network cannot be
part of a reproducibility proof.

**Natural Earth 1:110m has no separate Admin-1 entry for Guam/Saipan/Tinian/Rota/American
Samoa/Midway (the `pac` panel) or Puerto Rico/the USVI (`car`)** — at this scale those
territories don't resolve as distinct polygons, so the generated basemap carries coastline
for `us`/`ak`/`hi` only (49/1/1 `<path>` elements respectively; `pac`/`car` are empty
strings). This is a real, disclosed limitation, not a bug: `albers.ts`'s `project()`
already falls back to the `us` panel's fit when a point's own panel has no fit, so an
airport reaching into the Pacific or Caribbean still projects correctly — its arc simply
has no coastline drawn under it.

**The generator (`app/scripts/build-basemap.mjs`) imports the app's own `albers.ts`
(`project`, `fitPanels`, `normalizeLon`, `regionOf`) rather than reimplementing the
projection** — the same rule that keeps `sql/` shared between the pipeline and the server
applies here: a basemap projected by separate math from the arcs would be subtly,
invisibly misaligned. Node's built-in TypeScript type-stripping (unflagged since Node 23.6)
imports the `.ts` file directly, since `albers.ts` uses only erasable syntax; `make basemap`
runs `node --no-warnings` to suppress the one cosmetic warning that import produces
(`app/package.json` has no `"type": "module"`, which is out of this task's scope to add).

**The basemap is fitted to fixed panel rectangles, not to the subject's arcs** — the whole
reason it needs its own generation step rather than being computed inline by whatever page
renders it: fitting it to one page's own arc endpoints would scale and offset it
differently on every page, so the coastline would visibly shift under a fixed set of state
outlines from one airport to the next. `fitPanels` (Task 4) already accepts any
`GeoPoint[]`; the fixed-ness is a property of *what* the generator passes it, not a new
parameter on `albers.ts`. The generator fits every panel to `BASEMAP_FIT_POINTS` — every
raw coordinate in the committed geography (2,366 points), i.e. the full extent of each
state's own landmass — and bakes the resulting screen coordinates directly into
`basemapPaths.generated.ts`; `basemapPathsFor(panels)` takes no points at all; there is no
per-call fit, so the coastline provably cannot move between pages. `BASEMAP_FIT_POINTS` is
re-exported from `basemap.ts` so a per-page network map can align to the coastline it draws
arcs over.

**This is where an earlier revision of this section stated the wrong rule, in bold, as
standing guidance — corrected here rather than left for a reader to hit the true account 60
lines below in Task 8.** The wrong rule was: call `fitPanels([...BASEMAP_FIT_POINTS,
...subjectPoints])`, unioning the subject's own arc endpoints into the fixed reference set
before fitting. That is NOT equivalent to reusing the fit, and it is wrong for exactly the
reason Task 8 found and fixed (below): `fitPanels` derives its scale from the min/max extent
of whatever points it receives, the coastline's pixels in `basemapPaths.generated.ts` are
already baked in at `fitPanels(BASEMAP_FIT_POINTS)`'s own extent, and a subject point falling
**outside** that extent (the ordinary case — simplification pulls the coastline inward, so a
coastal airport routinely lands seaward of it) changes the extent, which changes the scale for
every point, arcs and the already-baked coastline alike. **The correct, standing rule: for any
panel that has coastline (`us`/`ak`/`hi`, and `car` as of Task 7b), reuse
`fitPanels(BASEMAP_FIT_POINTS)` VERBATIM — identical input, identical output, so the fit is
bit-for-bit the one the artifact was projected with. Never union a subject's points into it.**
Panels with no coastline at all (`pac`, and `car` before Task 7b) have nothing to align to, so
they legitimately fall back to a fit derived from the subject's own points.

The `basemap.test.ts` fixture this section originally cited as proof (SEA, well inside the
conterminous landmass, checking the `us` fit is unchanged whether or not a subject point is
unioned in) was **found vacuous by Task 8**: an in-bounds point can never move the extent
`fitPanels` derives, by construction, so that fixture could not distinguish the correct fit
from the wrong one it was written to catch. Task 8 replaced it with an out-of-bounds subject
(ORD → SEA/JFK vs. ORD → SEA/JFK/MIA, MIA chosen to extend the `us` bbox without changing
panel membership) asserting the origin marker's own screen coordinates are identical across
both queries — which the wrong (union) implementation fails and the correct (verbatim reuse)
implementation passes. Full account: Task 8, below.

**RDP simplification runs on raw (lat, lon) rings, before projection**, at ε = 0.05°
(~5.5 km at the equator) — small enough to keep every state recognizable at the map's
~900×400 px canvas, and it materially shrinks Alaska's and Maine's especially convoluted
coastlines. **GeoJSON rings are closed (first coordinate repeated as the last), which
breaks the textbook Douglas–Peucker chord**: a plain RDP call measuring perpendicular
distance from a ring's own first-to-last chord sees a zero-length chord for every ring, so
the numerator is 0 for every point and the whole ring collapses to its one duplicated
point. This was not caught by a test — it was caught by running the generator once and
reading its own output (every state came out as `M x,y L x,y Z`). The fix
(`rdpRing` in `build-basemap.mjs`) splits each ring at its own midpoint-by-index into two
open polylines sharing two genuinely distinct endpoints, runs ordinary RDP on each, and
splices the results back into a closed ring.

**Byte-stability is proven, not assumed**: `make basemap` run twice (before, and again
after an unrelated lint fix) produced byte-identical output (`sha256sum` matched both
times), and `make verify` now runs `make basemap` and `git diff --exit-code --stat
app/src/lib/map/basemapPaths.generated.ts` after its own double-build proof, failing the
gate on any drift. The mutant the brief names — injecting `Math.random()`-derived jitter
into the coordinate formatter — was run and reverted: it reddened the `git diff
--exit-code` check (exit 1, a 3-line coordinate diff) as claimed; reverting restored exit 0.

`basemap.test.ts` adds 7 tests (the 3 the brief specifies, plus 4 written against the
fixed-reference-points property and the documented `pac`/`car` gap) — a thin-reader test
suite, since the generator's own reproducibility is what the `make verify` gate and the
mutant above prove, not something a unit test re-running the same in-process function could
observe (a byte-diff is a property of two separate `node` invocations). `make goldens`
untouched — this task added no pivot SQL.

**Carried forward, not resolved here**: Task 4's own note that the `pac`/`car`
`PANEL_RECTS` placement is a default, not settled, stands unchanged — this task neither
confirms nor repositions it, since neither panel has any basemap geometry to render inside
its rectangle yet.

### Task 8 — the airport network map renders in the served HTML

Wires Tasks 4-7 onto a real page: `fetchAirportNetwork` (`app/src/lib/map/airportNetwork.ts`,
one route-grain pivot plus a coordinate lookup, `sql/03_queries/map_airport_coords.sql`) and
`NetworkMap.tsx` compose the projection, arc encoding, and basemap into `/airport/<code>`,
mounted above the carriers table. The pivot groups `fct_route_month` by the undirected route
identity (`route_key_low`/`route_key_high`), filtered to rows touching the subject airport at
either end — no carrier dimension, since a network map draws one arc per destination, not one
row per (carrier, destination), so every carrier and every month in the window folds into one
row per route before this file ever sees it. `AIRPORT_NETWORK_LIMIT = 1000` against a measured
worst case of 268 distinct routes at ORD (the database's own ceiling, checked over every
fact-present airport, not assumed from ORD alone) — 3.7× headroom, and `NetworkMapInput`
deliberately carries no truncation field the way `endpoints.ts`'s tables do, so a future
refresh crossing this needs a fresh measurement and a limit raise, not a silent undercount.

**A confirmed defect, found while wiring the first real page, not by inspection.** `networkMap.
ts` (Task 6) originally fit every panel to the subject's own arc endpoints — `fitPanels(points)`
called fresh, per page, on whatever that one airport's network happened to contain. That is a
**different** fit than the one the coastline in `basemapPaths.generated.ts` was baked with
(Task 7's `fitPanels(BASEMAP_FIT_POINTS)`, computed once over the full committed geography), so
every arc rendered scaled and offset relative to a landmass drawn at a different scale —
geographically wrong on every single page, despite passing every existing test, because no
existing test asserted on absolute screen position. **The repo's own written guidance
recommended the wrong fix.** `build-basemap.mjs`'s header, its generated output, and `basemap.
ts` all said a per-page map should call `fitPanels([...BASEMAP_FIT_POINTS, ...subjectPoints])`
— union the subject's points into the fixed reference set before fitting. That is not
equivalent to reusing the fit verbatim: `fitPanels` derives its scale from the min/max extent
of whatever points it receives, the coastline's pixels are already baked in at
`fitPanels(BASEMAP_FIT_POINTS)`'s own extent, and a subject point falling **outside** that
extent (a coastal airport seaward of a simplified coastline — the ordinary case, since
simplification pulls the line inward, not the exception) changes the extent, which changes the
scale for every point, arcs and the already-baked coastline alike. The union recommendation
silently reopens the exact bug it claims to close.

**The fix**: `BASEMAP_FITS`, computed once at module load from `fitPanels(BASEMAP_FIT_POINTS)`
— bit-for-bit the same input Task 7's generator used — is reused **verbatim**, identical input
and output, for any panel it has an entry for (`us`/`ak`/`hi` at the time this task shipped;
`car` joined this set at Task 7b, once real coastline existed for it to align to). Only a panel
with zero committed reference points (`pac` alone, after Task 7b) falls back to a subject-
derived fit, because there is no coastline to align to in the first place. Proven by a test
that projects a fixed point through two different subject point sets and asserts the SAME
screen coordinates both times — a test that fails under the reverted (per-page-fit) code, which
is what makes it a real regression guard rather than a restatement of the fix.

**Measured, not estimated, on the real served page.** `/airport/ORD` renders exactly **267**
polylines (268 trailing-12 destinations minus the excluded same-airport arc). At
`PX_PER_STEP = 22` this costs **64,287** bytes of polyline markup — about half the
pre-implementation estimate the design spec and `greatCircle.ts`'s own comment carried until
Task 10 re-measured and corrected both (see that task's account, and Task 5's above). `pac` and
`car` reach 6 and 74 fact-present airports respectively over the trailing 12 months at the time
this task shipped (before Task 7b gave `car` real coastline) — `/airport/SJU` is the real page
where the Caribbean inset visibly mattered, drawing 65 arcs inside a labelled frame with no
landmass under it until Task 7b's fix.

Test additions: `airportNetwork.test.ts` (8 tests — `farEndpoints`'s subject-relative
direction, the query shape, truncation absence at the measured ceiling), `NetworkMap.test.tsx`
(7 tests — the component mounts the SVG, supplies `basemapPaths` for exactly the panels its
own network reaches, and renders the `pac`-empty caption only when warranted), plus 30 lines
of additional coverage in `networkMap.test.ts` for the `BASEMAP_FITS` reuse property above and
`basemap.test.ts` gaining the export `basemap.ts` needed to expose `BASEMAP_FIT_POINTS` to
`networkMap.ts` in the first place. `page.tsx` mounts `<NetworkMap network={network} />` above
`DataTable`, conditioned on `fetchAirportNetwork` returning non-null (a subject with nothing
filed in the window gets no map at all, never a second empty-state panel repeating what the
carriers-table empty state already says below it — the same "gaps are gaps" discipline M4c's
chart established).

`make app-check` first crosses a full-suite total worth quoting after four map tasks landed in
the same window: this task's own final run measured 718 (see Task 3's account for the same
caveat about attributing a repo-wide delta to one task when several land close together).
`make app-smoke` **unaffected by this task directly** — Task 9 is the one that adds the first
`app/smoke.sh` coverage of the map at all (that task's own account says so explicitly: "Tasks
1-8 added none to this file"), which is itself a real gap this milestone's own Task 10 later
closes with a dedicated map section. `make goldens` untouched — this task added no pivot SQL,
only `sql/03_queries/map_airport_coords.sql`, a plain lookup outside the pivot template
contract.

### Task 9 — the year parameter, its cache key, and the track

`/airport/<code>` (Task 8) drew one network: the trailing 12 months, matching the carriers
table above it. Task 9 adds `?y=<year>`, selecting one calendar year's network instead — a
track of year links under the map, `app/src/lib/year.ts` + `app/src/app/airport/[code]/
page.tsx`. **Links, not the animated slider `docs/design/system.md` originally specified** —
superseded on measurement: this map is server-rendered SVG with no client charting library
(Tasks 4-8), so animating means shipping every year's geometry at once. ORD's arcs alone are
~64,287 bytes for ONE year (Task 8); twelve years would be roughly a megabyte, doubled again
because this project's charts ship twice per response. One server-rendered permalink per year
fits the project's own growth mechanic instead — `docs/design/system.md` § "The year track" has
the full account, corrected from "the year slider."

**The sharpest part of this task is the cache key, not the map.** `proxy.ts` decides
`Cache-Control` before the page runs, keyed on the full URL, so `?y=<anything>` would mint a
distinct shared-cache entry per value if left unvalidated — the same cache-fill shape `/search`'s
`q` already has. `y` differs from `q` in exactly the respect that matters: its legitimate value
set is CLOSED (the calendar years this dataset covers), which is what licenses *validating* it
instead of `/search`'s blanket `no-store` — `lib/year.ts`'s `parseYear` rejects anything outside
`[2015, new Date().getUTCFullYear()]` structurally, with no database read, so a well-formed year
stays as cacheable as the airport page always was and proxy.ts's cacheability predicate becomes
`entity resolves AND parseYear(y).kind !== "invalid"` — an AND of two allow-lists, never a
negation, the same discipline `isCacheable` already enforces for the slug half. Full account,
including why the upper bound is wall-clock time rather than a hardcoded `2026`:
`docs/architecture/hosting.md` § "`y` on `/airport/:code`".

**`/airport` came back OUT of `proxy.ts`'s `ENTITY_ROUTES` table** — the same reason `/watch`
was never in it: its cacheability question (a second input, `y`, on top of the slug) no longer
fits that table's one-resolver shape, so it is its own `if` branch, run before the loop. The
matcher entry is unchanged; only which mechanism answers for it moved.

**2026 is a partial year, and the track says so.** The data window ends 2026-04, so 2015-2025
are complete calendar years and 2026 carries four months. `yearTrack(asOf)` derives both the
year set and the partial flag from `dataAsOf()` rather than a hardcoded 2015-2026, so a future
rebuild extends the track with no code change; the track's own footnote names the exact month
(`"2026 is a partial year — filed through April 2026 only."`), the same class of disclosure
M6's "First appearance since 2015" correction made standing policy. An out-of-range or malformed
`y` renders a named error — `unknown year '1999' — this dataset covers 2015-2026` — never a
silent fallback to the default view, mirroring `/explore`'s own invalid-permalink contract
exactly.

Three mutants (`lib/year.ts`, `proxy.ts`), run and reverted, `git status` clean after each:
`parseYear`'s range check removed (reddens both the boundary tests in `year.test.ts` and
`proxy.test.ts`'s out-of-range test), the `/airport` branch forced to unconditional `no-store`
(reddens `proxy.test.ts`'s "still caches a valid year" — the pair's other half, so a
`no-store`-everywhere implementation cannot pass both vacuously), and `yearTrack` marking every
year complete (reddens `year.test.ts`'s 2026-vs-2025 test). `make app-check` 764 (was ~688 at
Task 2's own count, moved by five concurrent M7 tasks' own tests since); `make app-smoke` +11
checks over the airport section (Tasks 1-8 added none to this file, so this task is also the
first `app/smoke.sh` coverage the milestone's map work has received). `make goldens` untouched —
this task added no pivot SQL.

### Task 7b — the `car` panel gets real coastline, added mid-milestone on measured evidence

Not a briefed task — added after Task 8/9 shipped, once the served pages made the gap visible:
Natural Earth 1:110m (Task 7's own input) has **no polygon at all** for Puerto Rico, the USVI,
Guam/CNMI, American Samoa, or Midway. Measured against the real warehouse, trailing 12 months:
**74 of 1,045 fact-present airports reach the `car` panel**, 6 reach `pac`; `/airport/SJU` drew
65 arcs inside a labelled "CARIBBEAN" frame with no landmass under it — San Juan is a major
airport, not an edge case. The owner's decision: fetch a finer subset for `car` only; leave
`pac` disclosed-empty rather than doing the same work for 6 airports.

**Checked both 1:50m and the existing 1:110m before choosing** — 1:110m's own Admin-0-countries
file (not Admin-1 states/provinces, which has no PR/USVI entry at any resolution up to 1:10m,
confirmed) already carries a lone 9-point "Puerto Rico" polygon but no separate USVI feature at
all. 1:50m Admin-0 Countries is the first resolution with **both** as real, multi-island
features: Puerto Rico 69 points (main island + Vieques + Culebra), USVI 19 points (St. Thomas +
St. Croix + St. John). Committed as `app/geo/ne_50m_car.json` (10,258 bytes), filtered to
`SOVEREIGNT == 'United States of America'` AND `NAME in ('Puerto Rico', 'U.S. Virgin Is.')` — 2
features, properties trimmed to `name`/`postal` (`PR`/`VI`) matching `ne_110m_us.json`'s own
schema, coordinates rounded to 4 decimals (~11m, finer than `ne_110m_us.json`'s 3, reflecting
the finer source per that file's own "matching source resolution" convention). British Virgin
Is. (`SOVEREIGNT == 'United Kingdom'`) is excluded — same neighborhood, outside this dataset's
US-only scope.

**`build-basemap.mjs` gained a second input, not a second code path.** It now reads both
`ne_110m_us.json` and `ne_50m_car.json`, concatenates their features BEFORE the existing
postal-code sort (so output order depends only on postal code, never on which file a feature
came from), and runs the unchanged sort → `rdpRing` simplify → `fitPanels`/`project` pipeline
over the merged set. `regionOf` classifies PR/USVI into `car` the same way it classifies every
other feature — no special-cased assignment. `pac` is untouched: still zero committed reference
points, a deliberate scope line (6 airports vs. `car`'s 74), and still a real, disclosed
limitation rather than a bug — `project()`'s `us`-fit fallback still renders every `pac` arc
correctly, it simply has no coastline under it.

**Artifact grew from 98,654 to 102,557 bytes** (+3,903). Byte-stability re-proven the same way
Task 7 proved it originally: `make basemap` run twice produced identical
`sha256sum` output both times, and `git diff --exit-code --stat
app/src/lib/map/basemapPaths.generated.ts` against the staged artifact exits 0.

**Served-build verification, not just a unit test**: built, served on a local port, and curled
`/airport/SJU` directly — 204,459 bytes of HTML on **10 lines** (this page is effectively one
line per response half, body + RSC payload — `grep -c`/`wc -l` would count *lines*, not
occurrences, and silently under- or over-count; `grep -o <needle> | wc -l` was used instead
throughout). `data-panel="car"` occurs 2 times (once per response half), `data-name="PR"` and
`data-name="VI"` each once per half, and PR's own `d` attribute is a real 245-character
multi-subpath string (three closed rings — main island, Vieques, Culebra — not a collapsed
single point). `/airport/HNL` (reaches `pac`, not `car`) was curled the same way and confirmed
the new caption (below) renders exactly there and nowhere on `/airport/SEA` (reaches neither).

**`PANEL_RECTS.car` (`albers.ts`) was widened, the first time there was real geometry to check
it against.** Measured PR+USVI's combined raw-Albers extent under `car`'s own projection
parameters: `dx=0.0557`, `dy=0.0143`, aspect **~3.89:1**. The original rect (100×76px, aspect
1.32:1) forced `fitPanels`'s `k = min(w/dx, h/dy)` to bind on width, so the coastline filled the
rect's width but only ~26px of its 76px height — a thin horizontal sliver in a mostly-empty
labelled box, not wrong but misleading. Widened to 296×76px (296 = 76 × 3.89, rounded), so both
dimensions bind together; height unchanged (392–468, matching `hi`/`pac`) to keep the bottom
inset row's shared baseline. `networkMap.ts`'s `INSET_RECTS.car` (the frame-drawing literal,
intentionally duplicated from `albers.ts` rather than imported — Task 6's own design) was
updated in lockstep; the two tables drifting would mean the drawn frame border no longer
matches the rectangle the coastline was fit to.

**The `pac` gap is now the only one, and it is disclosed on the page itself, not only in code
comments.** `NetworkMap.tsx` renders a `.foot` caption — "The Pacific inset has no coastline
under its arcs…" — whenever a network's own points reach `pac`, derived from
`basemapPathsFor(["pac"]) === ""` rather than hardcoded, so the caption retires itself
automatically the day `pac` gains geometry. Verified on both sides: present on `/airport/HNL`
(reaches `pac`), absent on `/airport/SEA` (reaches neither `pac` nor `car`) and on
`/airport/SJU` (reaches `car`, which now has coastline, but not `pac`).

**Geometry mutant, same shape as Task 7's own**: `rdpRing` was reverted to plain `rdp` on the
closed ring directly (collapsing every ring to one repeated point). Both the pre-existing VA
test and the new Puerto Rico test went red for the reason each names (`expected 0 to be greater
than 20` / `10`); reverted, `make basemap` + `sha256sum` confirmed byte-identical to the
pre-mutant artifact, and `git status` clean afterward.

`make app-check` **773** (768 before this task, +5: two `basemap.test.ts` geometry/emission
tests, three `NetworkMap.test.tsx` tests covering the `car` coastline and the `pac` caption's
presence/absence). `make app-smoke` unaffected (this task's own verification ran outside the
committed smoke suite, against a manually served build, per the task brief — no new
`smoke.sh` section was added). `make goldens` untouched — no pivot SQL. `make verify` not run
(per instruction, reserved for the milestone's own final task); `make basemap`'s zero-diff
check against the staged artifact is the narrower proof this task ran directly.

### Task 10 — the served-build gate, and M7 closed out

Closeout: `app/smoke.sh` coverage for the map, the served-build mutants only a real build can
produce, the full gate suite, and a documentation truth pass over every stale figure the
milestone's own review loop had surfaced.

**`app/smoke.sh` gained a network-map section on `/airport/ORD`** — the milestone's own worst
case, chosen because it is the page that would first show a truncation or a rendering blow-up
if one existed. Nine checks: the map's own `<svg>` (anchored on its fixed `viewBox="0 0 960
500"`, not the bare `<svg role="img">` M4c's chart check uses, since that bare form also
matches the aircraft-mix chart mounted on the same page and the per-row sparkline in
`DataTable`), exactly **267** `<polyline>` elements via `count`, not `has` (268 would mean the
same-airport arc was drawn after all — the seats stay in the stated total either way, only the
polyline is excluded), an inset label, the year track's `href="/airport/ORD?y=2019"`, the
window stated in words, and the `?y=2019`/`?y=nonsense` Cache-Control pair repeated against
ORD specifically (the existing Task 9 checks only ever curled SEA, so a regression scoped to
the map's own data fetch could have left every SEA check green). **The polyline count needed
`grep -c`'s known failure mode named explicitly**: Next 16 emits this page as effectively one
line per response half, so `grep -c` returns 1 (lines), not 267 (occurrences) — `grep -o …|
wc -l` is what this file already uses everywhere else for exactly this reason, restated here
because two agents on this milestone independently hit it.

**A property worth recording, found while writing the polyline count check, not asserted going
in**: this map's `<svg>` is injected via `dangerouslySetInnerHTML` as one pre-serialized
string, and Next's RSC flight payload re-encodes that string's own `<` as `<` before
embedding its copy — so `<polyline` occurs **exactly once per real polyline in the whole
response**, not doubled the way M4c's chart-path checks are (a normal JSX-rendered SVG ships
once in the HTML body and again, unescaped, in the RSC payload). A doubled-count assumption
carried over from the chart checks would have asserted 534 here and failed against the real
build.

**Every new needle was mutation-run, not merely read** (five in one combined rebuild — the
SVG attribute order, the same-airport filter, the inset label text, the window sentence, and
the year-track `href` param name; a second rebuild for the proxy cache-logic pair and the
year-error text, inverted together): all seven reddened for the reason each was written to
catch, confirmed against a served build, then reverted with a clean `git diff`.

**The matcher-removal mutant (Step 4), one-off and not added permanently** — removing
`/airport/:code` from `proxy.ts`'s matcher, rebuilding and serving reproduced M4d's own
finding on the map-bearing page specifically: a healthy `/airport/ORD` degrades from
`HTML_CACHE` to Next's own `private, no-cache, no-store, max-age=0, must-revalidate` fallback,
and `/airport/ZZZZ`'s 404 loses its entire message (7,861 bytes, zero occurrences of "unknown
airport code" — down from a message-bearing 404 the healthy build serves). Reverted; this is a
regression check on existing (M4d-era) matcher discipline, not a new class of bug the map
introduced, which is why it is recorded here rather than added as a permanent `smoke.sh`
section the way the next finding is.

**The 5xx cache gap reaches the map path too, and IS added as a permanent gap-check section
(17), mirroring M5 Task 7 Part A's and M6 Task 8's own** — because, unlike the matcher mutant
above, this is a live database-corruption shape reachable in production, not a deliberate code
regression. Serving against a database copy whose `dim_airport` view is missing **only** its
`lat`/`lon` columns (not the whole view, and not the whole table — dropping either would also
break `resolveAirportCode`/`airportCodesExist`, both of which query `dim_airport` too, and
`isCacheable` already declines the cache on ANY failure there, which would reproduce the
already-handled case rather than the gap) leaves slug resolution, and therefore `proxy.ts`'s
cacheability decision, completely healthy — `isCacheable` commits to `HTML_CACHE` before
`fetchAirportNetwork`'s own query ever runs, and only then does it throw inside the page.
Measured: **500, WITH the cacheable `HTML_CACHE` header**, not without one — confirmed scoped
correctly by curling `/route/JFK-LAX` under the identical broken copy and getting a healthy
200, since that page resolves airport codes through the same view but never reads their
coordinates. `isDataLayerHealthy()` only ever probes `loadAllowlist()`
(`meta_pivot_dimensions`/`meta_pivot_measures`); it has never had anything to do with
`dim_airport`'s coordinates, so this is not a regression Task 8 introduced — it is CLAUDE.md's
already-documented residual 5xx cache gap (backlog item 3), now confirmed to reach a third
distinct cause (the four entity pages generally, `/watch/gauge` specifically via M6 Task 8,
and now the map on `/airport/<code>` specifically via a third, different table). Not fixed
here — `docs/architecture/hosting.md` § "The gap" has the full account of why the complete fix
isn't reachable on this Next version.

**Two comment-only corrections found and fixed alongside the smoke.sh work, before `make
verify` ran** (routed in mid-task, since fixing one regenerates the basemap artifact `make
verify` proves reproducible): Task 7b gave the `car` panel real coastline, which means
`BASEMAP_FIT_POINTS` (built from the generator's own reference points) now includes PR/USVI
points too, and `BASEMAP_FITS` therefore has a real `car` entry — but two comments describing
*why* the subject-derived fallback exists (`networkMap.ts`'s own header, and the template
literal `build-basemap.mjs` writes into `basemapPaths.generated.ts`'s header) still said the
fallback covered "pac/car" and that committed fits existed only for "us/ak/hi." Corrected in
both places to say `car` is covered by `BASEMAP_FITS` as of Task 7b and `pac` is the only
panel still falling back — the code itself needed no change, since `fits.set(panel,
BASEMAP_FITS.get(panel) ?? subjectFits.get(panel)!)` is already generic over which panels
`BASEMAP_FITS` happens to cover. `make basemap` was re-run after the fix; the regenerated
artifact changed **only** in that header comment (verified with a diff before staging), and a
second run produced a byte-identical file to the first, confirming the fix didn't disturb
reproducibility. A third, unrelated stale comment was found the same way while re-measuring
Task 5's own step-count figures: `greatCircle.ts`'s `stepsFor` comment carried the same
pre-Task-8 estimate (132,178 bytes) the design spec did, corrected in the same pass with the
real, re-measured numbers (see Task 5's account above and this task's own re-measurement
below).

**The design spec's arc-byte target was wrong, and the cause is understood, not merely
observed.** `docs/superpowers/specs/2026-08-01-m7-maps-design.md` (git-ignored — a planning
artifact, not a tracked doc, so its own text is left as-is rather than edited) predicted
132,178 bytes of polyline for ORD; the real, measured figure — on the actual served page, at
this project's real 960px-wide composite-Albers canvas — is **64,287**. A transcontinental arc
projects to only ~700px on a 960px-wide canvas, so `stepsFor`'s adaptive scheme
(`round(700/22) ≈ 32`) never reaches its own 48-step cap at all; the spec's prediction appears
to have assumed a wider effective canvas (or an unprojected, synthetic distance) under which
long arcs commonly hit the cap. Re-measured directly, not merely re-derived: a flat 48 costs
189,274 bytes on the real page (close to, but not identical to, the spec's own 192,231 —
warehouse content has shifted slightly since); a flat 12 costs 77,572 — **more** than the real
adaptive figure, not less as both the spec and the pre-existing `greatCircle.ts` comment
claimed, because most of ORD's 267 drawn arcs are short regional hops that adaptive floors at
4 steps, cheaper across the board than a flat 12, while only the long-haul minority ever
approaches the cap. Real, measured `/airport/ORD` page weight at M7's close: **360,473
bytes** — the milestone's own worst case, 3× `/route/JFK-LAX`'s 98,832, driven by two pivots
(traffic + mix, unchanged from M4d/M7 Task 3) plus the third, the network-map query, none of
which existed on this page before M7.

**Every other page-weight figure `CLAUDE.md` carried from M5/M6 was checked against the real
build rather than assumed unchanged, and one was found wrong by roughly 2×** (`/carrier/DL`:
documented 131,316, measured **262,697** — the M6 Task 4 Top-N tables (Top routes, Top origin
airports) landing in the same window that figure was last written, never reflected in the
prose afterward). The four M7-touched entity pages grew substantially from the map, not from
anything wrong: `/airport/SEA` 122,152 → **277,711**, `/airport/ATL` 133,959 → **300,876**,
`/airport/ORD` 143,427 → **360,473** (all M7 Tasks 3-9's own combined effect — the six-pivot-
to-two collapse in Task 3 shrinks the query count while the map in Tasks 4-9 adds a third
pivot and the SVG itself, netting a large increase). Pages the map never touches moved only by
the M7 catalog growth flowing into every page's embedded allowlist (Task 3's own flagged, not
fully isolated, observation): `/route/JFK-LAX` 98,459 → **98,832**, `/aircraft/B737-8`
105,358 → **105,799**, `/search?q=Portland` 10,715 → **10,908**. `CLAUDE.md`'s own Status
section carries the corrected table.

**Final gates, run strictly serialized** (this box's 8 GB / 12-core ceiling hardlocks under
two concurrent `make` targets — `docs/dev-box-8gb-memory-ceiling.md`), each preceded by a wait
for no other `make`/`next build`/`next start`/`vitest`/`pytest` process: `make check` **474**
passed, ruff clean; `make app-check` **773** passed, typecheck and lint clean; `make app-smoke`
**265** checks, 0 failures (was 241 at M6 close; M7 Tasks 1-9 already landed some of the delta,
this task's own new sections — nine map checks plus three in gap-check section 17 — account
for the last 12); `make verify` — **its first real execution against the basemap
extension** (Task 7 wrote the Makefile change but was expressly forbidden from running it) —
reports `parquet: 17 artifacts byte-identical` and `database: 10 objects identical`, and the
basemap regeneration inside it produced zero diff against the staged, corrected artifact;
`make goldens` leaves `sql/03_queries/goldens/` byte-identical (M7 added no pivot SQL beyond
Task 2's own committed goldens — `urlstate.json` unchanged across the entire milestone, as
Task 2's own account already established). `git status` confirmed clean of every mutation
before this account was written.

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

> **Migrated from `.python-version` + a planned `.nvmrc` on 2026-07-30.** Two pinning
> mechanisms for two runtimes was already one too many before Node arrived. The interpreter
> changed with it — from uv's own CPython 3.12.12 build to mise's — so `make verify` was
> re-run on the new one before the migration was committed. See the reproducibility section
> above for the result.

**`check` excludes `fmt`, and the tree is not format-clean.** It runs `ruff check` and
`pytest`, never `ruff format`. Measured at the end of M3a: `ruff format --check .` reports
**8 of 47 files would be reformatted**. So the first person to run `make fmt` gets a large
diff across files their change never touched, mixed into whatever they were actually doing.
Two clean ways out, neither taken yet: reformat once in a commit that does nothing else and
add `ruff format --check` to `check` so the gate holds from then on, or decide formatting
stays unenforced and delete `fmt`. The bad middle is reformatting only the files a change
already touches — that smears the same diff across every future commit instead of isolating
it in one.

**There is no CI. `make check` on a developer's machine is the only gate that exists.**
Several docs (including this one, above) say "runs in CI" about `pipeline/` — that is the
intended deployment shape, not current state. The consequence is not theoretical: the
real-data invariant layer (`test_invariants_against_real_data.py`) skips itself when
`data/raw/` is empty, which is right for a fresh clone but means those rules go dark
everywhere except a machine holding the full 2015–2026 window — today, exactly one. A green
`420 passed` from a clone without data is a materially weaker claim than the same number
here, and nothing in the output says so. Standing up CI is M6-shaped; see
[data/invariants.md](../data/invariants.md#where-these-are-enforced).

**Node is pinned at 24.13.0 in `mise.toml`** — LTS since 2025-10, and the Next.js scaffolded
in M3b Task 2 is v16, which needs ≥ 20.9. This supersedes the earlier plan to add a
`.nvmrc`: a second pinning mechanism alongside `.python-version` was the thing worth
avoiding, and mise removes both.

**`make app-check` (typecheck + `vitest run`) is the app's gate, the way `make check` is
`pipeline/`'s.** M3b Task 2 scaffolded `app/` — Next.js 16 (App Router, TS, Tailwind v4,
ESLint), `@duckdb/node-api` for the route handlers, Vitest for tests — via `create-next-app`
under the pinned Node, with `NPM ?= $(MISE) npm --prefix app` following the same `mise exec`
indirection as `UV`. No application code yet: `make app-check` at scaffold time typechecks
clean and Vitest correctly reports "no test files found" — a real failure until the first
test lands (M3b Task 4), not a broken gate.

Docker is not needed until M6. When it arrives, the image installs the same pinned versions
and sets `MISE=` so `make` calls the tools directly rather than shelling through mise.

> 🔔 **The cron must fail loudly.** If the monthly ingest breaks, nothing errors — the site
> keeps serving happily and `DATA AS OF` just quietly stops advancing. For a product whose
> entire credibility is that badge, silently serving stale data while claiming freshness is
> the worst failure mode available. Alert when `max(year_month)` hasn't moved in ~45 days,
> and surface staleness in the UI, not only in a log.
