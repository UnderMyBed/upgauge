# Data model

```
fct_segment_month     grain: (year_month, op_airline_id, origin_airport_id,
                              dest_airport_id, aircraft_type)
                      departures_scheduled, departures_performed, seats, passengers,
                      freight, mail, distance, air_time, ramp_to_ramp_time,
                      aircraft_config, service_class,
                      origin_airport_seq_id, dest_airport_seq_id,   -- point-in-time attrs
                      origin_city_market_id, dest_city_market_id,   -- city-market rollup
                      download_date,                                -- amended-filing resolution
                      is_quarantined, quarantine_reason

fct_route_month       grain: (year_month, op_airline_id, origin_airport_id, dest_airport_id)
                      DIRECTED, and a view -- it is purely derived from fct_segment_month
                      with the aircraft_type grain dropped. Excludes quarantined rows but
                      carries quarantined_rows as a count, so the UI can still show the dirt.
                      Also carries `is_quarantined`, always FALSE -- a structural stand-in so
                      meta_pivot_measures' shared `FILTER (WHERE NOT is_quarantined)` resolves
                      at route grain too, instead of "column does not exist".

dim_airport           airport_id, airport_seq_id, code, name, city, state, lat, lon,
                      effective_from, effective_to
                      -- airport_id = identity; airport_seq_id = point-in-time attributes
dim_carrier           airline_id, code, name, is_regional, ownership_type,
                      bts_carrier_group   -- BTS's OWN revenue-based reporting class.
                                          -- NOT our rollup. Preserved under a distinct
                                          -- name so the collision is impossible.
dim_aircraft_type     code, name, short_name, manufacturer, ssd_name,
                      aircraft_group, effective_from, effective_to
                      -- code stays VARCHAR: '007'/'079' are real type codes
                      -- deliberately NO seats_typical -- see below

dim_city_market       city_market_id, name
                      -- from T_MASTER_CORD's CITY_MARKET_ID / DISPLAY_CITY_MARKET_NAME_FULL
                      -- 6,181 distinct city_market_ids (master_coordinate_20260807), of
                      -- which 257 have more than one DISPLAY_CITY_MARKET_NAME_FULL across
                      -- all history -- mostly geopolitical renames ('Aachen, West Germany'
                      -- -> 'Aachen, Germany'; 'Adler/Sochi, U.S.S.R.' -> 'Adler/Sochi,
                      -- Russia'). The COUNT tracks a live upstream table and drifts upward
                      -- as BTS adds markets, so re-measure it rather than trusting this
                      -- number; a move of more than a handful is the signal worth noticing.
                      -- Restricting to AIRPORT_IS_LATEST = '1' leaves exactly ONE ambiguous
                      -- market: 30973 (CGQ), city_market_seq_id 3097301 'Changchun, China'
                      -- vs 3097302 'Changchun\Jilin City, China'. These are CITY_MARKET_SEQ_
                      -- IDs -- the column the SQL partitions on, not AIRPORT_SEQ_ID.
                      -- The max(seq_id) tiebreak is load-bearing, not cosmetic: a
                      -- nondeterministic pick would drift between builds and break the
                      -- byte-identical Parquet gate.

map_mainline_group    airline_id, parent_airline_id, effective_from, effective_to
                      -- DATE-RANGED. Wholly-owned subsidiaries ONLY.

mart_route_health     one row per (op_airline_id, route_key_low, route_key_high)
                      UNDIRECTED, and the only materialized TABLE in the database.
                      Global trailing-12 / prior-12 windows, a RATE floor of 30 performed
                      departures per month FLOWN (t12_months_flown, never months present),
                      NULL (not huge-positive) deltas when the prior window is empty.
                      There is no leaderboards mart: /watch's presets read this table
                      directly (../architecture/pipeline.md).

meta_pivot_dimensions  key, label, column_expr, grain, join_dim, join_key,
                       filter_only, filter_mode
                      -- The Explorer's dimension vocabulary, wholly curated. The filter-value
                      -- bound also needs each column's TYPE; that is introspected by
                      -- sql/03_queries/catalog_dimensions.sql rather than stored here.
                      -- See "The Explorer's vocabulary lives in the catalog" below.
meta_pivot_measures    key, label, is_additive, expr
                      -- The Explorer's measure vocabulary. Same section.
```

## `effective_to` means two different things across this catalog

Four objects carry a column literally named `effective_to`, and it is NOT one convention:
`dim_airport`, `dim_aircraft_type`, and `dim_carrier` copy it straight from a BTS thru-date
field (`AIRPORT_THRU_DATE`, `END_DATE`, `THRU_DATE_SOURCE`) — a BTS thru-date is
**INCLUSIVE**, the record is valid *through* that date, not up to but excluding it.
`map_mainline_group.effective_to` is **our own** column, deliberately **EXCLUSIVE** (see
`pipeline/mainline_map.py`'s `covers()` and `sql/03_queries/pivot_mainline_join.sql`) — a
carrier whose `effective_to` is `'2018-04'` has already stopped rolling up *by* 2018-04, not
after it. Same column name, opposite boundary semantics, same catalog: check which object
you're reading before writing a `>=`/`<`/`<=` comparison against either.

## Route health is UNDIRECTED

T-100 files each direction of an O&D pair as its own row, so a directed grain splits every
route's health into two half-populated rows and halves each one's departures against the floor
of 30 performed departures per month flown. The floor's denominator does **not** halve with the
numerator — both directions fly in the same months, so `t12_months_flown` is unchanged by the
split — so the rate itself halves, silently excluding carrier–route pairs that clear it easily.
`fct_segment_month` already carries `route_key_low` / `route_key_high` (the two airport IDs
sorted, stable regardless of filing direction) for exactly this, and the product URL
`/route/PDX-AUS` reads undirected too.

`fct_route_month` stays **directed** so nothing is lost; the mart aggregates over the
undirected key.

`op_airline_id` is the **operating carrier** throughout — the DOT `AIRLINE_ID`, not the
letter code. See [carrier-model.md](carrier-model.md) and [invariants.md](invariants.md).

---

## Naming: don't reuse `carrier_group`

T-100 already ships `CARRIER_GROUP` and `CARRIER_GROUP_NEW` — BTS's own revenue-based
reporting classification, which drives filing requirements. Confirmed populated in live
data, **measured on the full-year 2024 raw extract** (`t100d_segment_us_2024_20260729.zip`
— always state the window a distribution was measured over; a single month is a different
and much smaller universe):

```
CARRIER_GROUP      {'3': 326570, '1': 64160, '2': 47141}
CARRIER_GROUP_NEW  {'3': 326570, '2': 47141, '5': 43081, '6': 15952, '1': 3415, '4': 1544, '9': 168}
```

Nothing to do with mainline rollup. **Ours is `mainline_group`; theirs is preserved as
`bts_carrier_group`** so the collision is impossible.

## Dimension sources and one caveat

| Dimension | Source | BTS `Table_ID` |
|---|---|---|
| `dim_airport` | Master Coordinate | 288 |
| `dim_city_market` | Master Coordinate (same zip — no extra fetch) | 288 |
| `dim_carrier` | Carrier Decode | 304 |
| `dim_aircraft_type` | AircraftTypes | 300 |
| `map_mainline_group` | `pipeline/reference/mainline_group.csv` (checked in) | — |

All three live in **DB 595 (Aviation Support Tables)**, which needs a *different subject
param* from T-100. Getting it wrong does not error — BTS answers 200 with its homepage. The
param is built by the codec rather than pasted as a literal for exactly that reason.

> ⚠️ **`dim_carrier` holds one row per `airline_id`, carrying the carrier's CURRENT code.**
> Carrier Decode has several rows per airline with different `CARRIER` values, and v0
> collapses them. So `carrier_code` is fine for display but is **not** the code that was in
> use during an arbitrary month — never join on it, and never present it as historical fact.
> Making the dimension fully date-ranged is a v1 change.
>
> The collapse itself has a trap: the source dates arrive as strings like
> `1/1/1960 12:00:00 AM`. String-sorting them ranks `9/1/1984` above `7/1/2011`, which
> silently surfaced Horizon as `HOZ` and SkyWest as `SEA`. Dates are parsed and stored as
> `DATE` so the mistake can't recur.

## No `is_freighter` on `dim_aircraft_type`

Freighter/passenger is a property of *the operation*, not the type — the same airframe flies
both. `AIRCRAFT_CONFIG` on the fact row is the truth.

---

## Measures

**Additive (store these):** departures_scheduled, departures_performed, seats, passengers,
freight, mail, air_time, ramp_to_ramp_time

**Derived (compute at query time):** load_factor, asm, rpm, completion_factor, avg_gauge
(seats/departure), block_hours, avg_stage_length, frequency

### The exact query-time forms

```sql
SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)               -- load_factor
SUM(seats)::DOUBLE / NULLIF(SUM(departures_performed), 0)     -- avg_gauge
SUM(departures_performed)::DOUBLE
  / NULLIF(SUM(departures_scheduled), 0)                      -- completion_factor
SUM(seats * distance)                                         -- asm
SUM(passengers * distance)                                    -- rpm
```

> 🔴 **`asm` and `rpm` multiply PER ROW, then sum.** `SUM(seats) * distance` is correct only
> within a single route and is silently wrong across any pivot that groups more than one — which
> is most of them.
>
> The trap is set by the catalog layer. `distance` is *almost* constant per (origin, dest) per month — 37 of
> 1,082,147 route-months vary, measured over the full **2015–2026** window (see "`distance` is
> not additive" below) — which licenses `max(distance)` as a *representative filed value* on
> `fct_route_month`, not a literal invariant. It does **not** license `distance` as an ASM
> multiplier outside a single route, because different routes have genuinely different
> distances. Same number, two conclusions, only one of them valid. Guarded by a test that
> asserts the two forms diverge on a multi-route group.
>
> **Measured, not asserted from theory.** `pipeline/tests/test_pivot_real_data.py` swaps the
> catalog's `asm` expression to the naive `SUM(seats) * MAX(distance)`, rebuilds, and
> re-runs. The reproducible recipe — both forms filtered identically, `FILTER (WHERE NOT
> is_quarantined)` on every aggregate, exactly as `meta_pivot_measures.expr` renders it:
> ```sql
> SELECT
>     SUM(seats * distance)  FILTER (WHERE NOT is_quarantined) AS correct,
>     SUM(seats)              FILTER (WHERE NOT is_quarantined)
>       * MAX(distance)       FILTER (WHERE NOT is_quarantined) AS naive
> FROM fct_segment_month
> WHERE year_month BETWEEN '2019-01' AND '2019-12'
> ```
> over segment-month rows for **2019-01..2019-12** the naive form comes out **5.7166x** the
> correct `SUM(seats * distance)` (884,432,752,731 correct vs. **5,055,972,549,655** naive,
> rounding to the **5.72x** already used above); over the single month **2019-06** alone it's
> **5.67x** (76,617,116,348 vs. 434,252,113,135). Both forms agree to the last unit on a
> single-route slice — the divergence is purely a function of how many distinct routes fall
> inside the group. A guard never watched fail proves nothing; this one was.
>
> **Consequence for route-grain ASM.** The canonical form directly above, `SUM(seats *
> distance)` at **segment** grain, is unaffected by the route-month distance variance — it
> multiplies per row before summing and never touches the route-grain `distance` attribute.
> Only `fct_route_month`'s `max(distance)` inherits the imprecision: an ASM computed as
> `t12_seats * fct_route_month.distance` at route grain carries an error of **at most 8 miles
> × seats, on 0.0034% of route-months** (concentrated in 2022–2023 — see below). Bounded and
> accepted by ruling, not fixed.

### The Explorer's vocabulary lives in the catalog

Which dimensions and measures the Explorer may pivot on is curated as two catalog objects —
`meta_pivot_dimensions` (`sql/02_marts/300_meta_pivot_dimensions.sql`) and
`meta_pivot_measures` (`sql/02_marts/301_meta_pivot_measures.sql`) — not a committed JSON
file. The server already opens this database, so there is no extra artifact to ship, and
`make build` regenerates the vocabulary alongside everything else. That is what makes it
un-driftable: a JSON file next to the code can silently name a column that no longer exists;
a view built from the same catalog the Explorer queries cannot describe a table that isn't
there without failing to build at all.

The vocabulary itself is still **curated, not introspected** — which dimensions we *offer* is a
product decision (`fct_segment_month` carries `download_date` and `quarantine_reason`, which
are real columns but not Explorer dimensions), not a schema fact. What the catalog-object
form buys is a drift guard: `pipeline/tests/test_pivot_allowlist.py` cross-checks every
curated `column_expr` against `DESCRIBE` on the fact table(s) its `grain` claims, in both
directions — a `'segment'`-grain dimension must be absent from `fct_route_month`, and a
`'both'`-grain dimension must be present on it. A renamed or dropped fact column fails loudly
instead of silently dropping a dimension from the Explorer at request time. Every token is
checked at every grain the dimension is offered at, with no blind spot: `value_type` is computed
by the catalog QUERY rather than stored on the view, so the view still carries all fifteen rows
and a renamed column reaches this loop rather than being filtered out before it. Measured: a
first-token rename on `fct_segment_month` turns it red, and so does one at route grain.

**`value_type` is introspected rather than curated, and it is computed by
`sql/03_queries/catalog_dimensions.sql` rather than stored on the view.** It carries the DuckDB
type of the dimension's underlying fact column, joined live from `duckdb_columns()` against the
FIRST token of `column_expr`, resolved on `fct_segment_month`.

**Where it is computed is a statement about what KIND of fact it is.** Which dimensions we offer
is a product decision; a column's *width* is a schema fact, and a hand-copied schema fact rots.
Computing it in the QUERY makes the schema part of the code, which is what it is, and
`duckdb_columns()` reads whatever fact tables the built catalog actually carries — so the bound
tracks the column rather than anyone's memory of it, and a `fct_segment_month` whose types moved
cannot disagree with a curated copy. It exists so a filter value can be rejected at render
time: a filter compiles to `col IN
($p)` with the value bound as a VARCHAR parameter, so an integer column handed a value it
cannot cast throws a Conversion Error at EXECUTION — after `proxy.ts` has resolved cacheability
and written `Cache-Control`. The join is an INNER JOIN deliberately: a renamed fact column
drops the row entirely and the count test fails, rather than the dimension shipping with no
bound at all.

**A mart view MAY carry a new column, and what makes that true is a rebuild, not the asset.**
`sql/02_marts/` is a pure function of `data/parquet` plus that directory, and it is re-run from
this commit's SQL after every warehouse restore in CI and inside the image's `warehouse` builder
stage — the release asset carries the facts, the dims and the Parquet, never the schema. So the
question for any new mart column is only whether it belongs on the view (`value_type` and
`sort_order` do not, for the reasons stated here and in `../architecture/pipeline.md`), not
whether the deployment can carry one. If either rebuild is ever removed, that stops being true
and every mart-schema change becomes unshippable until BTS advances a month:
`../architecture/hosting.md` § The Dockerfile has the mechanism.

**The type is READ, never inferred from the key name.** `aircraft_type` is `VARCHAR` carrying zero-padded codes (`079`), so a rule
that guessed "this looks like an id" from the name would re-open the `079` → `79` join break
(`invariants.md`); measured, `aircraft_type = '2T (1)'` returns zero rows where the same value
on `op_airline_id` throws. `year` is `BIGINT` **because of Hive partitioning, not** because of
`normalize_t100_segment.sql`'s `CAST(raw.YEAR AS SMALLINT)` — `fct_segment_month` reads its
Parquet with `hive_partitioning = true`, and the partition-derived column silently wins over
the content one. Measured: `hive_partitioning = true` → `BIGINT`, `false` → `SMALLINT`.

**Permissive on RANGE, strict on SPELLING — the two axes point opposite ways, deliberately.**
On range, the ceiling tracks the column TYPE and is never tightened to the column's content:
do not narrow `year`'s bound to the SMALLINT its values actually fit, because a bound narrower
than the column rejects values DuckDB accepts. Measured on `fct_segment_month` — `year` accepts
`40000` and even `9223372036854775807` (0 rows each) and throws only at 2^63. On spelling the
rule is knowingly NARROWER than DuckDB's cast: every one of `19790`, `' 19790 '`, `'+19790'`,
`19790.0`, `19790.`, `1.979e4`, `19_790` and `0019790` casts fine and returns the identical
328,368 rows for `op_airline_id`, and `-1` casts fine and returns none. Each is a distinct CDN
cache key for a byte-identical page, and the leading-zero and underscore families are
unbounded, so the canonical form is the only accepted spelling. `encode()` emits exactly that,
and `aircraft_type`'s zero-padded `079` is VARCHAR, which the numeric rule never touches.

Introspection carries three structural assumptions plus a pinned inventory, each held by
`pipeline/tests/test_pivot_allowlist.py` because each one fails silently. Every dimension
resolves to exactly one non-NULL type — a `LEFT JOIN` *combined with* a missing column would
keep the row and leave the bound NULL, and a join predicate matching two objects would
duplicate every row it matched, neither of which a set-of-keys test can see. A `LEFT JOIN`
alone changes nothing and correctly stays green: while every column resolves, LEFT and INNER
produce identical rows.
Every column of a multi-column `column_expr` shares one type, since only the first token is
read: a divergent pair would publish a bound correct for `route_key_low` and wrong for
`route_key_high`. And a `'both'`-grain dimension carries the same type on `fct_route_month`,
which `100_fct_route_month.sql` propagates through `any_value()`/`GROUP BY` and this view never
looks at. The fourth is the inventory: the measured type map is pinned in that test, not
restated here, because introspection reports a schema move FAITHFULLY and the other three
therefore cannot see one.

That the column is introspected at all is itself asserted, against the compiled view's SQL
text, because nothing in the catalog's *output* distinguishes a live `duckdb_columns()` join
from a hand-written `CASE` carrying today's values — the structural tests above compare
`value_type` to the current schema, and a literal equal to the current schema satisfies every
one of them. A curated value that *disagrees* with the schema is not silent: measured, a
`CASE` saying `INTEGER` where `aircraft_group` is `SMALLINT` reds both tests that compare
against a live `DESCRIBE`. What the source-text assertion adds is the window where the curated
value still agrees — the only one in which nothing else can see it — and with it the guarantee
that a served build never carries a bound the schema disagrees with.

**Two columns and a fifteenth dimension row, `endpoint_airport_id`**, extend the vocabulary
without changing anything the two renderers emit for the other fourteen. `filter_only`
(`BOOLEAN`) marks a dimension as accepted in a
FILTER and rejected as a grouping dimension; today exactly one row sets it. `filter_mode`
(`'pair' | 'either' | NULL`) says how a filter over that dimension's `column_expr` compiles:
`NULL` is the ordinary single-column `col IN (...)`; `'pair'` is `route`'s two columns
(`route_key_low, route_key_high`) treated as ONE route, compiling to `least()`/`greatest()`
equality (the 18,895-seat JFK–LAX inflation this guards against is above, "Route health is
UNDIRECTED"); `'either'` is `endpoint_airport_id`'s two columns (`origin_airport_id,
dest_airport_id`) treated as ALTERNATIVES, compiling to an OR — "this airport at either end."

`endpoint_airport_id` is deliberately `filter_only = TRUE`: grouping by it would put one
segment row (ORD→LAX) into both the ORD group and the LAX group, double-counting every row in
the aggregate — structurally the same failure as T-100's `CLASS` rollup codes `K`/`V`/`Z`
(`docs/data/invariants.md`), whose absence the pipeline asserts. It also carries real join
metadata (`dim_airport`/`airport_id`), same as `route` — these are two SEPARATE facts about
the row, not one.

**Join metadata** (`join_dim`/`join_key` non-NULL) is which dimensions the resolver can turn
into a display code: exactly eight — `route`, `endpoint_airport_id`, `op_airline_id`,
`origin_airport_id`, `dest_airport_id`, `origin_city_market_id`, `dest_city_market_id`, and
`aircraft_type`. Every other dimension carries `join_dim = NULL, join_key = NULL` — there is
nothing to resolve (a bare `year_month`, say, is already display-ready).

**`filter_only`/`filter_mode`** is a different, narrower split, and the two columns must not be
conflated: **TWO** dimensions carry a non-NULL `filter_mode` (`route` → `'pair'`,
`endpoint_airport_id` → `'either'`, both described above), but only **ONE** of those two,
`endpoint_airport_id`, sets `filter_only = TRUE`. `route` carries `filter_mode = 'pair'` and is
still fully groupable — `/carrier`'s Top routes table groups on it directly
(`routesSpec.dimension = "route"`, `app/src/app/carrier/[code]/page.tsx`) and
`app/smoke.sh` curls `/explore?…d=route…` — because a `'pair'` filter only changes how a
*filter* over `route` compiles (`least`/`greatest` equality instead of two independent `IN`
clauses); it says nothing about whether `route` can be a GROUP BY. Every one of the other
**fourteen** dimensions — including the other seven that DO carry join metadata
(`op_airline_id`, `origin_airport_id`, and so on) — carries `filter_only = FALSE, filter_mode =
NULL`, asserted by
`pipeline/tests/test_pivot_allowlist.py::test_every_other_dimension_is_groupable`, whose own
assertion is `filter_only == {"endpoint_airport_id"}` — a one-element set, not two. Carrying
join metadata and being filter-only are independent: `endpoint_airport_id` happens to be both,
`origin_airport_id` carries join metadata but is fully groupable, and a future either-mode
dimension with no resolvable code would be filter-only without join metadata.

The measure allowlist encodes the derived-measure rule (see "Measures" above) as *data*
rather than only as a convention: `pipeline/tests/test_pivot_allowlist.py` asserts no
`meta_pivot_measures.expr` contains `AVG(` or `MEAN(`, and that `asm` / `rpm` multiply per
row (`SUM(seats * distance)`) rather than summing then multiplying
(`SUM(seats) * distance`).

**Consequence accepted knowingly: `make verify`'s database-object gate now covers a product
decision, not only data.** The two allowlist views join the byte-identical-across-two-builds
proof alongside the facts and dims. That is the price of the vocabulary being impossible to
drift: it participates in the same reproducibility gate as everything else the server serves.

### Every pivot response carries the quarantine count

Aggregates exclude quarantined rows, but the response must carry `quarantined_rows` and the
distinct reasons for the grouped set, because the UI is required to surface count and reason —
showing the dirt is a trust feature ([invariants.md](invariants.md)). A pivot that returns only
clean sums, with no way to tell whether 3 rows or 30,000 were dropped, cannot satisfy that.

> 🔴 **The exclusion lives in `meta_pivot_measures.expr`, not the template's `WHERE`.** Every
> `SUM(...)` in the catalog carries its own `FILTER (WHERE NOT is_quarantined)` — a `WHERE`
> in `pivot_segment.sql`/`pivot_route.sql` would drop quarantined rows before
> `count(*) FILTER (WHERE is_quarantined)` could see them, making `quarantined_rows` always
> 0. `pipeline/tests/test_pivot_real_data.py::test_load_factor_matches_an_independent_recomputation`
> caught this expression missing the FILTER against the real 2019 warehouse — 61 quarantined
> rows in that window shifted `load_factor` for 7 of 80 carriers by up to 0.26%, small enough
> to look plausible and be trusted wrongly. Both fct_segment_month (real per-row
> `is_quarantined`) and fct_route_month (structural `FALSE AS is_quarantined`, see the schema
> block above) expose the column so the one catalog expression resolves at both grains.

### The mainline-group toggle is a DATE-RANGED join

```sql
LEFT JOIN map_mainline_group m
       ON m.airline_id = f.op_airline_id
      AND f.year_month >= m.effective_from
      AND (m.effective_to IS NULL OR f.year_month < m.effective_to)
GROUP BY coalesce(m.parent_airline_id, f.op_airline_id)
```

`>= effective_from` and `< effective_to`. Hawaiian must roll up from 2024-09 and **not** from
2024-08; Virgin America from 2016-12 and not 2016-11. Both boundaries get a real-data test.
Shared regionals (`OO`, `YX`, `YV`) cannot leak in because the map contains only wholly-owned
carriers — structural, not a filter. See [carrier-model.md](carrier-model.md).

> 🔴 **Derived measures are computed from summed numerators and denominators — never
> averaged.**
>
> ```sql
> -- WRONG. Silently produces plausible-looking garbage.
> AVG(load_factor)
> -- RIGHT. Always.
> SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)
> ```
>
> Enforce it structurally: **do not store a `load_factor` column on any fact table.** Can't
> average what doesn't exist. This is the #1 bug in every homemade T-100 tool.

### The one exception: `mart_route_health`

`mart_route_health` **does** store derived columns — all ten of `lf_t12`, `lf_p12`,
`lf_delta`, `gauge_t12`, `gauge_p12`, `gauge_delta`, `capacity_delta`, `frequency_delta`,
`completion_factor`, `health_score`. This list and
[`MART_DERIVED_COLUMNS`](../../pipeline/tests/test_derived_measure_rules.py) must not
diverge; the test is authoritative if they ever do. The rule therefore reads: *no derived
columns on `fct_*` tables.* Marts may carry them.

What makes that safe is not a convention, it is the grain: **`mart_route_health` has no time
dimension and no partial grain.** One row per (carrier, undirected route) is already the
finest and coarsest it gets, so there is no legitimate `GROUP BY` of this table and therefore
nothing an `AVG()` could corrupt. That is the whole argument — if a mart is ever given a time
grain, its derived columns must come back out.

It also stores the additive `t12_*` / `p12_*` sums alongside them, because
[../product/features.md](../product/features.md) requires the *components* be shown and not
just the score, and because they let any consumer recompute a ratio itself.

Backed by four tests in
[`pipeline/tests/test_derived_measure_rules.py`](../../pipeline/tests/test_derived_measure_rules.py):
no `fct_*` object carries a column from the derived list; no `mart_route_health` derived
column appears inside a `SUM(`/`AVG(`/`MEAN(`/`MEDIAN(` anywhere in `sql/`;
`mart_route_health` still has no time grain (the exception's own justification, asserted
directly rather than inferred); and `mart_route_health` is the only object materialized as
a table.

Two other files assert the no-derived-columns-on-`fct_*` rule too —
`pipeline/tests/test_marts.py` and `pipeline/tests/test_route_month.py` — each scoped to the
object it builds. The guard above subsumes both. Harmless, but a rename of any derived
measure touches three places; collapse them if you are already editing that rule.

The `SUM(`/`AVG(` scan matches whitespace-collapsed source text (so a hand-wrapped
`SUM(\n  lf_delta\n)` split across lines is still caught), not a parsed SQL AST. A derived
column name reused as an unrelated identifier, or one aggregate's closing paren landing
immediately before an unrelated bare reference of the same name, could in principle still
slip past it — no such case exists in `sql/` today. This residual gap, not the four tests
themselves, is the thing to revisit if `sql/03_queries/` grows a query that trips it.

#### Window rule, floor, and the NULL-prior-window trap

Windows are **global, not per-route**: `t12_start_month..t12_end_month` is the latest 12
calendar months present anywhere in `fct_route_month`; `p12_start_month..p12_end_month` is
the 12 immediately before that. `'YYYY-MM'` strings compare correctly with `BETWEEN`, so no
per-row date parsing is needed. Measured over the full 2015–2026 window:
`t12 = 2025-06..2026-05`, `p12 = 2024-06..2025-05` — 2026 is a partial year, so the trailing
window lands mid-2026 rather than on a year boundary.

**The floor is a RATE, not a window total: 30 performed departures per month FLOWN** —
`t12_departures_performed >= 30 * t12_months_flown`, guarded by an explicit
`t12_months_flown > 0` arm. It reads `t12_departures_performed`, **performed, not scheduled** —
same reasoning as the fact-table quarantine rules: a carrier–route with a big schedule that
mostly didn't fly should not count as "active."

**The denominator is `t12_months_flown`, months FLOWN, never `t12_months_present`, months
FILED.** `t12_months_flown` is `count(DISTINCT year_month) FILTER (… AND
departures_performed > 0)`, defined identically to the pivot templates' `active_months`
([`sql/03_queries/pivot_route.sql`](../../sql/03_queries/pivot_route.sql)) and to
`map_carrier_diff.sql`'s column of the same name. A month that filed a schedule and flew
nothing did not fly; counting it would understate the rate and admit a sparser carrier–route
than the floor allows.

**The `t12_months_flown > 0` arm is load-bearing, not a guard against a case that cannot
happen.** A pair that filed and never flew has `t12_months_flown = 0` and a departure sum of 0,
so the rate comparison alone reads `0 >= 30 * 0` and **admits** it — 7 such rows on the real
warehouse. (A wholly-quarantined window sums to `NULL` instead, and `NULL` fails both arms on
its own.) The multiplication form is deliberate over
`t12_departures_performed / t12_months_flown >= 30`: same 5,611 rows either way, but the
division form hides the never-flown case inside a `nullif`, and this form is exact integer
arithmetic at the boundary.

**The rule is declared once, in [`app/src/lib/floor.ts`](../../app/src/lib/floor.ts)**, and this
gate is its SQL-side application. The same rate is what the four entity pages, the Explorer,
both maps and all four `/watch` presets mark rows against — the mart is the one surface that
applies it as an admission gate rather than a mark, which is why no preset row is ever marked
sparse.

**A dropped carrier–route is structurally absent from this table, and the fix is never to lower
the floor.** A pair a carrier stopped flying has zero trailing-window departures, so it clears
neither arm of the gate — measured: **zero** rows with `t12_months_present = 0`, and **zero**
with `t12_months_flown = 0`. The second is the stronger statement and it is not left to the
data: the `t12_months_flown > 0` arm guarantees it directly. The floor gates the whole table
before any delta, z-score or clamp, so relaxing it to admit dropped pairs would move **every
`health_score` in the database**. Anything needing the dropped
side reads `fct_route_month` directly, as `sql/03_queries/map_carrier_diff.sql` does.

The floor is not confined to dropped carrier–routes either, which matters to anything
comparing two populations across it: of the added carrier–routes in the same 24-month span
(nothing flown in the prior window, something flown in the trailing one), **96.5% are also
below the floor** — 96.4% counting arcs only, i.e. excluding same-airport pairs. So a
query sourcing one category from this table and another from `fct_route_month` floors the two
by a factor of 28 and they are not comparable — the categories must share one floor, applied in
one place.

**`p12_months_present` (like `t12_months_present`) is a 0–12 *count* of distinct months
present in the window, not a boolean** — `count(DISTINCT r.year_month) FILTER (...)` in
`sql/02_marts/200_mart_route_health.sql`. Only `= 0` ("no prior window at all") and `>= 1`
("some prior window") are the meaningful boundaries; `= 1` means "exactly one month," a
much narrower and mostly incidental condition.

**A carrier–route pair absent from the prior 12 months gets `NULL` deltas, never a huge
positive number.** A pair with no prior window is not a pair that improved infinitely.
Enforced by `CASE WHEN p12_months_present = 0 THEN NULL ELSE ... END` on every
`p12_*`-derived ratio and every `*_delta` column. This `CASE` is a documentation aid, not the load-bearing guard — deleting
all four is a provable no-op (identical byte-for-byte mart — proved on the 2015–2017
warehouse and never re-proved on the full window, so it is a bounded claim), because a
`SUM(...) FILTER (WHERE <no rows match>)` already returns `NULL`, not `0`, in DuckDB, and
`nullif` on each denominator propagates that `NULL` through. The real guard is the
`nullif`s: deleting *those* is what a test catches. Keep the `CASE` anyway — it is correct
defence against a future `coalesce` on the p12 sums, just not what "enforces" the rule
today. The row itself still exists (it is the Route Birth Tracker's input); only its
deltas are unknown.

Measured over the full 2015–2026 window: the table holds **5,611** surviving carrier–route
pairs over only **3,198** distinct route pairs — the grain is `(op_airline_id, route)`, so a
row count is never a route count. Of those 5,611 rows, **297** have no prior-window data
(`p12_months_present = 0`, `new_routes`) and are correctly `NULL`-delta rows; the other
**5,314** have `p12_months_present >= 1`.

**"No prior window" and "zero-measure prior window" are two different things and must not be
conflated.** A row can carry `p12_months_present >= 1` and still have filed `p12_seats = 0`
and `p12_departures_performed = 0`, which makes `lf_p12`/`gauge_p12` `NULL` through the
`nullif` on their denominators even though the window is technically "present" — only the
first category is `new_routes` in the Route Birth Tracker sense. **No carrier–route pair is in
that second category today**, which is a property of which 24 months are the current trailing
window, not a structural absence of the case: a mart consumer that assumes the categories partition
cleanly will break when one reappears.

> **The formula below replaced an earlier one, and what is worth keeping is why.** v0 scored
> an equal-0.20-weighted composite of five raw components — `lf_delta`, `gauge_delta`,
> `capacity_delta`, `frequency_delta`, `completion_factor` — with no clamp. Three properties
> got it rejected and must not be reintroduced: **raw unbounded ratios, five components (two
> of which measure the same movement), and no clamp.** The measurements that convict each are
> in the subsection immediately below.

**Every axis is signed so higher is healthier, and gauge is NOT negated.** A positive gauge
movement means mean seats-per-departure went up — an upgauge — which is the healthy direction,
so the raw sign is already correct; negating it inverts Death Watch. Equal weights are
deliberate rather than fitted: [../product/features.md](../product/features.md) makes v0
scoring *deliberately dumb*, and any other weighting would be a number invented with no basis.

### The four-axis composite

**The five-component composite above was never actually five equal 0.20 weights.** Measured
mean `|z|` contribution per component, on the real 2015–2026 warehouse: `lf_delta` 0.575,
`capacity_delta` 0.517, `gauge_delta` 0.178, `frequency_delta` 0.179, `completion_factor`
0.023 — a **25.0×** spread on nominally equal weights, because three of the five were raw,
unbounded ratios whose own outliers inflated their own denominators (`capacity_delta` reaches
+2656.618 on this warehouse), while `completion_factor` — already bounded near 1.0 by
definition — was left contributing 1.6% of a nominal 20% share.

**The identity that licenses dropping `capacity_delta` from the score, not just shrinking its
weight:**

```
ln(seats_t12 / seats_p12) ≡ ln(dep_t12 / dep_p12) + ln(gauge_t12 / gauge_p12)
```

i.e. in log space, capacity change is *exactly* frequency change plus gauge change — not
approximately correlated, identically decomposed, because `seats = departures × gauge` by
construction. Measured: max `|residual|` **1.33e-15** over all **5,314** finite rows (the
`p12_months_present >= 1` population — see above), which is floating-point noise, not a
near-identity. In raw (unlogged) form the same relationship shows up as `corr(capacity_delta,
frequency_delta) = 0.9856`; in logs it is **1.00**. Scoring `capacity_delta` alongside
`gauge_delta` and `frequency_delta` would therefore score the same underlying movement twice —
this is the whole justification for excluding it from the composite, not a stylistic choice, and
without this paragraph a future editor re-adding it "to use all five components" would silently
reintroduce the double-count. `capacity_delta` keeps its column and is still displayed; it has
no place in the sum.

**The fix: four independent axes, equal weight 0.25 each — `lf_delta`, `ln(gauge_t12 /
gauge_p12)`, `ln(t12_departures_performed / p12_departures_performed)`, and
`completion_factor` capped at 1.5** (not `capacity_delta`, not `frequency_delta`/`gauge_delta`
in raw form). The two ratio axes are logged, not raw, because raw ratios are unbounded and
asymmetric — a halving is -0.5, a doubling is +1.0 — while in log space a halving and a
doubling get equal magnitude, which is what keeps one axis's own outliers from inflating only
its own `stddev_samp` and starving its own contribution the way `completion_factor` was
starved above.

**`ln()` of a zero denominator does not degrade gracefully — it raises.** An earlier design
note for this task assumed an unguarded `ln()` of a zero gauge would yield `-inf`, the way
IEEE-754 float division does, and sort to the top or bottom of Death Watch as a visibly wrong
but non-fatal value. **That is false for DuckDB**: `ln(0)` raises `Out of Range Error: cannot
take logarithm of zero` — a hard runtime error that would abort the entire `make build`, not
merely mis-sort one row. `gauge_log` and `freq_log` therefore wrap both operands in `nullif(x,
0)`: `ln()` never sees a literal zero, only `NULL` (`ln(NULL)` is `NULL`, not an error), so a
zero-gauge or zero-frequency row silently becomes a `NULL` axis (and therefore a `NULL`
`health_score`, per the three-reason contract below) instead of crashing the build.

That guard is also **provably unreachable today, not merely absent from the current
warehouse** — proved, not just tested, because there is no fixture or adversarial input that
can exercise "reached `ln()` with a literal zero" without also tripping an earlier filter. The
upstream `zero_seats` quarantine (`sql/01_staging/normalize_t100_segment.sql`) unconditionally
excludes any row with `seats = 0 AND departures_performed > 0` from every sum in
`fct_route_month`, for **both** measures on that row. So any `fct_route_month` row — and
transitively any `t12`/`p12` window sum in `mart_route_health` — with
`departures_performed > 0` is built entirely from segment rows that each individually had
`seats > 0`; there is no code path from raw CSV through `fct_route_month` to
`mart_route_health` that can produce `departures_performed > 0` with `seats = 0` in either
window. Confirmed two ways: **by construction** — a 12-month, all-quarantined adversarial
route fed through the real `fct_route_month.sql` and `200_mart_route_health.sql` comes back
with `departures_performed` and `seats` both `NULL`, excluded entirely by the departure floor —
`t12_months_flown` is 0 and the summed departures are `NULL`, so it fails both arms — before
`gauge_t12` is ever computed — and
**empirically** — measured `min(gauge_t12) = 0.958` on the real 2026-05 warehouse. The guard
is kept anyway, the same way the `p12_months_present = 0` `CASE` earlier in this file is kept:
correct defence against a future change to the quarantine rule, which *would* change this.

**Measured contribution table, before → after** (mean `|z|`, clamped to `±3`):

| Component | Before (five axes) | After (four axes) |
|---|---|---|
| `lf_delta` | 0.575 | 0.560 |
| gauge (`gauge_delta` → `ln(gauge_t12/gauge_p12)`) | 0.178 | 0.472 |
| frequency (`frequency_delta` → `ln(dep_t12/dep_p12)`) | 0.179 | 0.483 |
| `completion_factor` (capped at 1.5) | 0.023 | 0.360 |
| `capacity_delta` | 0.517 | *(displayed only, not scored)* |

Spread (max/min of the scored components): **25.0× → 1.55×**.

**The `least`/`greatest` NULL trap.** DuckDB's `least()` and `greatest()` **ignore `NULL`
rather than propagating it** — `least(NULL, 3)` returns `3`, not `NULL`, and chaining that into
`greatest(least(NULL, 3), -3)` returns `greatest(3, -3)`, i.e. **`3`**, not `NULL` — verified in
DuckDB directly, and **resolve it inside-out or you will transpose which bound wins**; either
way a value is fabricated instead of `NULL` propagating. A bare `least(completion_factor,
1.5)` therefore **fabricates a near-perfect completion rate of `1.5`** for every carrier–route
pair with no filed schedule at all (`t12_departures_scheduled = 0`, so `completion_factor` is
itself `NULL`) — **89 invented completion rates**. Left unguarded through to the clamp, the same
behaviour on `greatest(least(z_completion, 3), -3)` would score **every** row with an
unknown axis, destroying the three-reason NULL contract below: **5,611 rows scored instead of
the correct 5,238**. Both are `CASE WHEN … IS NULL THEN NULL ELSE least/greatest(...) END` in
`sql/02_marts/200_mart_route_health.sql` — a `CASE`, not a bare call, for exactly this reason.
This is not a hypothetical: `pipeline/tests/test_route_health_real_data.py`'s own reference SQL
(written to independently re-derive the axes from raw columns and check the mart's arithmetic)
originally used a bare `least(completion_factor, 1.5)` and reproduced this exact fabrication —
its measured completion contribution came out 0.197, not 0.360, until the guard was added to
the test's own SQL to match the mart's.

**The clamp.** Each of the four z-scores is clamped to `±3` before the weighted sum, so no
single axis can move `health_score` by more than `0.75` and `|health_score| ≤ 3.0` **by
construction** (four axes × 0.25 weight × a 3.0 clamp bound). Measured on the real
2015–2026 warehouse: the clamp binds (at least one axis `|z| > 3`) on **289 of the 5,238**
scored rows — a real minority, not decoration and not a rank transform wearing a z-score's
name. Observed maximum `|health_score|`: **2.33977**, comfortably inside the 3.0 construction
bound. Unclamped, the worst single axis (`VD` `CPX–VQS`) reaches `z_gauge = -18.91` on this
warehouse — the reason a per-axis clamp exists at all, not just an overall cap on the sum.

> ⚠️ **`health_score` is `NULL` for three distinct reasons, not one — 373 of 5,611 rows,
> measured over the full 2015–2026 window** (`t12 = 2025-06..2026-05`,
> `p12 = 2024-06..2025-05`). The product-facing writeup (what the UI must do about each) lives
> in
> [../product/features.md § Route Health score](../product/features.md#route-health-score-v0--deliberately-dumb);
> this is the SQL-level accounting behind it.
>
> | Reason | Count | Why |
> |---|---|---|
> | No prior window | 297 | `p12_months_present = 0` — this carrier filed nothing on this pair in the prior window. Not necessarily a new route: see § Route Birth Tracker in ../product/features.md. |
> | Zero-measure prior window | 0 | `p12_months_present >= 1` but `p12_seats = 0` and `p12_departures_performed = 0` — `nullif` makes `lf_p12`/`gauge_p12` NULL despite the window being "present." Empty today, not structurally impossible. |
> | Zero scheduled departures | 89 | `t12_departures_scheduled = 0` despite real `t12_departures_performed` (on-demand/charter-style operators) — `completion_factor = t12_departures_performed / nullif(t12_departures_scheduled, 0)` is computed from `t12_*` sums alone and has nothing to do with `p12_months_present`. |
> | *(overlap: no-prior-window AND zero-scheduled)* | **-13** | 13 rows are in both categories at once. |
>
> **The reasons OVERLAP — never sum them.** `297 + 0 + 89 - 13 = 373`; a query adding the
> three counts without subtracting the overlap overcounts by 13. Non-overlap is a property of
> whichever window is current, never a guarantee.
>
> A test asserting "`health_score` is null exactly when `lf_delta` is null" states a **narrower
> invariant than the real one** — null exactly when *any* component is null — and passes
> against a fixture too small to hold a `p12`-populated, `t12_departures_scheduled = 0` row.
> `test_health_score_is_null_exactly_when_a_component_is_unknown`
> ([`pipeline/tests/test_route_health.py`](../../pipeline/tests/test_route_health.py)) checks
> parity against every component for that reason. **It discriminates only against the real
> warehouse**, never against the single-year CI
> fixture, because a one-year fixture structurally cannot populate a `p12` (prior-12-month)
> window at all — every row's prior window is empty, so every row's `health_score` is already
> `NULL` for the `p12_months_present = 0` reason, and the fixture never reaches a row where the
> prior window is populated but `completion_factor` alone is `NULL`. The narrower,
> `lf_delta`-only version of this test would therefore still pass on CI today; only a run
> against the full warehouse (`data/parquet/` built from `make fetch` + `make warehouse`, not
> the checked-in fixture) exercises the distinction the stronger test exists to catch.
>
> **The limitation is not confined to that one test.** The single-year fixture yields a mart of
> exactly **one row**, with `lf_delta` and `health_score` both `NULL`, so five tests in
> `test_route_health.py` currently assert over zero or one rows and cannot fail on anything a
> populated mart would expose:
>
> | Test | Why it is near-vacuous on the fixture |
> |---|---|
> | `test_grain_is_undirected_and_unique` | one row cannot collide with another |
> | `test_lf_delta_equals_the_difference_of_the_two_ratios` | every `lf_delta` is `NULL`, so the identity is never evaluated |
> | `test_completion_factor_is_performed_over_scheduled` | same — filtered to non-`NULL` rows, of which there are none |
> | `test_load_factors_are_in_range` | as above |
> | `test_health_score_is_null_exactly_when_a_component_is_unknown` | both sides `NULL` by coincidence, per the paragraph above |
> | `test_windows_are_global_and_do_not_overlap` | half-vacuous *structurally*, on any data: the `windows` CTE has no `GROUP BY`, so `SELECT DISTINCT` over it can only ever return one tuple. Only the `p12_start < p12_end < t12_start <= t12_end` ordering half is a real check. |
>
> All six were verified against the real warehouse instead, and the mart's behaviour is
> correct — but a regression in any of them would ship green.
>
> **Closing this needs a second fixture year, not tighter assertions** — a one-year fixture
> structurally cannot populate a `p12` window, so no assertion written against it can reach the
> surface. Fixture warehouse setup measures 0.16 s, so cost is not the obstacle: real BTS rows
> for a second year in `pipeline/tests/fixtures/t100d_segment_sample_2015.zip` (or a sibling
> 2016 fixture) would light up the entire delta and score surface at once. Take real
> rows from `data/raw/`, never fabricated ones — see the CGQ precedent in
> [`sql/01_staging/dim_city_market.sql`](../../sql/01_staging/dim_city_market.sql) and the
> two-aircraft-type rows added for `test_distance_is_not_summed`.

### `distance` is not additive

`DISTANCE` is per-segment miles, so `SUM(distance)` across aircraft types on a route is
meaningless. Whether `fct_route_month` may carry it as a route *attribute* depends on whether
it is constant per (origin, dest) within a month.

**Measured over the full 2015–2026 window** (1,082,147 non-quarantined `(year_month,
origin_airport_id, dest_airport_id)` route-months). A narrower 2015–2017 measurement had
reported zero variance, which is why this is stated over the full window: **a subset's zero is
not the data's zero.**

```
route_months     1,082,147
varying                  37
pct_varying          0.0034%
max_spread_miles        8.0
```

**37 of 1,082,147 route-months (0.0034%) DO vary — the "always constant" claim is false over
the full window.** All 37 are concentrated in **2022 (32 route-months) and 2023 (5
route-months)**; none appear in 2015–2021, 2024, 2025, or 2026. Spread is small: 32 of the 37
differ by exactly 1 mile, the largest spread is 8 miles.

**Root cause identified.** Airport **15887 / `WWT`** accounts for **5 of the 37** offending
route-months (`SELECT * FROM dim_airport WHERE airport_id = 15887`). `dim_airport` carries
three `airport_seq_id` rows for it: `Newtok Airport` (Newtok, AK) through 2011-06, `Newtok
Airport` again through 2023-04 at a slightly different lat/lon, then `Mertarvik` (Newtok, AK)
from 2023-05 — Newtok's village relocation site, following the original village's erosion.
Small Alaska bush carriers (`7S`, `GV`, `K2`, `6F`) filed slightly different mileage for the
same nominal origin/destination pair during the transition. The remaining 32 route-months
follow the same shape: sub-100-mile Alaska bush routes where different small carriers
disagree on filed mileage by a handful of miles — not a data-corruption pattern, a
rounding-scale filing disagreement.

**Ruling: `max(distance)` stays.** The assumption is not broken, it is bounded — 0.0034% of
route-months disagreeing by at most 8 miles, entirely in 2022–2023, does not justify
inventing a number no carrier filed (e.g. a seats-weighted mean) to correct an 8-mile
discrepancy on three ten-thousandths of the data; that is exactly the over-engineering "never
average what doesn't exist" forbids elsewhere in this doc. `max(distance)` selects a
genuinely filed value. **`fct_route_month.distance` is therefore a representative filed value,
not a true invariant** — do not restate it as "constant".

Guarded by `pipeline/tests/test_route_month.py::test_distance_is_not_summed`, which asserts
`count(DISTINCT distance) = 1` per route-month, not only `distance <= max(segment distance)`
— the latter is satisfied by construction (`max()` always equals the max) and so cannot
catch a route-month where distance genuinely disagrees across rows, the same gap the
city-market-id test next to it was written to avoid. That test runs on the small committed
CI fixture, which cannot see the WWT/2022–2023 case at all (same single-year-fixture
limitation documented above), so it stays green regardless of this finding.
The guard that actually exercises real data is
`pipeline/tests/test_invariants_against_real_data.py::test_distance_variance_stays_within_bound`:
it asserts both bounds observed above — under 0.01% of route-months
vary, and under 20 miles of spread — so a future widening beyond the 2022–2023/WWT pattern
documented here fails the build instead of silently drifting further.

### `origin_city_market_id` / `dest_city_market_id` are collapsed with `any_value()`

Same shape of question as `distance`, different answer path: these are carried through
`fct_route_month` via `any_value()` rather than a `GROUP BY` column, which is safe only if
they don't vary within the route-month grain. **Measured 0 of 1,861,880 non-quarantined
route-months varying, over the full 2015–2026 window** — unlike `distance` above, this one
found no variance — see the "City market ids are constant within the route-month grain" section of
[invariants.md](invariants.md#city-market-ids-are-constant-within-the-route-month-grain) for
the full measurement and the test that guards it.
