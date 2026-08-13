# Data invariants

**Write these as tests FIRST.** They gate the pipeline.

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

> ⚠️ **The direction is easy to invert, so state it explicitly:** `UNIQUE_CARRIER` is the
> *disambiguated* field. `CARRIER` is the one that collides.

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

## Rows with no carrier identity

**158 rows in 2015 have every carrier field blank** — `UNIQUE_CARRIER`, `AIRLINE_ID`,
`UNIQUE_CARRIER_NAME`, `UNIQUE_CARRIER_ENTITY`, `REGION`, `CARRIER_NAME`,
`CARRIER_GROUP_NEW` — while still reporting real traffic (158 departures performed, 119
with passengers aboard). They cannot be keyed on the operating carrier, which is the grain
of the entire product.

**Those 158 are not quarantined.** All are `CLASS = 'L'` (non-scheduled charter) and none is in
scheduled passenger service, so the service filter removes them before quarantine applies.

> ⚠️ **`missing_carrier` is NOT purely defensive — it fires 51 times over 2015–2026:** 27 rows
> in 2018, 24 in 2022, 0 in every other year (per-year table under "Quarantine is a feature"
> below). Those 51 are quarantined and excluded from aggregates, exactly as designed. Do not
> describe this rule as one that never fires.

Two tests hold the line: one asserts no carrier-less rows reach the 2015 extract, and one
constructs such a row and proves it would be caught. **The first is scoped to 2015 — which
genuinely still has zero — so never read it as a claim about the full window.**

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
exist across 530 airports** — full window (2015-01 → 2026-04), *including* quarantined rows,
which is the right pair of qualifiers here because a filter matches a row whether or not that
row's measures are counted. See the table below for the other three answers. Measured on
JFK–LAX over 2025-05 → 2026-04:

| Filter | Rows | Seats |
|---|---|---|
| `origin IN (JFK,LAX) AND dest IN (JFK,LAX)` | 297 | 3,474,715 |
| The actual undirected route (`least`/`greatest` on the airport-id pair) | 264 | **3,455,820** |

The gap — 33 same-airport rows (2 JFK→JFK, 31 LAX→LAX) — inflates this one route by **18,895
seats** under a `DATA AS OF` badge. The composite-dimension filter built by
`app/src/lib/pivot/render.ts` and `pipeline/pivot.py` (in lockstep — `sql/03_queries/
pivot_route.sql` itself carries only the `{{FILTERS}}` token these two renderers fill in,
not the filter logic) instead binds `least(route_key_low, route_key_high) = $lo AND
greatest(...) = $hi` per requested route, which cannot match a same-airport row.

**Those same-airport rows are excluded from route identity, and they are NOT excluded from
`fct_segment_month`.** The distinction only becomes load-bearing when a page asks about an
airport rather than about a route (`/airport/<code>`), where the query is
`origin_airport_id = X OR dest_airport_id = X` and a same-airport filing satisfies **both**
halves.

**Every count of these rows must name its window AND whether quarantined rows are in it.**
There are four true answers and they differ by up to 4x, so an unlabelled one is not evidence —
it is a number the next milestone will pin an acceptance criterion to. Measured against
`upgauge.duckdb` at `DATA AS OF 2026-04`:

| Window | Quarantined | Rows | Airports | Seats |
|---|---|---|---|---|
| trailing 12 (2025-05 → 2026-04) | excluded | 3,182 | 358 | 601,565 |
| trailing 12 (2025-05 → 2026-04) | **included** | **3,187** | **359** | **601,573** |
| full window (2015-01 → 2026-04) | excluded | 12,696 | 530 | 1,887,193 |
| full window (2015-01 → 2026-04) | **included** | **12,738** | **530** | **1,887,424** |

The bolded rows are the ones quoted elsewhere in this repo, because the question everywhere else
is *which rows a filter matches* — quarantine changes what a row **contributes**, never whether
it is **matched**. Quoting the trailing-12 excluding-quarantined triple (3,182 / 358 /
601,565) and labelling it only "in-window" is how one claim comes to have two spellings.

At SEA the trailing-12 overlap is 18 rows carrying 12,646 seats and 172 departures, enough to
move its seat total from 53,373,806 to 53,386,452 if the two halves are simply added.
**`endpoint_airport_id` is a first-class filter for exactly this** (`filter_mode = 'either'`,
`app/src/lib/pivot/render.ts` / `pipeline/pivot.py`), compiling to `origin = X OR dest = X`, so
`/airport` runs ONE pivot per grain (`app/src/app/airport/[code]/endpoints.ts`): SQL's own
`GROUP BY` counts a same-airport row once, without a separate overlap query or an arithmetic
identity applied after the fact. The alternative — `origin + dest − (origin ∧ dest)`, the third
term its own pivot — is what a pivot vocabulary without that filter forces. A claim that a
segment with one airport at both ends "does not exist" is true of route identity above and
false here.

**A count of an airport's distinct destinations includes the airport itself unless it is
explicitly excluded, and the two answers are both defensible — so an unlabelled one is not
evidence.** This is the same-airport rows above surfacing as an off-by-one in a *count* rather
than in a sum. Measured over the trailing 12 (2025-05 → 2026-04), quarantined rows excluded:

| Airport | Distinct far-endpoints | Excluding the airport itself | Its own same-airport rows |
|---|---:|---:|---|
| SEA | 144 | **143** | 18 rows / 12,646 seats |
| ORD | 268 | **267** | 53 rows / 73,082 seats |

The bolded column is what `endpoints.ts` commits for SEA (143) and what a map of the airport's
network can draw, since a same-airport filing has no second endpoint to draw an arc *to*: its
great circle has zero length. The unbolded column is what the naive `count(distinct
far_endpoint)` returns.

**A fixture built on an airport with no same-airport rows cannot catch this** — but 359 of the
1,045 fact-present airports have at least one in the trailing 12 window (the `359` in the table
above), so the population that can catch it is a third of all airports, not a curiosity. SEA and
ORD are both in it.

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

The fix is moving `year`, `quarter`, `month` out of `any_value()` and into
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

**Measured over the full 2015–2026 window** (1,861,880 non-quarantined
`(year_month, op_airline_id, origin_airport_id, dest_airport_id)` route-months):

```
route_months                    1,861,880
groups w/ >1 origin_city_market_id      0
groups w/ >1 dest_city_market_id        0
```

Zero groups vary in either direction. **The sibling `distance` measurement did NOT hold up the
same way** — it found real variance once measured over the full window
([model.md](model.md#distance-is-not-additive)) — so treat this one as a measured fact about the
current window, not a structural guarantee. `any_value()` is kept, backed by a test
(`pipeline/tests/test_route_month.py::test_city_market_ids_are_constant_within_the_route_month_grain`)
that asserts the constancy on every build rather than assuming it silently — a future
violation (e.g. a genuine mid-month market reassignment) surfaces as a failing test instead
of an arbitrarily-picked value with no signal.

## Amended filings: latest `download_date` wins

BTS accepts amended filings and silently overwrites. Stamp every ingest with a
`download_date` and **keep every download**.

> ⚠️ **What must be retained is the RAW download, not the Parquet partition.** Parquet is a
> derived artifact and is freely rebuilt; the raw zip cannot be regenerated. `data/raw/` is
> therefore **append-only**: filenames carry the download date
> (`t100d_segment_us_2015_20260729.zip`), so a re-fetch adds a file rather than destroying the
> one that produced already-published numbers.
>
> This is not a wording nit — a `--force` that overwrites `data/raw/` in place leaves the
> resolution rule below with nothing to resolve between.

**A re-fetch that changes nothing is never written.** `make ingest` force-refetches the current
year, the previous year and all three support tables on every run, so without this the tree grew
by five zips per run whether or not BTS had published anything. Measured on the real `data/raw/`
after two consecutive publisher days: **all five** of the 2026-08-08 downloads were identical in
CSV content to their 2026-08-07 counterparts — **20.3 MB of a 162.4 MB tree, accrued in one
day**, tracking to roughly 20–28 MB per published month (240–340 MB/year) against a 2 GB
per-asset ceiling on the `raw-*.tar.zst` release. The daily publisher *and* the nightly
`verify.yml` each download and re-pack that asset, so the cost arrives long before the ceiling
does.

`pipeline.fetch._unchanged` compares the incoming body against `latest_raw()` and skips the
**write** — the request still happens, since only BTS can say whether anything changed. Growth
is now proportional to actual revisions rather than to run count.

> **The digest is over the extracted data CSV, never the zip.** Measured on
> `aircraft_types_2026080{7,8}.zip`: identical member CRCs (`c78623da`, `598b52b0`) and identical
> sizes, but entry mtimes of `2026-08-08 01:18:58` against `22:18:04` — BTS regenerates the
> archive per request, so the zip bytes differ every single time while the data does not. A
> `sha256(body)` dedupe would report every re-download as new, forever. `Documentation.csv` is
> excluded for the same reason: it ships in every zip and a docs-only edit would read as a data
> change.

This **strengthens** the append-only rule rather than qualifying it. Nothing is overwritten and
nothing is deleted; a redundant download is simply never created, so the file that produced
already-published numbers stays exactly where it is. When content genuinely changes, the new
file is appended as before and `latest_raw()` resolves to it — proven by mutant: forcing
`_unchanged` to always return `True` reddens the "amended filing appends" tests in both
`test_fetch_dedupe.py` and `test_lookups.py`. An existing file that cannot be read is treated as
"no comparison available" and the new download is written; a malformed **new** body still raises,
because writing it would poison the tree.

**Resolution rule: latest `download_date` wins per `(year_month, grain key)`; prior
partitions are audit-only and never feed a mart.** Without this the marts are
non-deterministic across rebuilds, which breaks the reproducibility guarantee.

## Builds are byte-reproducible

`make verify` builds the whole warehouse twice from identical raw inputs and compares every
artifact by sha256.

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

> **The `.duckdb` catalog file itself is also not byte-stable.** A 200,000-row
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
> **Consequence: `make verify`'s gate must never sha256 the `.duckdb` file itself.** The gate has to be content-based — compare query results / table checksums issued
> against the built catalog, the same way the Parquet gate compares row content rather than
> raw bytes.
>
> `pipeline.marts.verify_database` (`make verify`'s third gate) is why this instability does not
> matter: it never touches the `.duckdb` file's bytes. It builds the database twice and, for
> every catalog object, exports it through
> `COPY (SELECT * FROM <object>) TO ... (FORMAT PARQUET)` on a connection pinned to
> `SET threads TO 1` — the same setting that makes the Parquet writer above byte-stable —
> then sha256s that export and compares across the two builds. The catalog file's own
> non-determinism is real and permanent, but it is invisible to the gate because the gate
> never looks at the catalog file's bytes, only at what querying each object produces. The
> object count lives in [../architecture/pipeline.md](../architecture/pipeline.md#reproducibility).

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

> ⚠️ **A single year's quarantine rate must never stand in for the window's.** Quote the
> per-year table or the full-window total, never one year's number — the rate spans a ~20×
> range. Measured over the full **2015–2026** window (`fct_segment_month`, `upgauge.duckdb`),
> per year:
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
> The rate ranges from **0.0057% (2015) to 0.1140% (2020)**. **2020 alone exceeds the 0.1%
> ceiling** that
> `pipeline/tests/test_invariants_against_real_data.py::test_quarantine_stays_rare_on_real_data`
> enforces — and that test reads **only the 2015 extract**
> (`latest_raw(RAW_DIR, T100D_SEGMENT_US, 2015)`), so it never exercises 2020 and stays green
> regardless. **That is a live scoping gap in the test, not a resolved one.**
>
> **2020's elevated rate is COVID, not a data defect**: mass route suspension and collapsed load
> factors produce more `zero_seats` and `load_factor_gt_1` filings, and the reason mix shows
> exactly that shift — `zero_seats` 1,060, `load_factor_gt_1` 190, `missing_carrier` 51 over the
> full window. On `missing_carrier`'s 51, see "Rows with no carrier identity" above, which owns
> that rule.

---

## Entity resolution

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

**Code collisions only ever bite the reverse lookup** (`/route/<pair>`,
`sql/03_queries/lookup_airport_by_code.sql`).
`carrier_code` is reused — **112 codes map to more than one `airline_id`** across
`dim_carrier`, and 60 airport codes collide table-wide (distinct `(airport_id, code)` pairs
across **all** of `dim_airport`'s history, not just the current `is_latest` row). Scoped to
what actually flew in-window, **both are 0** (114 carriers, i.e. distinct `op_airline_id`
values in `fct_segment_month`). `id → code` is a function, so collisions cannot affect
*display*; they only ever break the *reverse* lookup, code → id.

These are three different populations, and it matters which one a given count describes. The
figures above measure the two extremes (all history vs. in-window-only); the reverse lookup
lands on a third, in between, that neither extreme covers:

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
back `is_latest = TRUE`. Without a fact-presence filter, whichever row the driver returns last wins the reverse-lookup map in
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

### Airport coordinates, and the six that are east of the antimeridian

Measured 2026-08-01 against the 1,045 fact-present airports (`fct_segment_month`'s origin ∪
dest, joined on `is_latest`). Recorded here because anything that places an airport
geographically depends on both facts, and neither is guessable from the schema.

**Every fact-present airport has coordinates.** `lat` and `lon` are NULL for **0** of the
1,045. A geographic view needs no "not drawn, coordinates missing" disclosure, which is
otherwise exactly the kind of gap this repo insists on stating.

**Six carry a POSITIVE longitude**, and a naive `lon < some_western_bound` test silently
misfiles all of them:

| Code | Name | State | Lat | Lon |
|---|---|---|---:|---:|
| GUM | Guam International | TT | 13.48 | 144.80 |
| UAM | Andersen AFB | TT | 13.58 | 144.93 |
| ROP | Benjamin Taisacan Manglona International | TT | 14.17 | 145.24 |
| TIQ | Francisco Manglona Borja Tinian International | TT | 15.00 | 145.62 |
| SPN | Francisco C. Ada Saipan International | TT | 15.12 | 145.73 |
| **SYA** | **Eareckson AS (Shemya)** | **AK** | **52.71** | **174.11** |

**SYA is the trap.** It is in *Alaska*, and the western Aleutians cross the antimeridian, so a
predicate of the shape "Alaska means `lon < −129`" excludes a genuinely Alaskan airport while
handing it to whatever branch catches everything else. Normalizing `lon > 0 → lon − 360` puts
Shemya at −185.9°, contiguous with the rest of the Aleutian chain (which reaches −176.6°), and
Guam at −215.2°.

Two further groupings that a "lower 48 / Alaska / Hawai'i" split gets wrong, for the same
reason — the fallback branch catches whatever the two explicit tests miss:

- **American Samoa is in the southern hemisphere.** PPG (Pago Pago) is at **−14.3°** latitude,
  and Midway (MDY) at 28.2° / −177.4°. A `lon < −150 AND lat < 30` test for Hawai'i catches
  both, giving a "Hawai'i" population spanning 42° of latitude when Hawai'i itself spans 2.3°.
- **Puerto Rico and the USVI extend the conterminous bounding box in BOTH directions**, so no
  single rectangle holds them and the lower 48 legibly. They span lat 17.70 → 18.49 and lon
  −67.15 → −64.71, against a conterminous fact-present extreme of **PQI (Maine, −68.05°)** in
  the east and **EYW (Key West, 24.56°)** in the south. Every one of them is therefore east of
  every airport in the lower 48 — by up to 3.34° — *and* 6.86° south of the southernmost.

### The other two reverse lookups

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

**What the filter therefore makes a 404, and what `/carrier/<code>` may honestly say about
it.** The filter is not a tie-breaker between near-equals — it removes
the overwhelming majority of the table. **1,543 of `dim_carrier`'s 1,657 distinct codes have no
fact-present holder at all** — 1,657 is the count of DISTINCT `carrier_code`s; 1,776 is the
table's row count, one per `airline_id`, and 1,657 − 114 fact-present carriers = 1,543 exactly.
So a code that is real, recognized by BTS, and simply never filed a T-100 Segment row in this
window is the **common** carrier 404, not the exotic one: `PA` (Pan American World Airways —
`airline_id` 20384 and 20386, plus 20389 "Florida Coastal Airlines") reaches it by exactly the
same path as `ZZ`, which is in `dim_carrier` not at all.

**Telling those two apart needs its own lookup** — `sql/03_queries/lookup_carrier_code_exists.sql`,
mirroring the airport file's existence-only shape but returning `id`/`name` as well as `code`.
Without it the page can only state the thing true of both (*nothing has filed under this code*)
rather than calling Pan Am unknown. With it, `/carrier/<code>` makes the same two-way split
`/route/<pair>` has: `ZZ` 404s
"unknown carrier code"; `PA` 404s "recognized by BTS ... none of which has filed a T-100
Segment row", naming every holder.

**Naming "every holder" is load-bearing, not cosmetic — a carrier code can hold more than one
airline_id, same as an airport code can hold more than one `airport_id`.** Of the 1,543
never-filed codes, **94 name MORE THAN ONE airline** (1,643 total `dim_carrier` rows sit behind
those 1,543 codes; worst case is 3). `PA` is that worst case: two rows both named "Pan American
World Airways" (20384, 20386) plus a *third*, "Florida Coastal Airlines" (20389) — a genuinely
unrelated carrier that happens to share the code. A 404 reading "`PA` is Pan American" — this
file's own phrasing before this measurement — silently picks one of three, which is the exact
`AUS` failure shape one dimension over: whichever holder a template happened to name first would
be an arbitrary, confident answer about the wrong airline. `app/src/lib/carrier.ts`'s
`carrierNotFoundReason` lists every one of `carrierHoldersByCode`'s rows instead.

**A resolvable carrier with an empty trailing-12 table is normal, not an error.** **45 of the
114 fact-present airlines last filed before 2025-05** (measured, 39%) — Virgin America's last
month is 2018-03 — which is why `/carrier/<code>` renders the full-window chart independently
of the trailing-12 table and names the range the chart can actually draw. Same shape as the
12,062-of-22,950 route pairs recorded under § Route identity.

**For aircraft the filter is not enough, and this is where the airport result stops
generalising.** 12 `short_name`s map to more than one `code` across `dim_aircraft_type`;
fact-presence takes that to **1**, not to 0:

| `short_name` | code | designation | rows | seats | departures | filed |
|---|---|---|---|---|---|---|
| `CE-180` | `030` | CESSNA 180 | 183 | 994 | 441 | 2015-01 → 2024-07 |
| `CE-180` | `031` | CESSNA 180A/B | 131 | 557 | 189 | 2016-05 → 2025-11 |

Both really flew, so **no scoping resolves this and neither code is the right answer**.
Restricting to the trailing 12 months makes the collision vanish *today* — only `031` filed in
the current window — which is why an in-window-scoped count records 0 collisions — and brings
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

**`AmbiguousCodeError` names exactly two ids, and that is a documented bound rather than a
general one.** `insertUniqueByCode` throws on the *second* colliding row, carrying
`[existing.id, row.id]`, so a three-way collision would surface as two — and `/aircraft`'s
ambiguity 404, which renders one named airframe and one Explorer permalink per id, would omit
the third in silence. Unreachable today: exactly one fact-present short-name collision exists
(`CE-180`), with exactly two codes. But three-way collisions are not hypothetical in this
catalog — unscoped `CP` returns **three** airlines (above), and only the fact-presence clause
takes that to one. Accumulating every colliding row before throwing is the general fix; it is
deliberately **not** taken, because the delete-on-collision semantics above (nothing is left in
the map) is what stops a caught error from leaving a first-row-wins map behind, and changing
both at once for an unreachable case buys nothing. If a fact-presence filter ever stops
delivering uniqueness, this is the line to revisit first.

The alarm for a *new* collision is
`test_aircraft_reverse_lookup_collides_on_exactly_the_known_CE_180_pair`, which pins the
colliding set **exactly** — `[("CE-180", ["030", "031"])]` — rather than asserting `<= 1` or
excluding `CE-180`. A second ambiguous short name would pass any weaker assertion in silence
and then surface as a 500 nobody signed off on. An in-window-scoped collision test cannot see
the `AUS` pair at all, which is exactly how this class of test goes blind.

**One gap is recorded rather than closed.** The column-side `upper()` in both new lookups is
inert against today's data — 0 lower-case `carrier_code`s, and the single lower-case
`short_name` (`330-9neo`, code 824) has never filed a row, so the fact-presence clause removes
the only row that would notice. Mutation-tested: removing either `upper()` kills no test. Both
are kept, because the day BTS files an A330-900neo that fold is the only thing making
`/aircraft/330-9NEO` resolve, and its absence would be a silent 404. Case-insensitivity that
*is* exercised lives in `runSlugLookup`'s input fold (removing it reddens three tests).

**15 fact-present `short_name`s are not URL path segments**: `A320-1/2`, `B767-2/R`,
`B767-3/R`, `CE-206/7`, `CL-604/5`, `CRJ-2/4`, `RJ100/ER`, `SF-340/B`, `FLT/AMPH` carry a `/`,
and `AS350 B2`, `DO-328 J`, `MAX 8`, `MAX 8-20`, `MAX 9`, `METRO 23` carry a space. Percent-
encoding is not an option here — `app/src/proxy.ts` exists because Next re-encodes the query
string, and `%2F` in a path is its own hazard. Replacing both characters with `-` **is
injective over all 111 fact-present short names** (0 collisions, measured), so it is a safe
slug scheme; `test_aircraft_short_names_survive_a_url_path_segment` pins that so a future
refresh that makes it unsafe fails a test rather than a route.

**That list was 16 until 2026-08-07, and the name that left it is the rule worth keeping.**
`T_AIRCRAFT_TYPES` carries **current identity with no name history** — one row per
`AC_TYPEID`, whose `BEGIN_DATE`/`END_DATE` date the *type*, never the *name* — exactly like
`dim_carrier`'s `carrier_code` (see the hard rule in `CLAUDE.md`). So BTS can rename a type
under a built warehouse and nothing in the data flags it. Measured: code **699** was
`A321/LR` on `aircraft_types_20260729` and is `A321nXLR` on `20260807`; its `LONG_NAME` moved
from `AIRBUS INDUSTRIE A321/LR` to `AIRBUS INDUSTRIE A321neoXLR` in the same refresh. The raw
extract carries only the new name — there is no superseded row to fall back to.

Three consequences, all of them observed rather than predicted:

1. **A rename is not a data movement, and the two are easy to confuse.** The rename reddened
   17 assertions and one `app/smoke.sh` needle (`B757-2 overtakes A321/LR · 2018`). Every
   underlying *number* was unchanged — JFK–LAX's yearly leader table re-measured
   byte-identical, ATL–MCO still crosses over in 2018, and 699's gauge spread is still
   B6 176.0 → F9 230.0 full-window / 172.3 → 230.0 trailing-12. Re-measure before concluding
   the facts moved.
2. **A fixture can lose the property it was chosen for.** `A321/LR` was *the* worked example
   for the slug transform, and `A321nXLR` carries no separator at all — so the renamed type
   cannot exercise the mechanism, and the assertions would have passed against the very bug
   they exist to catch. The fixtures moved to **`A320-1/2`** (code 694), chosen on traffic and
   on still-filing: 987 M seats over the full window, current as of 2026-04. `B767-2/R` reads
   like a fine substitute and is a trap — 35 rows, and it stopped filing in 2020-10.
3. **Prefer a fixture whose slug has two separators.** `A320-1/2` exercises the `3^2`
   candidate expansion where `A321/LR` only reached `3^1`.

The separator-count distribution shifted exactly as that one rename predicts: **37 names carry
none, 64 carry one, 10 carry two** (was 36/65/10). Max is still 2, so `MAX_SLUG_SEPARATORS = 4`
keeps its headroom.

**The app side re-pins the same measurement.** `slugFor()` in
`app/src/lib/aircraftSlug.ts` is that transform; `aircraftSlug.test.ts` enumerates every
fact-present type through the ordinary pivot and asserts **112 codes → 111 distinct slugs, with
`CE-180` the only repeat and that repeat being the short name colliding with itself** rather than
two names flattened together. The distinction matters: a future BTS refresh could collide two
*distinct* names (the transform maps two characters onto one that already occurs in `B737-8`), and
that would be a new failure, not this one. The separator count is pinned in the same test — **max
2 across all 111 slugs** — because resolving a slug expands it back into `3^n` candidate short
names, which is capped at 4 separators.

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

**That skip is load-bearing, and CI now compensates for it — but only in the one job that
restores raw.** The per-PR `check` job (`.github/workflows/ci.yml`) restores the warehouse but
not `data/raw/`, so this layer skips there by design, same as on a fresh clone — and that job
greps the pytest output for the skip *reasons* that mean the restore itself broke (`no built
catalog`, `no built Parquet warehouse`), so a silently-broken restore still fails loudly even
though a by-design skip does not. `verify.yml` runs nightly, restores `data/raw/`, and runs
`make check` — so this layer executes against the real 2015–2026 window automatically, once a
day, with nobody's laptop involved. Full accounting:
[architecture/pipeline.md](../architecture/pipeline.md#toolchain).

The underlying caution still holds on any machine or job that skipped for lack of data: a green
suite without `data/raw/` mounted is a materially weaker claim than the same number with it, and
the count alone does not say which one produced it — read the skip reasons, not just the
totals.
