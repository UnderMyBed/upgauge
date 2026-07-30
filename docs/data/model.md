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

`mart_route_health` **does** store derived columns — `lf_t12`, `lf_delta`, `gauge_delta`,
`capacity_delta`, `frequency_delta`, `completion_factor`, `health_score`. The rule therefore
reads: *no derived columns on `fct_*` tables.* Marts may carry them.

What makes that safe is not a convention, it is the grain: **`mart_route_health` has no time
dimension and no partial grain.** One row per (carrier, undirected route) is already the
finest and coarsest it gets, so there is no legitimate `GROUP BY` of this table and therefore
nothing an `AVG()` could corrupt. That is the whole argument — if a mart is ever given a time
grain, its derived columns must come back out.

It also stores the additive `t12_*` / `p12_*` sums alongside them, because
[../product/features.md](../product/features.md) requires the *components* be shown and not
just the score, and because they let any consumer recompute a ratio itself.

Backed by two tests: no `fct_*` object carries a column from the derived list, and no
`mart_route_health` derived column appears inside a `SUM(` or `AVG(` anywhere in `sql/`.

#### Window rule, floor, and the NULL-prior-window trap

Windows are **global, not per-route**: `t12_start_month..t12_end_month` is the latest 12
calendar months present anywhere in `fct_route_month`; `p12_start_month..p12_end_month` is
the 12 immediately before that. `'YYYY-MM'` strings compare correctly with `BETWEEN`, so no
per-row date parsing is needed. Measured on the real 2015–2017 warehouse: `2017-01..2017-12`
vs. `2016-01..2016-12`.

The `<30 departures` floor applies to `t12_departures_performed` — **performed, not
scheduled** — same reasoning as the fact-table quarantine rules: a route with a big schedule
that mostly didn't fly should not count as "active."

**A route absent from the prior 12 months gets `NULL` deltas, never a huge positive number.**
A new route is not a route that improved infinitely. Enforced by `CASE WHEN
p12_months_present = 0 THEN NULL ELSE ... END` on every `p12_*`-derived ratio and every
`*_delta` column — belt-and-suspenders alongside the `nullif` on each denominator, since a
`SUM(...) FILTER (WHERE <no rows match>)` already returns `NULL`, not `0`, in DuckDB. The row
itself still exists (it is the Route Birth Tracker's input); only its deltas are unknown.
Measured on the real 2015–2017 warehouse: of 7,336 surviving routes, 768 have no prior-window
data (`new_routes`) and are correctly `NULL`-delta rows; the other 6,568 have both windows
populated.

`health_score` is an **equal-0.20-weighted** z-score composite of `lf_delta`, `gauge_delta`,
`capacity_delta`, `frequency_delta`, and `completion_factor`, all oriented so **higher is
healthier** (including `gauge_delta` — a downgauge is the warning sign, so it is *negated*
relative to the raw gauge change). Equal weights, not a fitted or eyeballed weighting, because
[../product/features.md](../product/features.md) says this is v0 and *deliberately dumb* —
any other weighting would be a number invented in this task with no basis. Measured on the
real warehouse: `health_score` ranges from **-2.686 to 17.329** — single/double-digit
z-composites, not `1e17`-scale blowups, confirming no near-zero `stddev_samp` slipped past its
`nullif`.

> ⚠️ **`health_score` can be `NULL` for a reason *other than* a missing prior window.**
> `completion_factor = t12_departures_performed / nullif(t12_departures_scheduled, 0)` is
> computed from `t12_*` sums alone and has nothing to do with `p12_months_present`. Measured
> on the real warehouse: **580 of 7,336 routes** (all on-demand/charter-style operators) have
> `t12_departures_scheduled = 0` despite dozens of real `t12_departures_performed` — BTS lets
> a carrier file performed flights against no filed schedule. For those routes,
> `completion_factor` is `NULL` and so is `health_score`, even though `lf_delta` and the other
> three deltas are known (the prior window is fully populated). Any test that infers
> "`health_score` is null exactly when `lf_delta` is null" is asserting a narrower invariant
> than the real one ("null exactly when *any* of the five components is null") — true on the
> M2 test fixture (too small to have a `p12`-populated, `t12_departures_scheduled = 0` route
> at all), false against the full 2015–2017 warehouse. Any future strengthening of this test
> must check all five components, not use `lf_delta` as a stand-in for the rest.

### `distance` is not additive

`DISTANCE` is per-segment miles, so `SUM(distance)` across aircraft types on a route is
meaningless. Whether `fct_route_month` may carry it as a route *attribute* depends on whether
it is constant per (origin, dest) within a month.

**Measured in M2**, over all of `data/parquet/t100_segment/` (years 2015–2017, 274,824
non-quarantined `(year_month, origin_airport_id, dest_airport_id)` route-months):

```
route_months     274,824
varying                0
pct_varying         0.0%
max_spread_miles      0.0
```

Zero route-months show more than one distinct `DISTANCE` value. **`DISTANCE` is constant per
(origin, dest) within a month across the full measured window** — this is the *constant*
branch: `fct_route_month` carries `distance` as an attribute via `max(distance)`, and ASM
computes downstream as `SUM(seats) * distance`. A `seat_miles = SUM(seats * distance)` column
is not needed; Task 5's SQL should use the plain attribute + downstream multiplication.

### `origin_city_market_id` / `dest_city_market_id` are collapsed with `any_value()`

Same shape of question as `distance`, different answer path: these are carried through
`fct_route_month` via `any_value()` rather than a `GROUP BY` column, which is safe only if
they don't vary within the route-month grain. **Measured 0 of 494,451 non-quarantined
route-months varying**, over the full 2015–2017 warehouse — see the "City market ids are
constant within the route-month grain" section of
[invariants.md](invariants.md#city-market-ids-are-constant-within-the-route-month-grain) for
the full measurement and the test that guards it.
