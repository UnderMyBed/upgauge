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

## Column count assertion

The trailing-comma / `EMPTYFIELD` phantom column **does not occur** in what BTS serves
today (verified 2026-07). Don't write the workaround; **do** assert the column count is 45
so a reappearance fails the build rather than shifting every field silently.

---

## Quarantine is a feature

Quarantined rows are **excluded from aggregates but surfaced in the UI** with a count and
reason. Showing the dirt is a trust feature.

Reasons, in precedence order. Volumes are measured on the **ingested** 2015 subset —
282,036 scheduled-passenger rows out of 367,360 raw:

| Reason | Fires when | 2015 volume |
|---|---|---|
| `missing_carrier` | no `AIRLINE_ID` | **0** — defensive; see above |
| `zero_seats` | passenger config, departures performed, no seats | 4 |
| `load_factor_gt_1` | `passengers > seats` | 12 |

**Total 16 rows = 0.006% of ingested passenger rows.** That rate is itself an invariant —
the real-data suite asserts it stays under 0.1%. A rule that fires on ordinary data makes the
whole signal worthless, which is exactly what happened before the departures check was
added.

---

## Where these are enforced

`pipeline/invariants.py` holds the rules as pure functions, deliberately knowing nothing
about DuckDB or Parquet so they stay reviewable. `pipeline/mainline_map.py` holds the
date-ranged rollup, loaded from the checked-in `pipeline/reference/mainline_group.csv`.

Two test layers:

- `test_invariants.py` / `test_mainline_map.py` — the rules in isolation, always run.
- `test_invariants_against_real_data.py` — the same rules over a real extract, **skipped
  when `data/raw/` is empty** so CI and fresh clones stay green. Run `make fetch` locally
  to enable them. This layer is what caught both refinements above; neither was visible
  from synthetic values.
