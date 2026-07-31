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
**Maps:** deck.gl + MapLibre + Natural Earth GeoJSON.

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
`mart_leaderboards` is deferred to M5: which leaderboards exist is an editorial `/watch`
decision, and they are all saved instances of a generic Top-N builder that M3 has not built
yet. Building them now means guessing the presets twice.

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
moved. See `CLAUDE.md`'s Status section for the current test counts and what M4c+ still owe
(`/airport`, `/carrier`, `/aircraft`, the charts, the maps, `/watch`) — `/route` is the M4b
section immediately below.

## M4b — the route page

`/route/<pair>` is the first entity page: `/route/JFK-LAX` is a saved pivot query (segment
grain, grouped by operating carrier, filtered to one undirected route) composed on top of the
same pivot layer M3/M4a already built, deliberately reusing `DataTable` / `LegendRail` and
the resolution layer rather than writing bespoke SQL. That reuse is also what makes the
Explorer link free: the page's query *is* a `PivotQuery`, so `encode()` yields the permalink
directly. No chart (that's M4c) and no new dependency.

### Composite-dimension filtering, added in lockstep

The pivot had no way to filter on `route` — a dimension whose `column_expr` names two
columns (`route_key_low`, `route_key_high`) rather than one. The obvious workaround —
`origin_airport_id IN (a,b) AND dest_airport_id IN (a,b)` — is not equivalent to "the route
between a and b": it also matches same-airport filings (`a→a`, `b→b`), which are not a
curiosity — 12,738 of them exist across 530 airports. On JFK–LAX that workaround inflates
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
explicitly, because they disagree for **154 of 22,950 routes (0.7%)**:

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

### The reverse lookup surfaced an `is_latest` gap M4a's own invariant didn't cover

`app/src/lib/resolve.ts`'s `lookupAirportsByCode` (code → `airport_id`, the direction M4a
never needed) is served by `sql/03_queries/lookup_airport_by_code.sql`. `WHERE is_latest`
alone is **not** sufficient to make a code unique: it is scoped per `airport_id`'s own seq
chain, not per code, so two different `airport_id`s sharing a code can each carry their own
`is_latest = TRUE` row. Measured: 36 codes do (`AUS` returns both the real
Austin-Bergstrom and Robert Mueller Municipal, closed since 1999). Task 4's fix round 1
added an `EXISTS`-in-`fct_segment_month` clause, which takes colliding codes from 36 to 0 —
full accounting, including why M4a's own in-window invariant test didn't already catch
this: [`docs/data/invariants.md` § Code collisions](../data/invariants.md#entity-resolution-m4a).

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
