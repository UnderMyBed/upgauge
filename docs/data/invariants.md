# Data invariants

**Write these as tests FIRST.** They gate M1.

Each rule carries the evidence that justifies it. That is deliberate — a rule without its
evidence gets re-litigated, or "simplified" by someone who doesn't know why it exists.
Measurements are from the phase-0 spike (2024-01 = 35,936 rows; full-year 2015 = 367,360
rows). See [sources.md](sources.md) for how they were obtained.

---

## Key on DOT IDs, never letter codes

T-100 ships `AIRLINE_ID` (DOT-assigned, stable across code / name / holding-company
changes) alongside `UNIQUE_CARRIER` (an IATA-style code that **gets reused by different
airlines over time**). Same for airports: `ORIGIN_AIRPORT_ID` is identity,
`ORIGIN_AIRPORT_SEQ_ID` is the point-in-time key that changes when an airport's attributes
change, and the 3-letter code is neither.

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

## `seats = 0` is not the freighter filter

Quarantine as a data error **only when `AIRCRAFT_CONFIG IN (1,3,4)`**; otherwise it's just
a freighter and should be filtered, not flagged.

Measured on 2024-01: 3,833 rows have zero seats, but **3,576 are genuine freighters
(`CONFIG != 1`) and only 257 are real anomalies.** Conflating them pollutes the quarantine
count — which is a UI trust feature and needs to mean something.

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
`download_date` and retain prior Parquet partitions.

**Resolution rule: latest `download_date` wins per `(year_month, grain key)`; prior
partitions are audit-only and never feed a mart.** Without this the marts are
non-deterministic across rebuilds, which breaks the M2 reproducibility guarantee.

## Column count assertion

The trailing-comma / `EMPTYFIELD` phantom column **does not occur** in what BTS serves
today (verified 2026-07). Don't write the workaround; **do** assert the column count is 45
so a reappearance fails the build rather than shifting every field silently.

---

## Quarantine is a feature

Quarantined rows are **excluded from aggregates but surfaced in the UI** with a count and
reason. Showing the dirt is a trust feature.
