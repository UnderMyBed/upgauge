# Ingest notes — T-100 acquisition, verified

Phase-0 spike output (2026-07-29). Everything here was confirmed against a live download,
not inferred. `PRODUCT.md` §5 and §7 are updated from this; this file is the working detail
a future session needs to re-drive the endpoint.

---

## The endpoint

| | |
|---|---|
| Table | **`Table_ID = 259`** — T-100 Domestic Segment (U.S. Carriers) |
| Database | `DB_ID = 110` (Air Carrier Statistics, Form 41 Traffic — U.S. Carriers) |
| Form | `https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FIM&QO_fu146_anzr=Nv4+Pn44vr45` |
| Lookups DB | `DB_ID = 595` (Aviation Support Tables) |

`DL_SelectFields.asp` (no `x`) 302-redirects to `.aspx`. Follow redirects.

### URL params are obfuscated

TranStats encodes query-string names/values with **ROT13 over a 36-char alphabet**
(`a-z` + `0-9`, case preserved). So `gnoyr_VQ` = `Table_ID`, `QO_VQ` = `DB_ID`,
`Nv4 Pn44vr45` = `Air Carriers`. `FIM` = `259`.

Confusingly, the **lookup-table links use plain ROT13** (letters only, digits untouched):
`Y_fReiVPR_PYNff` = `L_SERVICE_CLASS`. Two different ciphers on one page. Implement both.

`pipeline/btscodec.py` should carry both; the spike version is in the scratchpad.

### It's ASP.NET WebForms — the POST is stateful

This is the part that makes the fetcher more than a `wget` loop. You must:

1. `GET` the form page, keeping cookies (there's an F5 load-balancer session cookie plus
   `ASPSESSIONID`).
2. Scrape `__VIEWSTATE` (~5KB), `__VIEWSTATEGENERATOR`, and `__EVENTVALIDATION` (~3.5KB)
   out of the returned HTML.
3. `POST` back to the same URL with those three, the select values, and one `name=on` pair
   **per field you want**.

A stale or missing `__VIEWSTATE` fails. Cookies and viewstate must come from the *same*
GET — don't cache viewstate across runs.

### Form controls

| Control | Values |
|---|---|
| `cboGeography` | `All` + 53 states |
| `cboYear` | `1990`–`2026` (37 options) |
| `cboPeriod` | **`All`** (= All Months) + `1`–`12` |
| `chkDownloadZip` | `on` → zip response |
| `btnDownload` | `Download` (the submit) |
| 45 field checkboxes | named literally: `SEATS`, `AIRLINE_ID`, … |

Control checkboxes to *exclude* when enumerating data fields: `chkAllVars`,
`chkAllGroups`, `chkDownloadZip`, `chkshowNull`, `chkMergeSub`, `chkDocument`,
`chkTermDef`.

**Request all 45 fields explicitly** by posting each name — the ID columns §7 depends on are
not in the default selection.

### Response

`Content-Type: application/zip`, filename
`T_T100D_SEGMENT_US_CARRIER_ONLY_<YYYYMMDD>_<HHMMSS>.zip`. **The filename is generated at
request time**, so it is not a stable cache key — key the cache on `(table, year, period)`
and record the served filename as metadata.

Zip contains `T_T100D_SEGMENT_US_CARRIER_ONLY.csv` plus `Documentation.csv` (field
descriptions only — *not* code lookups).

### Timing and volume — measured

| | |
|---|---|
| Single month (2024-01) | 7.3 s, 1.25 MB zip → 9.7 MB CSV, **35,936 rows** |
| Full year (2015, `cboPeriod=All`) | **145 s**, 11.7 MB zip, **367,360 rows**, all 12 months |

Measured: ~367k rows/yr → roughly **4.4M rows** for 2015→present, ~12 MB zipped per year, so
the whole raw corpus is on the order of **150 MB**. Comfortable.

**Fetch strategy:** annual pulls mean 12 requests instead of 144, but they are slow enough
that the client needs a generous timeout (600 s) and they're all-or-nothing on failure.
Prefer **per-year requests with a long timeout and per-year cache granularity**, falling
back to per-month on repeated failure.

---

## What the data actually says

Measured on 2024-01 (35,936 rows).

### `CLASS` — and a double-count landmine

Authoritative lookup (`L_SERVICE_CLASS`) — note the **rollup codes**:

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

> 🔴 **`K`, `V`, and `Z` are aggregates of other rows.** §7 correctly says summing
> *operators* doesn't double-count — but summing *service classes* absolutely can if a
> rollup code is present. 2024-01 contained only `F`, `G`, `L`, `P` (no rollups), but this
> must be an assertion, not an assumption: **test that no `K`/`V`/`Z` rows exist in any
> partition**, and fail the build if they appear.
>
> Watch `A`/`C`/`E` too — they're scheduled *passenger* classes. If any carrier files those
> instead of `F`, a bare `CLASS = 'F'` filter silently drops real passenger service.

**Checked at window start:** full-year 2015 contains only `F` (282,335), `G` (36,916),
`L` (39,548), `P` (8,561) — no `A`/`C`/`E`, no `K`/`V`/`Z`. So the landmine does not fire in
either sampled year. That is evidence the assertion will hold, **not** a reason to skip it —
the whole point is that a rollup row appearing in some unsampled year would silently double
the affected route's capacity.

### Carrier identity — spot checks

Full-year 2015 confirms the §2 date-ranged map's subjects are present and distinguishable:

| | |
|---|---|
| Virgin America | `UNIQUE_CARRIER = VX`, **`AIRLINE_ID = 21171`**, 1,048 rows |
| Hawaiian | `UNIQUE_CARRIER = HA`, **`AIRLINE_ID = 19690`**, 747 rows |
| Distinct carriers in 2015 | 127 |

No letter code mapped to more than one `AIRLINE_ID` *within* 2015 — expected, since reuse
happens across years, not inside one. **A cross-year reuse check is still needed** once the
full window is ingested; it belongs in the §7 test suite, not here.

### `AIRCRAFT_CONFIG` — resolves the §7 open question

Authoritative lookup (`L_AIRCRAFT_CONFIG`):

| Code | Meaning | Carries passengers? |
|---|---|---|
| `0` | Not relevant | — |
| **`1`** | **Passenger configuration** | **yes** |
| `2` | Freight configuration | no |
| **`3`** | **Combined passenger + freight, main deck (combi)** | **yes** |
| **`4`** | **Seaplane** | **yes** |
| `9` | Expense capture, not attributed to a type | no — not real ops |

**The passenger filter is `AIRCRAFT_CONFIG IN (1, 3, 4)`, not `= 1`.** Measured in
2024-01: config `3` had 90 rows with passengers, config `4` had 63. Filtering to `1` alone
silently drops combi and seaplane service — and seaplanes are real scheduled passenger
service in Alaska, which is squarely in scope.

**Confirmed at window start.** Full-year 2015 (367,360 rows) shows configs `3` and `4` are
*more* material there than in 2024 — **7,326 passenger-carrying rows** that a `CONFIG = 1`
filter would silently drop:

```
CONFIG    rows    with pax
1      312,431     289,235
2       45,847         122
3        5,313       4,474   <- combi
4        3,769       2,852   <- seaplane (Alaska is in scope)
```

Observed `CLASS × AIRCRAFT_CONFIG` (2024-01):

```
CLASS  CONFIG     rows   seats>0    pax>0
F      1        27,622    27,427   26,357   <- the bulk
F      3            98        98       90   <- combi, real passengers
F      4           115       114       63   <- seaplane, real passengers
G      2         2,730        34        0   <- scheduled freight
L      1         4,243     4,219    2,958   <- charter
P      2           844        14        0
```

### Quarantine volumes — the rules are cheap

| Condition | Count | Note |
|---|---|---|
| `seats == 0` | 3,833 (10.7%) | **3,576 are `CONFIG != 1`** — i.e. genuine freighters |
| `seats == 0` **and** `CONFIG == 1` | **257** | the actual anomalies |
| `load_factor > 1.0` | **5** of 32,103 | quarantining is nearly free |
| `load_factor > 1.5` | 0 | no wild outliers this month |
| `departures_performed == 0` | 194 | zero-activity rows exist and are normal |

> This is the empirical proof for the §7 fix: treating `seats = 0` as "this is a freighter"
> would conflate **3,576 legitimate freighter rows** with **257 real data errors**.
> `AIRCRAFT_CONFIG` separates them cleanly. Quarantine on `seats = 0 AND config IN (1,3,4)`.

### Zero-padded string keys — do not parse as integers

| Field | Example values |
|---|---|
| `AIRCRAFT_TYPE` | `026`, `033`, `035`, `079` |
| `UNIQUE_CARRIER_ENTITY` | `01100`, `01126` |
| `ORIGIN_STATE_FIPS` / `DEST_STATE_FIPS` | `01`, `02`, `04` |

Coercing `AIRCRAFT_TYPE` to int turns `079` into `79` and breaks the join to
`dim_aircraft_type` — silently, since some codes have no leading zero and will still match.
**Keep these as strings throughout.**

### `CARRIER_GROUP` collision — confirmed live

Both BTS columns are present and populated with values unrelated to any mainline rollup:

```
CARRIER_GROUP      {'3': 26715, '1': 4666, '2': 4555}
CARRIER_GROUP_NEW  {'3': 26715, '2': 4555, '5': 3072, '6': 1070, '4': 267, '1': 247, '9': 10}
```

Confirms the §2/§6 rename: ours is `mainline_group`, theirs is preserved as
`bts_carrier_group`.

---

## Spec corrections this produced

1. **No trailing comma / no `EMPTYFIELD` column.** §5 carried this as a known quirk. The
   current download has neither — header and rows both end on `CLASS`. The quirk is real in
   older extracts (which is where the folklore comes from) but does **not** apply to what
   this endpoint serves today. Don't write a workaround for it; do assert the column count.
2. **`AIRCRAFT_CONFIG IN (1,3,4)`**, not `= 1` — see above.
3. **`CLASS` rollup codes** `K`/`V`/`Z` need an explicit exclusion + assertion.
4. **Annual pulls are possible** (`cboPeriod=All`) — 12 requests, not 144 — but slow.
5. **Zero-padded keys must stay strings.**
6. `DL_SelectFields.**asp**` redirects; the real endpoint is `.aspx`.
