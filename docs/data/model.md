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
                      -- 6,177 distinct city_market_ids (master_coordinate_20260729), of
                      -- which 257 have more than one DISPLAY_CITY_MARKET_NAME_FULL across
                      -- all history -- mostly geopolitical renames ('Aachen, West Germany'
                      -- -> 'Aachen, Germany'; 'Adler/Sochi, U.S.S.R.' -> 'Adler/Sochi,
                      -- Russia'). Restricting to AIRPORT_IS_LATEST = '1' leaves exactly ONE
                      -- ambiguous market: 30973 (CGQ), seq 3097301 'Changchun, China' vs
                      -- seq 3097302 'Changchun\Jilin City, China'. The max(seq_id) tiebreak
                      -- is load-bearing, not cosmetic: a nondeterministic pick would drift
                      -- between builds and break the byte-identical Parquet gate.

map_mainline_group    airline_id, parent_airline_id, effective_from, effective_to
                      -- DATE-RANGED. Wholly-owned subsidiaries ONLY.

mart_route_health     one row per (op_airline_id, route_key_low, route_key_high)
                      UNDIRECTED, and the only materialized TABLE in the database.
                      Global trailing-12 / prior-12 windows, <30 performed-departures floor,
                      NULL (not huge-positive) deltas when the prior window is empty.
mart_leaderboards     precomputed JSON, built at pipeline time                    [M5]

meta_pivot_dimensions  key, label, column_expr, grain, join_dim, join_key
                      -- The Explorer's dimension vocabulary. See "The Explorer's
                      -- vocabulary lives in the catalog" below.
meta_pivot_measures    key, label, is_additive, expr
                      -- The Explorer's measure vocabulary. Same section.
```

## Route health is UNDIRECTED

T-100 files each direction of an O&D pair as its own row, so a directed grain splits every
route's health into two half-populated rows and halves each one's departure count against the
`<30 departures in trailing 12mo` floor — silently excluding routes that clear it easily.
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
data:

```
CARRIER_GROUP      {'3': 26715, '1': 4666, '2': 4555}
CARRIER_GROUP_NEW  {'3': 26715, '2': 4555, '5': 3072, '6': 1070, '4': 267, '1': 247, '9': 10}
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

### The exact query-time forms (M3 pivot contract)

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
> This is a trap M2 set up. `distance` is *almost* constant per (origin, dest) per month — 37 of
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
> **Correction (M3a Task 7):** an earlier pass of this measurement reported the annual naive
> figure as `5,055,984,838,795` — computed by dropping `FILTER (WHERE NOT is_quarantined)`
> from the mutation before summing, so it wasn't reproducible from this recipe. The
> difference, `12,289,140`, is exactly the 61 quarantined 2019 rows' `2,412` total seats ×
> `5,095` mi (the single `MAX(distance)` for the full year). The rounded **5.72x** headline is
> unchanged; only the underlying unfiltered figure was wrong.
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

The list itself is still **curated, not introspected** — which dimensions we *offer* is a
product decision (`fct_segment_month` carries `download_date` and `quarantine_reason`, which
are real columns but not Explorer dimensions), not a schema fact. What the catalog-object
form buys is a drift guard: `pipeline/tests/test_pivot_allowlist.py` cross-checks every
curated `column_expr` against `DESCRIBE` on the fact table(s) its `grain` claims, in both
directions — a `'segment'`-grain dimension must be absent from `fct_route_month`, and a
`'both'`-grain dimension must be present on it. A renamed or dropped fact column fails that
test loudly instead of silently dropping a dimension from the Explorer at request time.

The measure allowlist encodes the derived-measure rule (see "Measures" above) as *data*
rather than only as a convention: `pipeline/tests/test_pivot_allowlist.py` asserts no
`meta_pivot_measures.expr` contains `AVG(` or `MEAN(`, and that `asm` / `rpm` multiply per
row (`SUM(seats * distance)`) rather than summing then multiplying
(`SUM(seats) * distance`).

**Consequence accepted knowingly: `make verify`'s database-object gate now covers a product
decision, not only data.** Before this task `make verify` reported 8 database objects;
after, 10 — the two new views join the byte-identical-across-two-builds proof alongside the
facts and dims. That is the price of the vocabulary being impossible to drift: it participates
in the same reproducibility gate as everything else the server serves.

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
per-row date parsing is needed. Measured on the 2015–2017 warehouse (M2): `2017-01..2017-12`
vs. `2016-01..2016-12`. **Re-measured over the full 2015–2026 window** (M3a Task 1, after
`make fetch` + `make warehouse` landed all 12 years — 2026 is a partial year, so the trailing
window lands mid-2026 rather than at a year boundary): `t12 = 2025-05..2026-04`,
`p12 = 2024-05..2025-04`.

The `<30 departures` floor applies to `t12_departures_performed` — **performed, not
scheduled** — same reasoning as the fact-table quarantine rules: a route with a big schedule
that mostly didn't fly should not count as "active."

**`p12_months_present` (like `t12_months_present`) is a 0–12 *count* of distinct months
present in the window, not a boolean** — `count(DISTINCT r.year_month) FILTER (...)` in
`sql/02_marts/200_mart_route_health.sql`. Only `= 0` ("no prior window at all") and `>= 1`
("some prior window") are the meaningful boundaries; `= 1` means "exactly one month," a
much narrower and mostly incidental condition.

**A route absent from the prior 12 months gets `NULL` deltas, never a huge positive number.**
A new route is not a route that improved infinitely. Enforced by `CASE WHEN
p12_months_present = 0 THEN NULL ELSE ... END` on every `p12_*`-derived ratio and every
`*_delta` column. This `CASE` is a documentation aid, not the load-bearing guard — deleting
all four is a provable no-op (identical byte-for-byte 7,336-row mart, measured on the
2015–2017 warehouse at M2; not re-run against the full 2015–2026 window in M3a Task 1,
which now has 8,080 rows), because a
`SUM(...) FILTER (WHERE <no rows match>)` already returns `NULL`, not `0`, in DuckDB, and
`nullif` on each denominator propagates that `NULL` through. The real guard is the
`nullif`s: deleting *those* is what a test catches. Keep the `CASE` anyway — it is correct
defence against a future `coalesce` on the p12 sums, just not what "enforces" the rule
today. The row itself still exists (it is the Route Birth Tracker's input); only its
deltas are unknown.

Measured on the 2015–2017 warehouse (M2): of 7,336 surviving routes, **767** have no
prior-window data (`p12_months_present = 0`, `new_routes`) and are correctly `NULL`-delta
rows. The other **6,569** have `p12_months_present >= 1` (i.e. at least one month present —
only 203 of them have *exactly* one), but one of those 6,569 —
`op_airline_id=20378`, route `12266-12951` — filed `p12_seats = 0` and
`p12_departures_performed = 0`, so `lf_p12` / `gauge_p12` are `NULL` via the `nullif` on
their denominators even though the prior window is technically "present." So `lf_delta IS
NULL` for **768** routes, not 767 — the extra one is a zero-measure prior window, not a
missing one, and the two must not be conflated: **767 + 1 = 768**, and only the 767 are
`new_routes` in the Route Birth Tracker sense.

**Re-measured over the full 2015–2026 window** (M3a Task 1): of **8,080** surviving routes,
**688** have no prior-window data (`p12_months_present = 0`, `new_routes`), and **7,392**
have `p12_months_present >= 1`. The zero-measure-prior-window case (`op_airline_id=20378`
above) is specific to the 2016→2017 windows measured at M2; over the current global
trailing window (`t12 = 2025-05..2026-04`, `p12 = 2024-05..2025-04`) **zero** routes have a
"present but all-zero" prior window, so that third category is empty today — a property of
which 24 months happen to be the trailing window right now, not a structural guarantee. The
768-vs-767 accounting shape from M2 does not carry forward unchanged; see the corrected
three-reason breakdown below.

`health_score` is an **equal-0.20-weighted** z-score composite of `lf_delta`, `gauge_delta`,
`capacity_delta`, `frequency_delta`, and `completion_factor`, all oriented so **higher is
healthier** — including `gauge_delta`, computed as `gauge_t12 - gauge_p12` (the same as-is
shape as `lf_delta`, **no negation**): a positive `gauge_delta` already means the mean
seats-per-departure went up, i.e. an upgauge, which is the healthy direction, so the raw sign
is correct as computed and nothing needs flipping. Equal weights, not a fitted or eyeballed
weighting, because [../product/features.md](../product/features.md) says this is v0 and
*deliberately dumb* — any other weighting would be a number invented in this task with no
basis.

Measured on the 2015–2017 warehouse (M2): `health_score` ranges from **-2.686 to 17.329** —
single/double-digit z-composites, not `1e17`-scale blowups, confirming no near-zero
`stddev_samp` slipped past its `nullif`. The +17.329 max is real, not an artifact: traced to
`op_airline_id=20452`, route `11298-12953`, where `p12_departures_performed = 1` (the route was
essentially dormant the prior year) and `t12_departures_performed = 3414` (fully active this
year). A dormant-to-active jump like that sends `capacity_delta` and `frequency_delta` into the
thousands — dividing by a p12 base of 1 — and the equal-weighted sum lets those two components
dominate the score. That is a real, expected consequence of "deliberately dumb, do not
over-engineer" v0 scoring, not a bug: a leaderboard's top row being a near-dead route waking up
is exactly the kind of finding the product should surface, but the UI must show the raw
`p12_departures_performed` alongside the score so a viewer isn't misled into reading "+17.3" as
"this route tripled its traffic" when the real story is "this route had almost no prior-year
baseline to compare against."

**Re-measured over the full 2015–2026 window** (M3a Task 1): `health_score` ranges from
**-1.865 to 19.067** — still single/double-digit, same shape as M2, no blowup. The new max
traces to the **same carrier**, `op_airline_id=20452`, now on route `10397-12953` (a
different specific route than M2's `11298-12953` — more routes now compete for the extremes
over a nine-year-wider window, so a different one wins) with `p12_departures_performed =
1.0` and `t12_departures_performed = 2387.0` — the identical dormant-to-active pattern,
confirming this is a recurring, structural consequence of the scoring shape rather than a
one-off artifact of the 2015–2017 subset.

> ⚠️ **`health_score` is `NULL` for three distinct reasons, not one — 1,348 of 7,336 routes
> total, measured on the 2015–2017 warehouse (M2).** The product-facing writeup (what the UI
> must do about each) lives in
> [../product/features.md § Route Health score](../product/features.md#route-health-score-v0--deliberately-dumb);
> this is the SQL-level accounting behind it.
>
> | Reason | Count (2015–2017) | Why |
> |---|---|---|
> | No prior window | 767 | `p12_months_present = 0` — a genuinely new route. |
> | Zero-measure prior window | 1 | `p12_months_present = 1` but `p12_seats = 0` and `p12_departures_performed = 0` (`op_airline_id=20378`, route `12266-12951`) — `nullif` makes `lf_p12`/`gauge_p12` NULL despite the window being "present." |
> | Zero scheduled departures | 580 | `t12_departures_scheduled = 0` despite real `t12_departures_performed` (all on-demand/charter-style operators) — `completion_factor = t12_departures_performed / nullif(t12_departures_scheduled, 0)` is computed from `t12_*` sums alone and has nothing to do with `p12_months_present`. |
>
> `767 + 1 + 580 = 1,348` on 2015–2017, with **no overlap** between the three reasons — a
> coincidence of that particular window, not a structural guarantee, corrected below.
>
> **Re-measured over the full 2015–2026 window** (M3a Task 1, `t12 = 2025-05..2026-04`,
> `p12 = 2024-05..2025-04`): **813 of 8,080** routes have `health_score IS NULL`.
>
> | Reason | Count (2015–2026) | Why |
> |---|---|---|
> | No prior window | 688 | `p12_months_present = 0`. |
> | Zero-measure prior window | 0 | No route currently has a "present but all-zero" prior window — a property of which 24 months are the current global trailing window, not a structural absence of the case. |
> | Zero scheduled departures | 180 | `t12_departures_scheduled = 0` despite real `t12_departures_performed`. |
> | *(overlap: no-prior-window AND zero-scheduled)* | **-55** | 55 routes are in **both** the "no prior window" and "zero scheduled" categories at once — the 2015–2017 measurement's assumption of no overlap does not hold over the full window. |
>
> `688 + 0 + 180 - 55 = 813`, the real `health_score IS NULL` count over 2015–2026. The
> zero-overlap arithmetic quoted for 2015–2017 above was correct for that window but is not a
> general property — a query summing the three reason counts without subtracting the overlap
> would overcount by 55 today. A test that infers
> "`health_score` is null exactly when `lf_delta` is null" asserts a narrower invariant than
> the real one ("null exactly when *any* of the five components is null") — true on the M2
> test fixture (too small to have a `p12`-populated, `t12_departures_scheduled = 0` route at
> all), false against the full 2015–2017 warehouse.
>
> **Fixed in Task 6:**
> `test_health_score_is_null_exactly_when_a_component_is_unknown`
> ([`pipeline/tests/test_route_health.py`](../../pipeline/tests/test_route_health.py)) checks
> parity against all five components, not `lf_delta` alone. **A known, permanent limitation of
> that fix, otherwise recorded only in a gitignored report:** the corrected guard discriminates
> only against the real 2015–2017 warehouse. It cannot discriminate against the single-year CI
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
> **The fix is a second fixture year**, and it is the highest-leverage test investment
> outstanding in this project. Fixture warehouse setup measures 0.16 s, so the cost is
> negligible; adding real BTS rows for a second year to
> `pipeline/tests/fixtures/t100d_segment_sample_2015.zip` (or a sibling 2016 fixture) would
> populate a `p12` window and light up the entire delta and score surface at once. Take real
> rows from `data/raw/`, never fabricated ones — see the CGQ precedent in
> [`sql/01_staging/dim_city_market.sql`](../../sql/01_staging/dim_city_market.sql) and the
> two-aircraft-type rows added for `test_distance_is_not_summed`.

### `distance` is not additive

`DISTANCE` is per-segment miles, so `SUM(distance)` across aircraft types on a route is
meaningless. Whether `fct_route_month` may carry it as a route *attribute* depends on whether
it is constant per (origin, dest) within a month.

**Measured in M2, over the 2015–2017 subset** (274,824 non-quarantined `(year_month,
origin_airport_id, dest_airport_id)` route-months): zero varied, max spread 0.0. That
measurement licensed `max(distance)` as an attribute — but it was a property of the 3-year
subset available at the time, not a proven property of the data, and M3a re-measured before
building the Explorer's pivot contract on it.

**Re-measured in M3a Task 1, over the full 2015–2026 window** (1,082,147 non-quarantined
`(year_month, origin_airport_id, dest_airport_id)` route-months, after `make fetch` landed
all 12 years):

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
genuinely filed value. **`fct_route_month.distance` is therefore documented as a
representative filed value, not a true invariant** — this corrects the earlier "constant"
framing rather than softening it; the 2015–2017 zero was a property of that subset, not of
the data.

Guarded by `pipeline/tests/test_route_month.py::test_distance_is_not_summed`, which asserts
`count(DISTINCT distance) = 1` per route-month, not only `distance <= max(segment distance)`
— the latter is satisfied by construction (`max()` always equals the max) and so cannot
catch a route-month where distance genuinely disagrees across rows, the same gap the
city-market-id test next to it was written to avoid. That test runs on M2's small committed
CI fixture, which cannot see the WWT/2022–2023 case at all (same single-year-fixture
limitation documented elsewhere in this doc), so it stays green regardless of this finding.
The guard that actually exercises real data is
`pipeline/tests/test_invariants_against_real_data.py::test_distance_variance_stays_within_bound`
(added in M3a Task 1): it asserts both bounds observed above — under 0.01% of route-months
vary, and under 20 miles of spread — so a future widening beyond the 2022–2023/WWT pattern
documented here fails the build instead of silently drifting further.

### `origin_city_market_id` / `dest_city_market_id` are collapsed with `any_value()`

Same shape of question as `distance`, different answer path: these are carried through
`fct_route_month` via `any_value()` rather than a `GROUP BY` column, which is safe only if
they don't vary within the route-month grain. **Measured 0 of 1,861,880 non-quarantined
route-months varying, over the full 2015–2026 window** (re-measured in M3a Task 1 alongside
the `distance` re-measurement above; this one did **not** find variance, unlike `distance`)
— see the "City market ids are constant within the route-month grain" section of
[invariants.md](invariants.md#city-market-ids-are-constant-within-the-route-month-grain) for
the full measurement and the test that guards it.
