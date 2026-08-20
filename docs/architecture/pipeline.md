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
│   ├── build.py                facts + dims from data/raw/; also `make verify`
│   ├── marts.py                runs sql/02_marts/ in order → upgauge.duckdb
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
**Maps:** **not** deck.gl/MapLibre — a from-scratch, dependency-free, server-rendered SVG
engine (`app/src/lib/map/`), fed by committed, pre-projected Natural Earth GeoJSON. The map
needs the same "in the served HTML, visible with JS off" property the charts have, which a
client-side library cannot give for free.

---

## What this file owns

**The ingest and query layers, not the product surfaces.** Pages, charts and maps are owned by
[`../product/features.md`](../product/features.md) and
[`../design/system.md`](../design/system.md); routing and caching by [`hosting.md`](hosting.md);
data rules by [`../data/invariants.md`](../data/invariants.md) and
[`../data/model.md`](../data/model.md).

Outstanding work lives in [GitHub Issues](https://github.com/UnderMyBed/upguage/issues), not
here.

## Ingest

### The fetcher

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
45 columns for 2015, byte-identical to a manual download, and a cached re-run completing in
0.01 s with no network.

**Prove the acquisition path before building on it.** The endpoint spike ran before anything
else because the endpoint was the one part of the spec that turned out *not* to be as
documented — see [../data/sources.md](../data/sources.md).

### Normalize

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

**Resolve invariants against a real extract before writing them as tests.** Writing an
invariant from assumption is how you get a green suite that is confidently wrong.

## The warehouse catalog

`upgauge.duckdb` is a **hybrid**: facts and dims are views over the Parquet tree, and
`mart_route_health` is the only materialized table. Views keep the byte-identical Parquet gate
covering everything derived-free, and the mart materializes because trailing-12 windowing over
the full window is the one genuinely expensive thing in the layer.

Scope is `fct_route_month`, `dim_city_market`, and `mart_route_health`. **There is no
leaderboards mart**, and nothing should reintroduce one: `/watch`'s four presets
(`sql/03_queries/watch_*.sql`) read `mart_route_health` directly, add no pivot SQL of their own
— no pivot measure expresses a delta between two windows — and share nothing across them
except `DataTable`'s rank column.

### The views

`sql/02_marts/010_fct_segment_month.sql` and the five `02x_dim_*.sql` /
`024_map_mainline_group.sql` files turn the Parquet tree into `make build`'s six database
objects — `fct_segment_month`, `dim_airport`, `dim_city_market`, `dim_carrier`,
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
column are written from the same `year` argument in `normalize_year` — but it is a real
property of this view.

### The mart runner

`pipeline/marts.py` executes `sql/02_marts/*.sql` in filename order — 21 tests in
`pipeline/tests/test_marts.py`. Each file declares its own materialization in a header
directive, so the runner needs no separate manifest to drift:

```sql
-- upgauge: view          (or: table)
-- object: fct_route_month
SELECT ...
```

The runner wraps the body in `CREATE OR REPLACE VIEW <object> AS <body>` or
`CREATE TABLE <object> AS <body>`. That DDL wrapper is the only SQL in Python, and it is the
same shape as `normalize.py`'s already-accepted `COPY (<sql file>) TO ...` — the hard rule is
about *query logic*, which stays in `.sql`.

## Views cannot take bound parameters — so CWD is load-bearing

`CREATE VIEW` captures literal SQL text, so the Parquet root cannot be a `$param` the way every
other path in the pipeline is; it is interpolated at build time. DuckDB resolves relative paths
against the **process CWD, not the database file's directory**, which forces a choice:

- An *absolute* path works in CI and breaks in Docker, because the build machine's
  `/home/runner/...` does not exist in the image. Silently — the file opens fine and every
  query fails on read.
- A *relative* path works anywhere, provided CWD is fixed. So views reference
  `data/parquet/**` relatively, the container sets `WORKDIR /srv/upgauge` with data at
  `/srv/upgauge/data`, and CI builds from the repo root.

A test asserts no absolute path appears in any view definition, because that failure is
invisible until deploy.

**Confirmed empirically, not just by assertion.** With `upgauge.duckdb` built from the repo
root (views referencing `data/parquet/...`), opening that same file **by absolute path** from a
cwd of `/tmp` and querying `fct_segment_month` raises `duckdb.IOException`: `IO Error: No files
found that match the pattern "data/parquet/t100_segment/**/*.parquet"`. The database opens; only
the read fails — which is what makes an absolute path inside a view definition invisible until
deploy.

> ⚠️ **A wrong container `WORKDIR` does NOT produce that failure.** Reaching it needs the
> database opened by *absolute* path while cwd points elsewhere, and `db.ts` never does that:
> `DB_PATH` is anchored on the same `ROOT` as `file_search_path`, so a wrong cwd moves **both**.
> Measured in the same session, same database, cwd `/tmp`: the absolute open succeeds and the
> read fails as above, while the cwd-anchored open fails outright with `IO Error: Cannot open
> database "/tmp/upgauge.duckdb" in read-only mode: database does not exist` — before any query,
> and it never emits the pattern error at all. The read failure needs the *opposite* pairing: a
> **correct** cwd with the Parquet tree absent. Both are measured against the real container as
> `make portability`'s negatives 3 and 1 respectively
> ([hosting.md § The portability test itself](hosting.md#the-portability-test-itself)). A
> healthcheck planned around the read path alone would miss the `WORKDIR` break entirely.

## Reproducibility

`make verify` runs three checks in sequence and fails if any fails:

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

**The `.duckdb` file itself is never hashed.** Measured (see
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

Two things make the guarantee hold at all:

- **`data/raw/` is append-only.** Filenames carry the download date, so a re-fetch adds a
  file instead of overwriting the one that produced published numbers. `latest_raw` feeds the
  build; superseded downloads are audit-only and never read.
- **Parquet writes are pinned to `threads = 1`.** DuckDB's parallel writer is not byte-stable
  (see [../data/invariants.md](../data/invariants.md)). ~8 s cost across the window.

Real run, full 2015–2026 warehouse:

```
$ make warehouse && make verify
parquet: 17 artifacts byte-identical across two builds
parquet: comparing data/parquet (on disk) against a fresh build from data/raw
parquet: data/parquet matches a fresh build from data/raw (17 artifacts)
database: 10 objects identical across two builds
```

## The pivot contract

`/explore`'s query layer is a **contract plus golden fixtures**, not a shared implementation,
and the reason is that `pipeline/` never runs in prod. The Explorer's validator runs **per
request, in the server** — TypeScript. So the validator cannot live in Python, or there would
be two of them, drifting, one of them security-relevant.

| Artifact | Purpose |
|---|---|
| `sql/03_queries/pivot_segment.sql`, `pivot_route.sql` | The templates. `{{TOKENS}}` for identifiers, `$params` for values. |
| `sql/02_marts/300_meta_pivot_dimensions.sql`, `301_meta_pivot_measures.sql` | The allowlist, **as catalog objects** — the server already opens the database, so there is no extra artifact to ship and `make build` regenerates it. |
| `sql/03_queries/catalog_dimensions.sql`, `catalog_measures.sql`, `data_as_of.sql` | The reads of those catalog objects (and the freshness stamp), **as `.sql` files** rather than string literals, so the server's TypeScript reads the identical files. |
| `sql/03_queries/goldens/pivot.json` | Golden fixtures: query state → expected SQL/params. The TypeScript renderer must reproduce them byte-for-byte. One validator semantics, two runtimes, proven to agree. |
| `sql/03_queries/goldens/urlstate.json` | Golden fixtures: URL round-trips — the permalink contract. Includes `filter_value_encodeuricomponent_divergence`, pinning that Python's `quote(v, safe="")` percent-encodes `! * ' ( )` while JS's `encodeURIComponent` does not: a naive TS port using the JS default passes every other golden and still diverges (119 `unique_carrier_code` values carry BTS's `(1)` suffix; 163 airport names carry an apostrophe). |
| Python reference implementation (`pipeline/pivot.py`, `pipeline/urlstate.py`) | Legitimately in `pipeline/`: it *generates and verifies* the goldens in CI and never serves a request. |

The allowlist is **curated, not introspected** — which dimensions we offer is a product
decision, not a schema fact. A test cross-checks it against `duckdb_columns()` so a renamed
column fails loudly instead of silently dropping a dimension.

Consequence to accept knowingly: `make verify` covers a product decision (the Explorer's
vocabulary), not only data. That is the price of the allowlist being un-driftable.

### Only identifiers are substituted, and only after allowlist validation

Values are always bound `$params`. Identifiers — the dimension list, the `GROUP BY`, the sort
column — are substituted, and only ever from the validated allowlist, never from request input.
Same shape as the catalog views' `{{PARQUET_ROOT}}`.

The alternative considered and rejected was a fully static template with no substitution at
all, `CASE WHEN $by_carrier THEN op_airline_id END` per dimension. It makes injection
structurally impossible and needs no allowlist, which is philosophically closer to "can't
average what doesn't exist" — but it defeats the partition pruning the catalog layer fought to
restore, and dynamic sort and Top-N each need their own contortion. Rejected on those grounds,
not on readability.

## Entity resolution

The pivot returns raw catalog ids (`19790`, `14747`, `612`). Resolution turns them into `DL`,
`SEA`, `B737-7` at render time.

### Why resolution runs after the pivot, not inside the templates

`meta_pivot_dimensions`' `join_dim`/`join_key` columns exist for exactly this join, and joining
`dim_carrier`/`dim_airport` straight into `pivot_segment.sql` / `pivot_route.sql` is the design
that was rejected. Doing so would change what the pivot templates emit, which reopens the
contract above: every golden regenerates, and `pipeline/pivot.py` and the TypeScript renderer
have to change in lockstep or silently drift. Resolution is a display concern, not a reason to
reopen a contract that is verifiable in two languages.

Instead, resolution is a separate query stage that runs **after** `runPivot()` returns, keyed
on the ids actually present in the returned page (at most `n` rows). `app/src/lib/resolve.ts`
collects the distinct ids per resolvable column (`collectIds`), issues one bound query per
dimension **present in the result** — not one per dimension in the catalog — and returns a
`Map<resolutionKey, {code, name}>` that the page merges in at render time. The pivot SQL, the
codec, and every golden are untouched; the id stays on the row for sorting, filtering and the
permalink. Cost: one extra small indexed lookup per dimension present, against an in-process
DuckDB with no network hop — accepted for keeping the contract frozen.

`make goldens` reproduces every golden byte-identical, and that is the proof that matters. The
counts are asserted in the suites rather than written here — `render.test.ts` and
`urlstate.test.ts` each open with a fixture-sanity check, so a truncated or reshaped fixture file
reddens instead of silently emitting zero tests.

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
  Returning `dim_aircraft_type.code` would just re-render `'612'` — the exact thing resolution
  exists to remove — so `code` in the resolver's output is actually `short_name`
  (`B737-7`), not the BTS code, playing the role `carrier_code` plays for carriers. `id`
  stays `VARCHAR`: CLAUDE.md's zero-padded-code rule applies to the join key here too.

`resolve.ts`'s `RESOLVER_FILE` is the only place a dimension's `join_dim` maps to a file
name, and it is keyed on the catalog's own `join_dim` string (`dim_carrier`, `dim_airport`,
…) — never on a dimension's name (`op_airline_id` vs `origin_airport_id` vs
`route_key_low`/`high` all resolve through the same `dim_airport` entry without a
name-based branch anywhere in `collectIds` or `resolveRows`). `route` carries `dim_airport`
in **both** its `join_dim`/`join_key` slots: its `column_expr` names two airport-id columns,
and describing how to resolve them is the metadata's job, not a special case in the resolver.
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
resolver file's header comment describes the placeholder in prose instead of writing it out.

## Composite and either-endpoint dimensions

Two dimensions do not name a single column, and each needs its own compilation rule.

### `route` — a pair, filtered as a pair

The obvious workaround for "filter to the route between a and b" —
`origin_airport_id IN (a,b) AND dest_airport_id IN (a,b)` — is not equivalent: it also matches
same-airport filings (`a→a`, `b→b`), which are not a curiosity. 12,738 of them exist across 530
airports (full window 2015-01 → 2026-04, quarantined rows included;
`docs/data/invariants.md` § Route identity tabulates all four window × quarantine answers). On
JFK–LAX that workaround inflates seats by 18,895 under a `DATA AS OF` badge. Full measurement:
[`docs/data/invariants.md` § Route identity](../data/invariants.md#route-identity).

Real support lives in `app/src/lib/pivot/render.ts` and `pipeline/pivot.py`, which must always
change **in the same commit** — a change to one renderer without the other is exactly the drift
the goldens exist to catch. One filter value encodes one whole route as `"<low-id>-<high-id>"`
(`f=route:12478-12892`), and multiple values still OR together exactly like every other
dimension's IN-list — a positional two-values-make-one-pair convention was rejected because it
would make `f=route:a,b,c` ambiguous. The emitted SQL uses `least`/`greatest` on the pair, never
trusting stored column order:

```sql
(least(route_key_low, route_key_high) = $f0_0a AND greatest(route_key_low, route_key_high) = $f0_0b)
```

Both operands are bound, never interpolated — same discipline as every other filter value.

### `endpoint_airport_id` — filter-only, `filter_mode = 'either'`

Compiles to an OR across both airport columns, which is what lets `/airport/<code>` run **one
pivot per grain** instead of three pivots plus inclusion-exclusion arithmetic. It is
`filter_only`: it can narrow a query to one fixed airport, but it is rejected as a grouping
dimension, because grouping by it would double-count a row into both its origin's and its
dest's group. The catalog row and its two columns are owned by
[`../data/model.md`](../data/model.md).

## Route slugs: two orderings that are not the same thing

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

## Reverse lookups: slug to id

`app/src/lib/resolve.ts`'s `lookupAirportsByCode` (code → `airport_id`) is served by
`sql/03_queries/lookup_airport_by_code.sql`. `WHERE is_latest` alone is **not** sufficient to
make a code unique: it is scoped per `airport_id`'s own seq chain, not per code, so two
different `airport_id`s sharing a code can each carry their own `is_latest = TRUE` row.
Measured: 36 codes do (`AUS` returns both the real Austin-Bergstrom and Robert Mueller
Municipal, closed since 1999). A fact-presence clause takes colliding codes from 36 to 0 — full
accounting in
[`docs/data/invariants.md` § Entity resolution](../data/invariants.md#entity-resolution).

That clause is a hash semi-join, not the correlated `EXISTS` it reads as (43–51 ms → 8 ms),
because `proxy.ts` runs it on every `/route/*` request to decide cacheability. The equivalence
is pinned by `test_reverse_lookup_selects_exactly_the_fact_present_current_airports`, which
diffs the shipped file against the `EXISTS` form over every `is_latest` code — the timings, the
rejected variants and the mutation that fails it are in
[`invariants.md` § Entity resolution](../data/invariants.md) and
[`hosting.md` § What the proxy's query actually costs](hosting.md#what-the-proxys-query-actually-costs).

**The aircraft lookup does not land where the other two do.** `lookup_carrier_by_code.sql`
behaves identically to the airport file: the fact-presence clause is what makes the slug a key
(112 colliding `carrier_code`s unscoped, 0 among the 114 airlines that filed).
`lookup_aircraft_by_name.sql` does not: fact-presence takes colliding `short_name`s from 12 to
**1**, not to 0, because `CE-180` names two BTS codes that *both* really flew. So for aircraft
the fail-loud guard is the entire defence rather than a belt-and-braces backstop, and a
colliding slug throws `AmbiguousCodeError` carrying every candidate id — `/aircraft/CE-180` is a
reachable URL whose page must name both airframes, not pick one. Why no scoping fixes it, why
narrowing to the trailing 12 months would be the worst available "fix", the two surviving
mutants recorded rather than papered over, and the 16 short names that are not URL path
segments:
[`invariants.md` § The other two reverse lookups](../data/invariants.md#the-other-two-reverse-lookups).

## Page composition and truncation

The stat strip's `LOAD FACTOR` and `AVG GAUGE` are computed in TypeScript from the summed
additive measures the same query already returns (`Σ passengers / Σ seats`, `Σ seats / Σ
departures_performed`) — CLAUDE.md's derived-measure rule applied to a page total, not just a
table cell. The carrier limit (50) is a measured guarantee, not a guess: the busiest route
carries 16 distinct operating carriers over a trailing 12 months, 99th percentile 8 — but the
page checks whether the result hit the limit and discloses truncation rather than silently
under-reporting a route's totals if a future refresh ever exceeds it.

## Every guard gets its breaking change observed

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
- All 12 real-data invariant tests had never executed — the module looked for an undated
  filename the append-only scheme makes impossible.

Every one was found by mutating production code and watching what stayed green. **None was
visible from reading the diff.** So this is a required step, not an aspiration: for each guard,
make the change it exists to catch, observe the failure, revert, and record the output. A guard
never observed failing is not a guard.

## Toolchain

**`mise.toml` pins every runtime — Python, Node and `uv` itself.** One file, one command
(`mise install`, which `make install` runs first), independent of whatever the system has.
`make check` (lint + test) is the pre-commit gate. Unimplemented `make` targets exit
non-zero rather than succeeding silently, so a half-built pipeline can't look finished.

**The pins are exact, not floating** — `python = "3.12.12"`, `node = "24.13.0"`,
`uv = "0.12.0"`. A floating `"3.12"` moves to 3.12.13 the day it ships and silently
invalidates the `make verify` proof above, which is only as good as the interpreter that
produced it. Bumping is a deliberate commit that re-runs `make verify`.

**`UV_PYTHON_PREFERENCE = "only-system"` is load-bearing.** mise owns the interpreter, so uv
must not quietly download a second 3.12 that nobody pinned. `only-system` makes uv use
what mise put on `PATH` and fail loudly when it is absent, rather than helpfully diverging.

**Every `make` target runs through `mise exec`** (`MISE ?= mise exec --`), so the documented
commands work in a shell that has never run `mise activate` — a fresh clone, a cron, an
editor's task runner. Set `MISE=` to bypass it where the tools are already on `PATH`, which
is what the Docker image does.

> **One pinning mechanism, not two.** `mise.toml` replaced `.python-version` and made a
> `.nvmrc` unnecessary — two mechanisms for two runtimes is one too many. Changing the
> interpreter invalidates the reproducibility proof, so a runtime bump re-runs `make verify` in
> the same commit.

**`check` gates formatting, so `make fmt` is safe to run at any time.** `fmt-check` is the first
prerequisite of `check` and runs `ruff format --check .`, so drift is a red gate rather than a
surprise diff in someone else's commit. **If it ever reddens across files you did not touch, the
bad way out is reformatting only the files your change already touches** — that smears one diff
across every future commit instead of isolating it in one. Reformat the tree in a commit that
does nothing else.

> **The two tools agree; only the gate was missing — and `lint` cannot stand in for it.** The
> longest line `ruff format` produces is `test_workflow_expressions.py:62` at exactly 100
> characters against `line-length = 100`, and E501 fires *above* 100, so a format-clean tree is
> also `ruff check`-clean. The reverse does not hold: `select` carries no `Q`, so a single-quoted
> string passes `make lint` (`All checks passed!`) and reddens `make fmt-check`. That asymmetry
> is the mutant this gate was verified with.

**CI runs the gates; `make check` on a developer's machine is no longer the only one.**
`.github/workflows/ci.yml` resolves ONE warehouse release tag per run (`resolve`), restores it,
and runs `data-contract`, `check`, `app-check`, `smoke` and `goldens`. `make verify` is nightly
(`verify.yml`) because it needs the 232 MB raw+parquet pair and rebuilds twice. The `actions`
job is the exception that takes no `needs:` and no warehouse — see below.

**The nightly asserts the data contract too, because `ci.yml` triggers only on human activity.**
`data-contract` is the gate whose entire purpose is catching the upstream dataset moving, and the
dataset moves on **BTS's** schedule, not on ours — so gating it behind `pull_request` and
`push: main` means an advance is invisible until somebody opens a PR. Measured:
`warehouse-2026.05` published 2026-08-14 and the first CI run to notice was an unrelated PR three
days later. `verify.yml` already resolves the newest release and already restores the warehouse,
so covering the same assertion there costs one `make stats`.

> **Not a schedule on `ci.yml`, for a concrete reason.** Its concurrency group is
> `ci-${{ github.ref }}` with `cancel-in-progress: true`, which a scheduled run on `main` would
> **share with a push to `main`** — the two would cancel each other. That is a new failure mode
> in the workflow whose reds are being made reliable.

The nightly runs it **first**, before `make check` and `make verify`. An ordering, not a
preference: `make verify` rebuilds the warehouse twice under a 60-minute timeout, and running it
against reference values already known to be stale spends an hour to learn nothing. The tradeoff
is deliberate and bounded — if the dataset moved *and* reproducibility broke, that night reports
only the first, and the re-pin is a prerequisite for the second result meaning anything anyway.

**The Actions expression layer sits above YAML, and needed its own gate.** `warehouse.yml`
reached `main` unparseable — `HTTP 422: failed to parse workflow: (Line: 116, Col: 14): An
expression was expected` — from an empty `${{ }}` inside a **bash comment in a `run:` block**.
A `#` there is not a comment: it is part of a YAML scalar, and Actions substitutes `${{ }}`
into the raw text *before* bash parses it. Nothing caught it because the file is valid YAML and
every check applied was a YAML check (`js-yaml`, `PyYAML`, and `yaml.safe_load` in two
independent reviews). `actionlint` (pinned in `mise.toml`, run by `make lint-actions`, which
`make check` includes) now covers `.github/workflows/`, and CI's `actions` job reports it in
~40 s without touching the dataset — a broken workflow and a broken `resolve` are otherwise
indistinguishable from outside.

Two measured limits shape that gate, and neither is optional:

- **actionlint cannot read composite actions.** Point it at `.github/actions/setup/action.yml`
  and it parses the file as a workflow, reporting `"jobs" section is missing`. Injecting the
  exact empty-`${{ }}` defect into that composite leaves it exiting **0**.
  `pipeline/tests/test_workflow_expressions.py` closes that half: it walks every Actions YAML,
  extracts `run:` scalars via `yaml.compose_all` (for source line marks) and rejects an empty
  expression in any of them. It deliberately does *not* flag the empty `${{ }}` sitting in
  YAML-level comments in that same file — those are stripped by the YAML parser and never reach
  Actions, which is the whole distinction.
- **actionlint silently skips its shellcheck pass when the binary is absent.** Measured: an
  unquoted `[ $X = x ]` injected into `ci.yml` produced no finding at all. GitHub runners
  preinstall shellcheck, so an unpinned setup makes local `make check` strictly weaker than CI
  with nothing to say so. `shellcheck` is therefore pinned in `mise.toml` beside `actionlint`.
  Turning it on surfaced four pre-existing findings in `warehouse.yml` (three `SC2035` bare
  `*.tar.zst` globs, one `SC2129`), all fixed rather than suppressed.

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

### The freshness alert — the thing that notices "exited 0, forever"

The paragraph above ends at a publisher that could rebuild an identical warehouse and exit 0
every day with nothing to notice it. `freshness.yml` is what notices. It is CLAUDE.md's hard
rule made real: alert when `max(year_month)` has not advanced in ~45 days.

**It measures the data's movement, never a job's exit code.** A run that exits 0 while the data
does not advance is the actual failure mode, and an exit-code check cannot see it by
construction.

**There is no state file, because the release history already is one.** `warehouse.yml`
publishes only when the month advances — its "Stop if this month is already published" guard
skips the publish otherwise — so `publishedAt` of the newest well-formed `warehouse-YYYY.MM`
release **is** the timestamp of the last advance. That is a coupling, not a coincidence: make
the publisher publish on an unchanged month and this derivation degrades silently into "when did
we last run", which reports healthy forever. Both files carry a comment saying so.

Tag selection reuses the three resolver rules above verbatim — `publishedAt` never `createdAt`,
the anchored `^warehouse-[0-9]{4}\.[0-9]{2}$` shape rather than a prefix check, ascending order
taking `last` rather than `reverse` then first — for the reasons measured there.

**It is a separate workflow, not a step in `warehouse.yml`.** A check inside the thing it watches
cannot see that thing failing before the check runs, being disabled, or being deleted; and
`make ingest` exiting non-zero aborts that job several steps before any freshness step would be
reached. It runs daily rather than monthly: with a 45-day threshold, a monthly check can call a
44-day-old stall healthy and then not look again for 30 more days.

**45 days is a movement threshold, not a recency one.** BTS publishes with a 2–6 month lag by
nature, so `max(year_month)` is *supposed* to trail today by months — an absolute-recency check
would fire constantly and be muted inside a week. 45 is the ~30-day healthy cadence plus two
weeks of slack. Measured 2026-08-17: `warehouse-2026.05`, published 2026-08-14, is 3 days old
against a `DATA AS OF` of 2026-05 — a 3-month lag, and healthy.

**The alert dedupes.** Staleness is a condition, not an event: it stays true every day until
someone fixes it, so a three-month stall would file ninety issues without the open-issue check
that gates the filing. The dedupe key is the `stale-data` label, which must exist on the
repository — `gh issue create` fails outright on an unknown label, which would turn the alert
into a failed run whose only symptom is a red tick nobody watches for.

**The release listing is retried, and a failed listing is never passed through as empty.** Both
halves are load-bearing, and the second is the sharp one: `assess([])` is a *stale* verdict with
its own cause, so an empty string reaching the script files a **false** critical alert — a watcher
that cries wolf over an API wobble gets muted before the real event. `[]` is a different thing (a
repo with no releases yet, a legitimate answer) and still reaches the script; only an outright
failure stops the run. Measured 2026-08-17: `gh release list` returned 503 **five times inside one
hour** — twice from a workstation, twice in `ci.yml`'s `resolve`, and once in this workflow's own
first live run, which is how it was found. Note the other three resolvers (`ci.yml` and
`verify.yml`'s `pick`, `warehouse.yml`'s `previous`) still have no retry, and a failed `resolve`
**skips every downstream gate** rather than reddening one.

**All four branches were demonstrated live on 2026-08-17, against the real release history.** An
alert that has never fired is a dark guard, and this repo has caught four tests that could not go
red for the reason they claimed:

| branch | how | result |
|---|---|---|
| fresh | real clock | `Freshness — ok`, `warehouse-2026.05` 3 days old, **no issue filed** ([run](https://github.com/UnderMyBed/upguage/actions/runs/32051287013)) |
| stale | `as_of=2027-01-01T00:00:00Z` | `STALE`, 139 days, **filed #64** ([run](https://github.com/UnderMyBed/upguage/actions/runs/32051371258)) |
| dedupe | same, with #64 still open | `a stale-data alert is already open; not filing another`, still exactly one issue ([run](https://github.com/UnderMyBed/upguage/actions/runs/32051669526)) |
| listing fails | unplanned — GitHub 503ed 5× in a row | all five retries fired, then **refused to evaluate**, exit 1, **no false alert** ([run](https://github.com/UnderMyBed/upguage/actions/runs/32051503754)) |

Only the clock is varied in the stale case; the release history, the comparison and the issue are
real. `test_main_honours_an_injected_now` is what makes that substitution meaningful rather than a
demonstration of a path production never takes — without it, `as_of` could fail to reach the
comparison and the run would prove only that the workflow executes.

The fourth row was not staged. It is the strongest of the four precisely because nobody arranged
it: the guard's own failure mode arrived unprompted, three minutes after it shipped.

**Filing an issue is not alerting a human, and the gap shipped.** Measured 2026-08-17, minutes
after the table above was written: `UnderMyBed/upguage` was absent from the owner's **six** watched
repositories, `repos/UnderMyBed/upguage/subscription` returned **404**, and the issue the
demonstration filed (#64) was authored by `github-actions[bot]` with **zero assignees** and no `@`
anywhere in its body. An issue opened by a bot, in an unwatched repo, that neither assigns nor
mentions anyone, notifies **nobody** — so every branch above fired correctly and reached no one.
That is the dark-guard failure one level up from the one this workflow exists to prevent, and the
demonstration could not see it because it only ever asserted that the issue *existed*.

The alert therefore **`@`-mentions the owner in the body and assigns the issue to them**, both of
which notify regardless of watch state. Both live in `freshness.yml` where a gate can assert them;
the repo is also watched now, but watching is account configuration — correct today, silently
revocable, and invisible to every gate here, which is the same objection
[hosting.md](hosting.md) raises about correctness that exists only in a provider's dashboard.

**Assignment is a second step, never `--assignee` on the create.** The issue *is* the alert;
assignment is delivery polish on top of one that already exists and already mentions the owner. A
permissions or API hiccup on `gh issue create --assignee` fails the **create** and loses the alert
entirely — strictly worse than the unassigned issue it replaces. Create first, assign second, and
let the assign fail loudly without taking the alert with it.

**Known limitation, not closable inside Actions:** GitHub disables scheduled workflows on public
repositories after 60 days of repository inactivity. That would disable `freshness.yml` and
`warehouse.yml` **together** — the watcher and the watched share this one fate. An external
uptime check on `/api/health` is the only thing that would cover it, and that belongs with the
launch-monitoring work, not here.

### When a gate goes red at nobody

The adjacent rule to the freshness alert's, and the opposite failure. That one fires when the
data **stops** moving. This one fires when the data moved correctly and this repository's own
pins did not follow — a case no freshness check can ever see, because `max(year_month)` advanced
exactly as it should have.

What it cost before it existed:

| when | what |
|---|---|
| 2026-08-14 07:59Z | `Warehouse` publishes `warehouse-2026.05` |
| 2026-08-15 04:49Z | `Verify (reproducibility)` fails. **First red** |
| 2026-08-16 04:51Z | Fails again |
| 2026-08-17 05:00Z | Fails again |
| 2026-08-17 16:27Z | An unrelated PR opens and reddens four jobs — the first human signal |

`verify.yml` did its job on the very first night. Nothing carried that to anybody.

**`scheduled-failure.yml` watches on `workflow_run`, and is a separate workflow for the reason
`freshness.yml` already establishes** — an alert that shares a fate with the thing it watches is
not an alert. A notify step inside `verify.yml` cannot report `verify.yml` being disabled for
repository inactivity, being deleted, or failing before the step is reached. It also keeps
`issues: write` off every workflow that restores a warehouse and runs `make`.

**The watch list is a rule, not a snapshot, and the rule is wider than a literal `schedule:`
trigger.** Every workflow that carries one must appear in it, and so must every workflow that
only *inherits* an unattended path via `workflow_run` on one of them — `test_every_scheduled_
workflow_in_the_repo_is_watched` derives the expected set by reading the workflow directory and
walking that chain to a fixed point, so the next scheduled workflow somebody adds, or the next
`workflow_run`-only workflow chained off one, reddens a test instead of quietly joining
`verify.yml` in going red at nobody. `image.yml` is the case that found the gap: it carries no
`schedule:` of its own, but one of its three triggers is `workflow_run` on `Warehouse`, itself a
daily cron — so `Warehouse` publishes → `Image` rebuilds → `Image` fails is a chain nobody is
watching on a day nobody touches this repo, sitting in the blind spot of a rule that only ever
read `schedule:` literally. `Image`'s other two triggers (`push`, `workflow_dispatch`) are
attended; that does not make the workflow attended, since one unattended path is enough to need
a watcher. The chain never folds in the notifier itself — `test_the_notifier_never_watches_
itself` guards the unbounded loop that would create — so the notifier's own file is excluded
from the walk before it starts, not filtered out of the result afterward.

**A workflow starts unattended two ways, and the closure walks both.** `on.workflow_run` is one.
`gh workflow run <target>` inside another workflow's `run:` is the other, and it is invisible to a
`workflow_run` walk — so a cron workflow that dispatches a second one starts an unattended run that
a rule enumerating only the first reports as attended. The two edges point in **opposite
directions**: a `workflow_run` listener is started *by* the workflow it names, so darkness flows
target → listener, while a dispatcher *starts* its target, so darkness flows dispatcher → target.
Both run in one fixed point, and both are pinned against the real directory as well as against
fixtures — `image.yml` for the `workflow_run` edge, `warehouse.yml` for the dispatch edge —
because a clause that reads nothing from `.github/workflows/` leaves every fixture green.

Dispatches are read off the `run:` scalar **tokenised, never matched as text**, and the
tokeniser owns comments, because only it knows what is quoted: a `#` is a comment to bash and
never executes, and a whole-line filter cannot see a trailing one, so an apostrophe inside a
trailing comment would redden this gate with a message about dispatch scanning. 5 of the
directory's 46 `run:` scalars do not tokenise raw; none fails once comments are the tokeniser's
job. A `gh workflow run` sitting inside a **quoted** `--body` is a message telling a human what
to do rather than a call site, and only tokenisation separates them (a quoted body is one token
and can never produce three consecutive `gh` / `workflow` / `run` tokens). That defence covers
quoted text and nothing else: a heredoc body is read as commands, so a dispatch written inside
one would read as a call site. No `run:` scalar in the directory uses a heredoc.

**A dispatch's target is an argument of one command, so the search for it ends where that
command ends** — at a shell operator or a second `gh`, with the newline counted as the command
separator bash treats it as. A search bounded by the *step* breaks the guarantee below in both
directions at once: it walks out of an unresolvable dispatch into a later command, finds a token
that happens to resolve, and so neither fails loudly nor reports the truth — it invents an edge
nothing performs, which is the defect the quoted-`--body` rule above exists to prevent, reached
by a second route. A trailing `\` is the opposite of the newline beside it — bash joins those two
lines into one command — and `shlex` renders both as the same token, so continuations are joined
before tokenising rather than guessed at afterwards.

A dispatch whose target cannot be resolved to a workflow in the directory — `gh workflow run
"$WF"`, or a cross-repository `--repo` — **fails the test rather than being skipped**, because a
rule enumerating only the dispatches it happens to understand carries the same defect one level
further down. The remedy it names is to name the workflow literally: `SIGNALLED_DISPATCHES` is
keyed on a resolved target and read only after this point, so it cannot excuse a dispatch whose
target never resolved.

**A dispatch is exempt only when the dispatched run carries its own human-visible signal, and the
exemption is keyed on the EDGE.** `SIGNALLED_DISPATCHES` (`pipeline/tests/test_scheduled_failure.py`)
is an allow-list, so the default for a new edge is *caught*, and every entry names the dispatching
file, the dispatched file and the reason. Keyed on the edge and never on the target, because an
entry claims *"this dispatch is signalled"* and never *"this workflow is attended"* — a second,
undeclared dispatch of the same workflow is still caught. One entry exists. `warehouse.yml`'s
`bump-pin` job dispatches `image-contract.yml` only on a run that has just opened a PR
(`if: steps.pr.outputs.opened == '1'`) and targets that PR's own branch (`--ref "$BRANCH"`); check
runs attach to the head SHA, so the dispatched run appears on a PR that `warehouse.yml` assigns to
the owner and whose body @mentions them on its first line, and a dispatch that never landed is
reported onto that same PR rather than only into a log. Watching `Image contract` instead would
page on the **dispatched** run — its event is `workflow_dispatch`, which `UNATTENDED_EVENTS` alerts
on — filing a `critical`, owner-assigned issue for a red already delivered to an assigned,
@mentioning PR. Its `pull_request` runs cost nothing either way: that same event filter drops them,
exactly as it drops `CodeQL`'s.

**The conclusion test is an ALLOW-LIST — `failure` or `timed_out`, never `!= 'success'`.** The
same rule CLAUDE.md holds the cacheability predicate to, and it generalises for the same reason:
the two forms differ only on a **cancelled** run, which is usually a human superseding one
deliberately, and an alert that pages on deliberate cancellation is one that gets muted.
`timed_out` is in the list because `verify.yml` carries `timeout-minutes: 60` and rebuilds the
warehouse twice, so its slow-death mode never reports `failure` at all. The job-level `if:`
repeats the allow-list as a cost control and `test_the_yaml_prefilter_and_the_script_agree` fails
if the two drift, because a prefilter narrower than the script is an alert silently lost.

**Dedupe is keyed on the WORKFLOW, never on the label alone.** A red stays red every night until
someone fixes it, so an alert that files daily buries its own repeat — but the single-key shape
`freshness.yml` can afford, having exactly one alert, would file the first workflow to go red and
silently swallow every one after it. A dataset advance reddens more than one scheduled workflow,
so that is the live case, not a hypothetical.

**A dispatched run counts as unattended, deliberately.** `workflow_run` workflows only ever run
the copy on the **default branch**, so a hand dispatch is the only way to exercise this path end
to end — the same reasoning behind `freshness.yml`'s `as_of` input, where the run, the failure and
the issue are all real and one variable moves. It also happens to be true: a nightly someone
dispatched and walked away from is unwatched in exactly the way this alert is about.

**The alert says what it knows and no more.** It knows a run went red; it does not know why. A
body asserting a cause — "the dataset advanced" being the tempting one, since that is what
happened the day this was written — trains the reader to skip the log and is wrong the first time
a run fails for any other reason. It links the run and points at the data contract step as the
cheapest thing to read first, which is an ordering, not a diagnosis.

**Demonstrated firing, 2026-08-18, against real runs — only the pin was varied.** An alert
that has never fired is a dark guard, and this one has a second dark layer the freshness alert
did not: `workflow_run` only ever runs the copy on the default branch, so nothing about the
delivery path is exercised until it is merged.

Branch `demo/stale-pin-61` reverted `city_markets` from `6181` to `6177` — the value it
genuinely held before the 2026-08-07 BTS refresh moved it — and `verify.yml` was dispatched
against it. Every run below is real:

| what | result |
|---|---|
| Dispatched nightly ([32106834513](https://github.com/UnderMyBed/upguage/actions/runs/32106834513)) | Data contract **failed** in ~4 minutes. `make check` and `make verify` **skipped** — the fail-fast ordering, an hour of runner time not spent |
| Notifier ([32106884541](https://github.com/UnderMyBed/upguage/actions/runs/32106884541)) | Filed **#71**, titled per workflow, `@UnderMyBed` in the body and assigned |
| A green `CodeQL` completion 16 s later ([32106903273](https://github.com/UnderMyBed/upguage/actions/runs/32106903273)) | **Skipped** by the allow-list prefilter |
| A second identical failure ([32107043420](https://github.com/UnderMyBed/upguage/actions/runs/32107043420)) | Ran, filed **nothing** — *"an alert for this workflow is already open"*, File step skipped |

Three of the four branches, live. The fourth — a `cancelled` run filing nothing — is covered by
unit test only, because cancelling a run on cue is not something a gate can arrange.

**The demonstration found a defect, which is what demonstrations are for.** `Summarise` carries
`if: always()` and read `/tmp/verify.log` unguarded. With the data contract now running first,
that file legitimately does not exist on a short-circuited run, so the step failed a second time
for an unrelated reason (`tail: cannot open`) — turning one clear red into two, on the job whose
entire value is an unambiguous red. It now reports that `make verify` never ran and points at the
summary the failing gate already wrote.

**`scheduled-red` must exist as a repository label.** `gh issue create` fails outright on an
unknown label, which would turn this alert into a failed run whose only symptom is a red tick
nobody is watching for — the exact failure it exists to prevent.

### Generated figures, and the boundary around them

Two committed artifacts hold measured numbers so they cannot rot in prose, both in the shape
`make basemap` established and `make verify` already gates:

- **`pipeline/reference/stats.generated.json`** — `make stats`, from the warehouse via
  `sql/03_queries/stats_reference.sql`. Entity counts, rows by year, fact-present aircraft
  codes, aircraft short names and the slug-separator distribution. Diffed by CI's
  `data-contract` job, where **a diff means the upstream BTS dataset moved**.
- **`pipeline/reference/gates.generated.json`** — `make gate-counts`. The Python test total.
  Diffed by `check-gate-counts` inside `make check`, where **a diff means a test was added
  without regenerating**.

They are deliberately separate files with separate gates. Folding the test count into the
`data-contract` diff would make that job's message — "the upstream dataset no longer matches
this commit's reference values" — wrong half the time it fired.

**What is NOT generated, and why** (`pipeline/gatecounts.py` § The boundary is the canonical
statement; #10 asks that it be stated rather than left half-done). The app test total is
collectable via `vitest list` in ~4 s but needs `app/node_modules`, so gating it inside
`make check` would break that gate on a clone that has not run `make install`. The smoke check
count and the page weights need a real `next build` and a served port. The no-data skip count
needs the suite run in an environment with neither `data/` nor `upgauge.duckdb`, which is a CI
job, not a sub-second collection. Those four stay hand-maintained in CLAUDE.md's gates table and
carry the same obligation as before: re-measure before quoting.

> **A generated-artifact gate whose artifact is not tracked is not a gate.** `git diff` reports
> nothing for an untracked file, so the first version of `check-gate-counts` printed `ok` for
> every possible count — verified against two mutants that should have reddened it: a brand-new
> test added without regenerating, and the committed number hand-edited to `999`. Both passed.
> The target now refuses to run at all unless `git ls-files` can see the artifact.

> **A gate that parses another tool's output strips ANSI before matching.** pytest colourises
> its summary line whenever `FORCE_COLOR` is set — Claude Code sets `FORCE_COLOR=3` — emitting
> `\x1b[32m\x1b[32m510 tests collected\x1b[0m\x1b[32m in 0.10s\x1b[0m\x1b[0m`, which the
> anchored `^(\d+) tests? collected` cannot match. `make check` was therefore red in every agent
> shell and green in CI, where runners do not set it. It also misdiagnosed itself twice over:
> the raised message blamed a changed reporter format while the count sat two lines above it in
> the same dump, and the visible failure was `check-gate-counts`, whose documented meaning is
> *"a test was added without regenerating"*. Strip inside the parser rather than passing
> `--color=no` at the call site — an environment variable set by a tool this repo does not
> control must not decide whether a gate can read its own input.

### BTS revisions: corrections ship with the next month, by decision

A BTS revision to an already-published month rebuilds a **corrected** warehouse under an
**unchanged tag** — the tag is `warehouse-` + `max(year_month)`, and a revision does not move
that. The "Stop if this month is already published" guard therefore sets `SKIP=1` and the
corrected build is discarded. This was latent until the force-refetch landed: the year-keyed
fetch cache meant revisions were never downloaded in the first place, so making them *reachable*
is what exposed it.

**The decision is to accept this.** A correction reaches the site when the next BTS month lands —
at most about a month, against a lag that is already 2–3 months and stamped honestly by
`DATA AS OF`. The alternatives both cost more than the defect: a `warehouse-2026.04r2` suffix
breaks the `^warehouse-[0-9]{4}\.[0-9]{2}$` shape all three resolvers now validate, and
publishing on a content digest with date-stamped tags replaces a scheme whose one-release-per-
data-month property is what makes `resolve` legible.

What was *not* acceptable is the summary reading as though the correction shipped.
`classify_warehouse.py` now says plainly, on a class-2 delta with no new month, that the build is
discarded and names the month the correction waits for. The condition is `moved_years and not
new_months`: a revision arriving *alongside* a new month does publish, and warning there would be
false. Both directions are pinned by test — mutant-verified in both, since a warning that is
always printed carries no information, and a fixture holding only the revision cannot tell the
two implementations apart. **Class 3 is unaffected** and still files a `critical` issue whether
or not anything publishes.

**The real-data tests are no longer dark, and the accounting is exact.** The per-PR `check` job
restores the warehouse but not `data/raw/`, so **15 raw-dependent tests skip there by design** —
CI greps for the skip reasons that appear only when the *restore itself* broke
(`no built catalog`, `no built Parquet warehouse`) rather than failing on any skip. Those 15 run
nightly in `verify.yml`, which restores raw and runs `make check` alongside `make verify`. So
**all but 15 run per PR, every test runs nightly, and nothing runs only on one developer's
machine.**

**15 is the durable figure here; the pass count is not, so it is not written down.** The total
lives in `pipeline/reference/gates.generated.json` and moves whenever a test is added. Per-PR
passes are that generated total minus 15.

The 15 is measured from a real CI `check` job, not derived from a local run, and the two do not
decompose the same way. With **no** `data/` at all only **14** skips name a `data/raw` reason;
with the warehouse restored and raw absent — CI's actual state — it is 15. The extra one is
`test_invariants_against_real_data.py`'s deliberately per-function `skipif`: without a catalog it
skips under the module-level `no built catalog` and is invisible inside that group, and only once
a catalog exists does it surface as `no 2015 extract`. **Counting raw-dependent skips from a
no-data run undercounts by one.**

**Node is pinned at 24.19.0** — the 24 LTS line; Next.js 16 itself needs only ≥ 20.9. The
binding floor is `jsdom` 30, which declares `engines.node: ^22.22.2 || ^24.15.0 || >=26.0.0`.
The previous pin, 24.13.0, was *below* that floor, and npm only **warns** on `EBADENGINE` — so
the jsdom bump passed all ten CI checks while installing a dependency that did not support the
pinned runtime. No gate in this repo can see that; the pin's own comment is the record. 26.x
stays out until it goes LTS in 2026-10, because the serving box is always-on.

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
