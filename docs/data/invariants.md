# Data invariants

**Write these as tests FIRST.** They gate M1.

Each rule carries the evidence that justifies it. That is deliberate — a rule without its
evidence gets re-litigated, or "simplified" by someone who doesn't know why it exists.
Measurements are from the phase-0 spike (2024-01 = 35,936 rows; full-year 2015 = 367,360
rows). See [sources.md](sources.md) for how they were obtained.

---

## Key on DOT IDs, never letter codes

T-100 ships `AIRLINE_ID` (DOT-assigned, stable across code / name / holding-company changes)
alongside two letter codes. Measured against the full 2,886-row Carrier Decode:

| Field | Distinct | Map to >1 `AIRLINE_ID` | |
|---|---|---|---|
| `CARRIER` | 1,825 | **135** | the raw IATA code — genuinely reused |
| `UNIQUE_CARRIER` | 1,776 | **0** | BTS disambiguates with suffixes (`2T (1)`, 119 of them) |

> ⚠️ **Correction.** An earlier version of this section said `UNIQUE_CARRIER` is the reused
> field. It is the opposite — it is the *disambiguated* one. `CARRIER` is what collides.

So `UNIQUE_CARRIER` is safe as an identifier but poor for display (the suffix is ugly, and
can shift if BTS re-disambiguates), while `CARRIER` is fine for display but unusable as a key.
**`AIRLINE_ID` is the key; both codes are carried on `dim_carrier`.**

`CARRIER` also changes over time for a *single* airline — Horizon filed as `HOZ` until 1984
and `QX` since; SkyWest as `SEA` until 2002 and `OO` since. See the dimension caveat below.

Same story for airports: `ORIGIN_AIRPORT_ID` is identity, `ORIGIN_AIRPORT_SEQ_ID` is the
point-in-time key that changes when an airport's attributes change, and the 3-letter code is
neither.

**Join on IDs; display codes.** Over a 2015→present window with `VX`, `HA`, and reused
regional codes in play, this is the difference between a correct time series and a silently
merged one.

Confirmed present in 2015: `VX` → `AIRLINE_ID 21171`, `HA` → `19690`. No code mapped to
more than one ID *within* 2015 (expected — reuse happens across years). **A cross-year
reuse check is still owed** once the full window is ingested.

## Passenger filter: `AIRCRAFT_CONFIG IN (1, 3, 4)` — not `= 1`

Scheduled passenger service is `CLASS = 'F'`; dedicated scheduled all-cargo files as `G`.
But `CLASS` alone does not isolate passenger operations — `AIRCRAFT_CONFIG` does.

From the authoritative `L_AIRCRAFT_CONFIG` lookup:

| Code | Meaning | Carries passengers? |
|---|---|---|
| `0` | Not relevant | — |
| **`1`** | **Passenger configuration** | **yes** |
| `2` | Freight configuration | no |
| **`3`** | **Combined passenger + freight, main deck (combi)** | **yes** |
| **`4`** | **Seaplane** | **yes** |
| `9` | Expense capture, not attributed to a type | no — not real ops |

Measured, full-year 2015 — filtering to config `1` alone silently drops **7,326
passenger-carrying rows**:

```
CONFIG    rows    with pax
1      312,431     289,235
2       45,847         122
3        5,313       4,474   <- combi
4        3,769       2,852   <- seaplane
```

Seaplane service in Alaska is real scheduled passenger service and squarely in scope.

## 🔴 `CLASS` contains rollup codes — assert their absence

From `L_SERVICE_CLASS`:

| Code | Meaning |
|---|---|
| `A` / `C` / `E` | Scheduled First / Coach / Mixed passenger-cargo |
| **`F`** | **Scheduled Passenger/Cargo — the primary passenger class** |
| `G` | Scheduled All Cargo |
| **`K`** | **Scheduled Service = F + G — A ROLLUP** |
| `L` / `N` | Non-scheduled civilian / military passenger-cargo |
| `P` / `R` | Non-scheduled civilian / military all-cargo |
| `Q` | Non-scheduled other-than-charter |
| **`V`** | **Non-Scheduled = L+N+P+R — A ROLLUP** |
| **`Z`** | **All Service = K + V — A ROLLUP** |

Summing across service classes double-counts if a rollup code is present. This is a
*second* source of the double-count problem, distinct from the Segment/Market blending
everyone warns about.

Observed: 2015 contains only `F` (282,335), `G` (36,916), `L` (39,548), `P` (8,561);
2024-01 the same four. **No rollups in either sampled year — which is evidence the
assertion will hold, not a reason to skip it.** A rollup row appearing in some unsampled
year would silently double the affected route's capacity.

Watch `A`/`C`/`E` too: they are scheduled *passenger* classes. If a carrier files those
instead of `F`, a bare `CLASS = 'F'` filter drops real service.

## Operating-carrier keying

Regionals file under their own IDs. Key on the operating carrier — it is the grain and the
truth. Summing operators on a route does *not* double-count; each physical flight is filed
once, by whoever operated the metal. See [carrier-model.md](carrier-model.md).

## `mainline_group` rollup is wholly-owned only, and date-ranged

`map_mainline_group` may cover ONLY the wholly-owned subsidiaries listed in
[carrier-model.md](carrier-model.md), each with its own `effective_from`/`effective_to`.
Never roll up shared regionals (SkyWest/Republic/Mesa) or serially-exclusive contract
carriers (Air Wisconsin/ExpressJet) — that fabricates attribution T-100 can't support.

**Test that the map has no overlapping ranges per `airline_id`, and that Hawaiian rolls up
from 2024-09 but *not* from 2024-08.** That single assertion catches the whole bug class.

The rollup is a display grouping; it must never collapse the operating-carrier +
aircraft-type grain of the fact tables.

## Do not blend Segment with Market data

The classic "double count" warning comes from mixing T-100 Segment with T-100 Market (or
DB1B), not from Segment itself. v0 uses Segment only — keep it that way.

## `seats = 0` needs BOTH the config and the departure check

Quarantine as a data error only when **`AIRCRAFT_CONFIG IN (1,3,4)` AND
`DEPARTURES_PERFORMED > 0`**.

Two separate exclusions, each learned from real data:

**Freighters.** On 2024-01, 3,833 rows have zero seats but **3,576 are genuine freighters
(`CONFIG != 1`)** and only 257 are candidates. A freighter with no seats is not an anomaly.

**"No service this month".** This one was found by running the rule against a full year.
Of 2015's 5,717 zero-seat passenger-config rows, **only 4 actually flew**:

```
zero-seat passenger-config rows : 5,717   (2.03% of kept rows)
  departures_performed >  0     :     4   <- flew but reported no seats = ANOMALY
  departures_performed == 0     : 5,713   <- no service filed = ORDINARY
true anomaly rate               : 0.001%
```

A row with zero departures, zero seats, and zero passengers is an empty filing that
contributes nothing to any aggregate. Flagging it reported a **2.03% quarantine rate
against a true rate of 0.001% — a 1,400× overstatement** of a number the UI presents as a
trust signal. The rule is worthless if it fires on ordinary data.

## Rows with no carrier identity — a defensive rule

**158 rows in 2015 have every carrier field blank** — `UNIQUE_CARRIER`, `AIRLINE_ID`,
`UNIQUE_CARRIER_NAME`, `UNIQUE_CARRIER_ENTITY`, `REGION`, `CARRIER_NAME`,
`CARRIER_GROUP_NEW` — while still reporting real traffic (158 departures performed, 119
with passengers aboard). They cannot be keyed on the operating carrier, which is the grain
of the entire product.

> ⚠️ **Correction.** An earlier version of this section said these rows are quarantined.
> They are not, on the data v0 ingests: **all 158 are `CLASS = 'L'` (non-scheduled charter),
> zero are in scheduled passenger service.** The service filter removes them before
> quarantine applies. That also means the quarantine rate stated here was ~10x too high.

The `missing_carrier` rule therefore exists as **defense, not routine handling** — if BTS
ever emits a carrier-less *scheduled* row, it gets quarantined rather than silently
aggregated under a null carrier. Two tests hold the line: one asserts no carrier-less rows
reach the ingested subset today (so we notice if that changes), and one constructs such a
row and proves it would be caught.

> ⚠️ **Correction (M3a Task 1).** The paragraph above was true of 2015, the only year
> ingested when it was written, but is not true of the full window. **Re-measured over
> 2015–2026: `missing_carrier` fires 51 times** — 27 rows in 2018, 24 in 2022, 0 in every
> other year (see the per-year table under "Quarantine is a feature" below). So it is not
> purely defensive after all — it has caught real carrier-less rows reaching the ingested
> subset, twice, outside 2015. The rule still behaves correctly (those 51 rows are
> quarantined and excluded from aggregates, exactly as designed); what changes is the claim
> that it never fires. The two tests referenced above are unaffected — they assert against
> the 2015 extract specifically, which genuinely still has zero — but "no carrier-less rows
> reach the ingested subset today" must not be read as a claim about the full window.

`missing_carrier` outranks every other reason — an unattributable row is unattributable
regardless of what else is wrong with it.

## `load_factor > 1.0` → quarantine, never clamp

Quarantine as a filing error. **Do not silently clamp.**

Measured 2024-01: only **5 rows** of 32,103 with `seats > 0` exceed 1.0, and none exceed
1.5. Quarantining is nearly free, so there is no efficiency argument for clamping.

## Zero-padded codes stay strings

| Field | Example values |
|---|---|
| `AIRCRAFT_TYPE` | `026`, `033`, `035`, `079` |
| `UNIQUE_CARRIER_ENTITY` | `01100`, `01126` |
| `ORIGIN_STATE_FIPS` / `DEST_STATE_FIPS` | `01`, `02`, `04` |

Coercing `AIRCRAFT_TYPE` to int turns `079` into `79` and breaks the `dim_aircraft_type`
join — *silently*, because codes without leading zeros still match.

## Route identity

Store both directional (`PDX→AUS`) and undirected (`AUS-PDX`) keys. The undirected key is
the two airport IDs sorted, so it is stable regardless of filing order.

**A route filter must not become `origin IN (a,b) AND dest IN (a,b)`.** That form also
matches same-airport filings (`a→a`, `b→b`), and those are not a curiosity: **12,738 of them
exist across 530 airports.** Measured on JFK–LAX over 2025-05 → 2026-04:

| Filter | Rows | Seats |
|---|---|---|
| `origin IN (JFK,LAX) AND dest IN (JFK,LAX)` | 297 | 3,474,715 |
| The actual undirected route (`least`/`greatest` on the airport-id pair) | 264 | **3,455,820** |

The gap — 33 same-airport rows (2 JFK→JFK, 31 LAX→LAX) — inflates this one route by **18,895
seats** under a `DATA AS OF` badge. The composite-dimension filter built by
`app/src/lib/pivot/render.ts` and `pipeline/pivot.py` (M4b, in lockstep — `sql/03_queries/
pivot_route.sql` itself carries only the `{{FILTERS}}` token these two renderers fill in,
not the filter logic) instead binds `least(route_key_low, route_key_high) = $lo AND
greatest(...) = $hi` per requested route, which cannot match a same-airport row.

**Route storage order (by airport ID) and the alphabetical order a person would type
disagree for 154 of 22,420 routes (0.69%, excluding the 530 same-airport "routes" just
above, which are not routes)** — e.g. `HPN` (12197) and `BNH` (16954): id order is
`HPN-BNH`, but the alphabetical form — used as `/route/<pair>`'s canonical URL — is `BNH-HPN`.
`/route/<pair>` (`app/src/lib/routePair.ts`) computes both explicitly rather than assuming one
predicts the other: the URL is alphabetical (predictable from the two codes alone, no database
lookup needed), the query filter is by ID (matching `route_key_low`/`route_key_high`).
Conflating them would query the wrong route for that 0.7%, or mint a URL nobody would type.

## `fct_route_month` must carry `year`/`quarter`/`month` as GROUP BY keys, not `any_value()`

`any_value()` output is opaque to DuckDB's optimizer: a `WHERE year = 2017` on top of the
view cannot be pushed down through an `any_value(year)` aggregate into
`fct_segment_month`'s Hive-partitioned scan, so every partition file gets opened and
filtered by content instead of pruned by name — silently, since the row count and every
other result is identical either way.

**Measured against the real 2015–2017 warehouse** (`EXPLAIN ANALYZE`, DuckDB 1.5.5),
`SELECT count(*) FROM fct_route_month WHERE year = 2017`:

```
                        any_value(year)     year as GROUP BY key
Total Files Read              3                      1
Scanning Files                (not reported)         1/3
File Filters                  (none)                 (year = 2017)
```

Fixed in M2 fix wave 1 by moving `year`, `quarter`, `month` out of `any_value()` and into
both the `SELECT` list and the `GROUP BY` — each is a pure function of `year_month` (0 of
494,508 route-month groups — distinct `(year_month, op_airline_id, origin_airport_id,
dest_airport_id)` combos, not the 36 distinct `year_month` values themselves — have more
than one distinct value of any of the three), so the
grain is unchanged: `fct_route_month` stayed 494,508 rows and `mart_route_health` stayed
7,336 rows before and after. Guarded structurally (not by a runtime EXPLAIN assertion,
which is brittle — see the `hive_partitioning` pruning pair in
[`pipeline/tests/test_marts.py`](../../pipeline/tests/test_marts.py)) by
`pipeline/tests/test_route_month.py::test_fct_route_month_carries_year_quarter_month_as_group_by_keys_not_any_value`,
which pins the compiled view SQL rather than the fixture's own I/O — the committed CI
fixture has only one fact year, so there is nothing in it to prune.

## City market ids are constant within the route-month grain

`fct_route_month` collapses `fct_segment_month`'s `origin_city_market_id` /
`dest_city_market_id` with `any_value()` — safe ONLY if they don't vary within
`(year_month, op_airline_id, origin_airport_id, dest_airport_id)`. Unlike `year` / `quarter`
/ `month` / `route_key_low` / `route_key_high` (each a pure function of columns the grain
already fixes), city market ids are copied per filed row from `raw.ORIGIN_CITY_MARKET_ID` /
`raw.DEST_CITY_MARKET_ID` — a data assumption, not a structural guarantee, since an airport
genuinely can be reassigned between city markets over time.

**Measured in M2**, over the `data/parquet/t100_segment/` warehouse as it stood then (years
2015–2017, 494,451 non-quarantined `(year_month, op_airline_id, origin_airport_id,
dest_airport_id)` route-months):

```
route_months                      494,451
groups w/ >1 origin_city_market_id      0
groups w/ >1 dest_city_market_id        0
```

**Re-measured in M3a Task 1, over the full 2015–2026 window** (1,861,880 non-quarantined
route-months, after `make fetch` landed all 12 years):

```
route_months                    1,861,880
groups w/ >1 origin_city_market_id      0
groups w/ >1 dest_city_market_id        0
```

Zero groups vary in either direction, in both measurements. Unlike the sibling `distance`
measurement (see [model.md](model.md#distance-is-not-additive)), which DID find non-zero
variance once the full window was measured, this one held. `any_value()` is kept, backed by
a test
(`pipeline/tests/test_route_month.py::test_city_market_ids_are_constant_within_the_route_month_grain`)
that asserts the constancy on every build rather than assuming it silently — a future
violation (e.g. a genuine mid-month market reassignment) surfaces as a failing test instead
of an arbitrarily-picked value with no signal.

## Amended filings: latest `download_date` wins

BTS accepts amended filings and silently overwrites. Stamp every ingest with a
`download_date` and **keep every download**.

> ⚠️ **Correction.** An earlier version said to retain prior *Parquet partitions*. Parquet is
> a derived artifact — the thing that must be retained is the **raw download**, because that
> is what cannot be regenerated. `data/raw/` is therefore **append-only**: filenames carry the
> download date (`t100d_segment_us_2015_20260729.zip`), so a re-fetch adds a file rather than
> destroying the one that produced already-published numbers. Parquet is rebuilt from the
> latest raw and freely discardable.
>
> This was a real hole, not a wording nit: `--force` previously overwrote `data/raw/` in
> place, which contradicted "never mutate `data/raw`" and left the resolution rule with
> nothing to resolve between.

**Resolution rule: latest `download_date` wins per `(year_month, grain key)`; prior
partitions are audit-only and never feed a mart.** Without this the marts are
non-deterministic across rebuilds, which breaks the M2 reproducibility guarantee.

## Builds are byte-reproducible

`make verify` builds the whole warehouse twice from identical raw inputs and compares every
artifact by sha256. It is the M1 exit criterion.

> **DuckDB's parallel Parquet writer is not byte-stable.** At the default 12 threads, two
> runs over the same 282k-row input produced files differing by a few hundred bytes — and
> *intermittently*: `SAME, DIFFER, DIFFER` across three identical runs. Row content was always
> identical; only the encoding drifted. All Parquet writes therefore go through a connection
> pinned to `threads = 1`. Measured cost: 1.07 s vs 0.41 s per year, ~8 s across the window,
> on a job that runs monthly.
>
> A small fixture cannot catch this — repeating a handful of rows keeps cardinality low enough
> that the encoder stays deterministic no matter the threading. The regression test uses a
> real extract and repeats the comparison four times, because one comparison passes by luck.

> **The `.duckdb` catalog file itself is also not byte-stable — measured in M2.** A 200,000-row
> `CREATE TABLE ... AS SELECT` with `threads = 1`, built three times in a row (`a.duckdb`,
> `b.duckdb`, `c.duckdb`) from identical logic, produced three different sha256 digests every
> time:
>
> ```
> a.duckdb  908505c5ccd19fb50dba3eac2efed7fe0ff60c86101111322cd619d0e9418654
> b.duckdb  3636e3f666cdcc2f8a5803183472cd5bce4e1b2b910314b03037a6de5def641e
> c.duckdb  cc06f9e9df1a84ff329367c44cd1fe0296bc0640e78001e3b4c19dbf211ac2eb
> ```
>
> The whole script was run three separate times (nine builds total, to rule out the kind of
> intermittent SAME/DIFFER/DIFFER seen on the Parquet writer above) — **all three invocations
> produced these exact same three digests, in the same a/b/c positions.** So this is not
> flakiness: it is deterministic, reproducible byte-*instability* between files built from
> identical content within the same process. Cause not further isolated (suspect a
> per-connection creation counter or similar metadata in the DuckDB storage header); not needed
> to act on the finding.
>
> **Consequence for M2 (Task 8): `make verify`'s gate must never sha256 the `.duckdb` file
> itself.** The gate has to be content-based — compare query results / table checksums issued
> against the built catalog, the same way the Parquet gate compares row content rather than
> raw bytes.
>
> **Built.** `pipeline.marts.verify_database` (`make verify`'s second gate) is why this
> instability does not matter: it never touches the `.duckdb` file's bytes. It builds the
> database twice and, for each of the 8 catalog objects, exports it through
> `COPY (SELECT * FROM <object>) TO ... (FORMAT PARQUET)` on a connection pinned to
> `SET threads TO 1` — the same setting that makes the Parquet writer above byte-stable —
> then sha256s that export and compares across the two builds. Real run on the 2015–2017
> warehouse: `database: 8 objects identical across two builds`. The catalog file's own
> non-determinism is real and permanent, but it is invisible to the gate because the gate
> never looks at the catalog file's bytes, only at what querying each object produces.

## Column count assertion

The trailing-comma / `EMPTYFIELD` phantom column **does not occur** in what BTS serves
today (verified 2026-07). Don't write the workaround; **do** assert the column count is 45
so a reappearance fails the build rather than shifting every field silently.

---

## Quarantine is a feature

Quarantined rows are **excluded from aggregates but surfaced in the UI** with a count and
reason. Showing the dirt is a trust feature.

Reasons, in precedence order:

| Reason | Fires when |
|---|---|
| `missing_carrier` | no `AIRLINE_ID` |
| `zero_seats` | passenger config, departures performed, no seats |
| `load_factor_gt_1` | `passengers > seats` |

Volumes were originally measured on the **ingested** 2015 subset only — 282,036
scheduled-passenger rows out of 367,360 raw, 16 quarantined (`zero_seats` 4,
`load_factor_gt_1` 12, `missing_carrier` 0) = **0.006%**. That was the only year ingested at
M1.

> ⚠️ **Correction — the 0.006% figure was 2015's rate quoted as though it characterised the
> whole window.** Re-measured in M3a Task 1 over the full **2015–2026** window
> (`fct_segment_month`, `upgauge.duckdb`, all 12 fetched years), per year:
>
> | Year | Rows | Quarantined | Rate |
> |---|---:|---:|---:|
> | 2015 | 282,036 | 16 | 0.0057% |
> | 2016 | 291,339 | 32 | 0.0110% |
> | 2017 | 278,825 | 49 | 0.0176% |
> | 2018 | 284,357 | 94 | 0.0331% |
> | 2019 | 300,821 | 61 | 0.0203% |
> | 2020 | 211,478 | 241 | **0.1140%** |
> | 2021 | 271,967 | 155 | 0.0570% |
> | 2022 | 298,636 | 157 | 0.0526% |
> | 2023 | 320,961 | 165 | 0.0514% |
> | 2024 | 341,577 | 133 | 0.0389% |
> | 2025 | 358,834 | 146 | 0.0407% |
> | 2026 | 118,650 | 52 | 0.0438% (partial year — BTS lags a few months, see [pipeline.md](../architecture/pipeline.md)) |
> | **Total** | **3,359,481** | **1,301** | **0.0387%** |
>
> The rate ranges from **0.0057% (2015) to 0.1140% (2020)** — a ~20× spread across years.
> **2020 alone exceeds the 0.1% ceiling** that
> `pipeline/tests/test_invariants_against_real_data.py::test_quarantine_stays_rare_on_real_data`
> enforces. That test currently reads only the 2015 extract
> (`latest_raw(RAW_DIR, T100D_SEGMENT_US, 2015)`), so it does not exercise 2020 and stays
> green regardless of this finding — a real scoping gap in the test, left as-is here per this
> task's docs-only mandate; widening the real-data suite to the full window is a follow-up,
> not a doc fix. **2020's elevated rate is COVID, not a data defect**: mass route suspension
> and collapsed load factors produce more `zero_seats` and `load_factor_gt_1` filings — the
> reason mix below shows exactly that shift.
>
> Reason mix over the full window: `zero_seats` 1,060, `load_factor_gt_1` 190,
> `missing_carrier` 51.
>
> **`missing_carrier` is no longer 0 outside 2015** — see the correction inline in "Rows with
> no carrier identity — a defensive rule" above, where this rule is owned. 51 rows reach the
> quarantine stage over the full window: 27 in 2018, 24 in 2022, 0 elsewhere.
>
> **A single year's rate must never again stand in for the window's** — that is the whole
> reason this correction exists. Quote the per-year table, or the full-window total, not one
> year's number.

---

## Entity resolution (M4a)

Measured 2026-07-30 against the full 2015–2026 window. Tests:
`pipeline/tests/test_resolution_invariants.py`.

**`dim_airport` needs `WHERE is_latest` on every join.** It is keyed on `airport_seq_id`,
the point-in-time key, and **5,033 `airport_id`s carry more than one `seq_id` row**. An
unfiltered join fans out and multiplies result rows — a wrong total rendered under a
`DATA AS OF` badge, which is worse than an error. Exactly one `is_latest` row exists per
`airport_id`: 0 ids have none, 0 have more than one.

**Zero join orphans.** 0 carriers, 0 airports, 0 aircraft types appear in the facts without
a dimension row. An unresolvable id still degrades to the raw id rather than `—`: absence
of a *name* is not absence of *data*.

**Code collisions were flagged in M4a as an M4b concern, and M4b's reverse lookup
(`/route/<pair>`, `sql/03_queries/lookup_airport_by_code.sql`) is what actually hit one.**
`carrier_code` is reused — **112 codes map to more than one `airline_id`** across
`dim_carrier`, and 60 airport codes collide table-wide (distinct `(airport_id, code)` pairs
across **all** of `dim_airport`'s history, not just the current `is_latest` row). Scoped to
what actually flew in-window, **both are 0** (114 carriers, i.e. distinct `op_airline_id`
values in `fct_segment_month`). `id → code` is a function, so collisions cannot affect
*display*; they only ever break the *reverse* lookup, code → id.

These are three different populations, and it matters which one a given count describes —
the M4a figures above measure the two extremes (all history vs. in-window-only); M4b found a
third, in between, that neither extreme covers:

| Population | Colliding airport codes |
|---|---|
| All of `dim_airport`'s history (every `airport_seq_id` row, `is_latest` or not) | 60 |
| `is_latest = TRUE` rows only, **not** scoped to what flew in-window | **36** |
| `is_latest = TRUE` **and** the `airport_id` appears in `fct_segment_month` | 0 |

**`WHERE is_latest` alone does not make a code unique** — it is scoped per `airport_id`'s own
seq chain, not per code, so two *different* `airport_id`s that happen to share a code can
each carry their own `is_latest = TRUE` row at the same time: 36 codes do. `AUS` is one —
`airport_id` 10423 "Austin - Bergstrom International" (69,132 traffic rows) **and**
`airport_id` 16440 "Robert Mueller Municipal" (closed since 1999, 0 traffic rows) both come
back `is_latest = TRUE`. Fix round 1 on M4b Task 4 caught this after ship: without a
fact-presence filter, whichever row the driver returns last wins the reverse-lookup map in
`app/src/lib/resolve.ts` silently — Robert Mueller today, for a page that says `DATA AS OF`
this month. Restricting to `airport_id`s that actually appear in `fct_segment_month`
(`lookup_airport_by_code.sql`'s fact-presence clause) is what takes colliding codes from 36
to 0, which is why the reverse lookup needs that clause and `is_latest` is not sufficient
alone — `pipeline.tests.test_resolution_invariants`'s in-window scoping already matched this,
which is why it never caught the gap here.

**How that clause is written is a performance decision, and it is now on a hot path.** It
shipped as a correlated `EXISTS (… WHERE f.origin_airport_id = id OR f.dest_airport_id =
id)`; the `OR` across two columns defeats a hash semi-join, so DuckDB re-scanned all 3.36 M
fact rows per candidate. Measured warm, read-only: **43–51 ms**, against 1.8–2.4 ms for the
dimension-only `lookup_airport_code_exists.sql` and ~7–9 ms for the route pivot it precedes.
Since `app/src/proxy.ts` now runs it on every `/route/*` request to decide cacheability, it
was rewritten as a semi-join against `origin_airport_id UNION dest_airport_id`: **8 ms** at
the default thread count, 17 ms capped to `threads=2`, selecting exactly the same airports.
The old form measures the same at 2 threads as at 12 — it does not parallelise at all, which
is the tell that it was re-scanning the fact table rather than probing a hash table.

*Exactly* the same is the load-bearing half, and it is measured rather than argued:
`test_reverse_lookup_selects_exactly_the_fact_present_current_airports` runs the shipped
`.sql` file over **every** `is_latest` code and diffs its result set against the `EXISTS`
form's in both directions (1,045 airports, 0 either way). Both forms are equivalent by
construction — membership in `origin ∪ dest` *is* what that `EXISTS` tests, NULLs included —
but the same test rejects a plausible near-miss: an `origin`-only predicate loses 50
destination-only airports. Two other rewrites were measured and rejected: `id IN (origins) OR
id IN (dests)` is 80 ms (two mark joins, no shared scan), and `UNION ALL` in place of `UNION`
is 21–22 ms (6.7 M probe values instead of 1,045 distinct ones).

### The other two reverse lookups (M4d)

`/carrier/<code>` and `/aircraft/<short_name>` need the same code → id direction, via
`sql/03_queries/lookup_carrier_by_code.sql` and `lookup_aircraft_by_name.sql`. Both are
modelled on the airport file and both carry its fact-presence semi-join, measured warm and
read-only against the correlated `EXISTS` form they replace:

| lookup | correlated `EXISTS` | plain `IN (SELECT col …)` | shipped (`IN (SELECT DISTINCT col …)`) |
|---|---|---|---|
| carrier | 15.1–15.8 ms | 4.6–5.6 ms | **3.5–4.0 ms** |
| aircraft | 23.2–24.5 ms | 4.9–5.1 ms | **4.5–4.6 ms** |

Neither needs an `is_latest` analogue, and that is measured rather than assumed: `dim_carrier`
is one row per `airline_id` and `dim_aircraft_type` one row per `code` (0 ids with more than
one row, either table), so there is no seq chain to collapse and nothing to fan out.

**For carriers the fact-presence filter is the *whole* of what makes a code a key**, since
there is no `is_latest` to share the load. Unscoped, **112** `carrier_code`s map to more than
one `airline_id`; scoped to the 114 airlines that actually filed a T-100 Segment row, **0** do.
`VX` is the `AUS` shape exactly — `airline_id` 21171 "Virgin America" (real in-window traffic)
and 19995 "Aces Airlines" (a defunct Colombian carrier, 0 filed rows). `CP` fans out to three.

**For aircraft the filter is not enough, and this is where the airport result stops
generalising.** 12 `short_name`s map to more than one `code` across `dim_aircraft_type`;
fact-presence takes that to **1**, not to 0:

| `short_name` | code | designation | rows | seats | departures | filed |
|---|---|---|---|---|---|---|
| `CE-180` | `030` | CESSNA 180 | 183 | 994 | 441 | 2015-01 → 2024-07 |
| `CE-180` | `031` | CESSNA 180A/B | 131 | 557 | 189 | 2016-05 → 2025-11 |

Both really flew, so **no scoping resolves this and neither code is the right answer**.
Restricting to the trailing 12 months makes the collision vanish *today* — only `031` filed in
the current window, which is why the M4d brief records in-window collisions as 0 — and brings
it back the first month both types file. That would be the worst available failure shape: a
production error on a URL that worked last month, arriving as data rather than as a code
change. The scope stays all-time.

**So the decision is: a colliding slug fails loudly, and carries its candidates.**
`app/src/lib/resolve.ts`'s `insertUniqueByCode` refuses to fold a repeated slug into its map
and throws `AmbiguousCodeError`, which is a distinct class rather than a bare `Error` for one
reason — for aircraft this is not a should-never-happen, so `/aircraft/CE-180` is a *reachable*
URL and the page for it must name both airframes. The error therefore carries `code` and the
full `ids` list, so a caller renders a disambiguation instead of re-parsing a message. Nothing
is left in the map on collision: a half-populated map is how "fail loudly" decays back into
the arbitrary first-row-wins answer the guard exists to refuse.

The alarm for a *new* collision is
`test_aircraft_reverse_lookup_collides_on_exactly_the_known_CE_180_pair`, which pins the
colliding set **exactly** — `[("CE-180", ["030", "031"])]` — rather than asserting `<= 1` or
excluding `CE-180`. A second ambiguous short name would pass any weaker assertion in silence
and then surface as a 500 nobody signed off on. This is the M4a lesson applied deliberately:
that milestone's collision test could not see the `AUS` pair because of how it was scoped.

**One gap is recorded rather than closed.** The column-side `upper()` in both new lookups is
inert against today's data — 0 lower-case `carrier_code`s, and the single lower-case
`short_name` (`330-9neo`, code 824) has never filed a row, so the fact-presence clause removes
the only row that would notice. Mutation-tested: removing either `upper()` kills no test. Both
are kept, because the day BTS files an A330-900neo that fold is the only thing making
`/aircraft/330-9NEO` resolve, and its absence would be a silent 404. Case-insensitivity that
*is* exercised lives in `runSlugLookup`'s input fold (removing it reddens three tests).

**16 fact-present `short_name`s are not URL path segments**: `A321/LR`, `A320-1/2`, `B767-2/R`,
`B767-3/R`, `CE-206/7`, `CL-604/5`, `CRJ-2/4`, `RJ100/ER`, `SF-340/B`, `FLT/AMPH` carry a `/`,
and `AS350 B2`, `DO-328 J`, `MAX 8`, `MAX 8-20`, `MAX 9`, `METRO 23` carry a space. Percent-
encoding is not an option here — `app/src/proxy.ts` exists because Next re-encodes the query
string, and `%2F` in a path is its own hazard. Replacing both characters with `-` **is
injective over all 111 fact-present short names** (0 collisions, measured), so it is a safe
slug scheme; `test_aircraft_short_names_survive_a_url_path_segment` pins that so a future
refresh that makes it unsafe fails a test rather than a route.

---

## Where these are enforced

`pipeline/invariants.py` holds the rules as pure functions, deliberately knowing nothing
about DuckDB or Parquet so they stay reviewable. `pipeline/mainline_map.py` holds the
date-ranged rollup, loaded from the checked-in `pipeline/reference/mainline_group.csv`.

Two test layers:

- `test_invariants.py` / `test_mainline_map.py` — the rules in isolation, always run.
- `test_invariants_against_real_data.py` — the same rules over a real extract, **skipped
  when `data/raw/` is empty** so a fresh clone stays green. Run `make fetch` locally
  to enable them. This layer is what caught both refinements above; neither was visible
  from synthetic values.

**That skip is load-bearing, and there is no CI to compensate for it.** No automated runner
exists yet (see [architecture/pipeline.md](../architecture/pipeline.md#toolchain)), so this
layer executes only where someone has fetched the full 2015–2026 window. Everywhere else the
suite passes *without* checking a single real row against these rules, and says nothing about
it — the skip is silent by design, which is correct for a clone and dangerous as a
verification claim. Until CI runs with data mounted, "the invariants pass" is only true of
the machine it was run on.
