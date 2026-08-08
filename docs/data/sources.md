# Data sources & acquisition

**v0 uses exactly one dataset:** T-100 Domestic Segment (US carriers), **2015 → present.**

Start at 2015: ~10 years of history. **COVID (2020–21) is deliberately inside the window** —
it's the most dramatic route-death-and-rebirth event in the data and a natural showcase for
Death Watch, Birth Tracker, and the time-machine diff.

Plus lookups: Master Coordinate (airport lat/lon), Carrier Decode, Aircraft Type Decode.

Everything below was confirmed against a live download in the phase-0 spike (2026-07-29),
not inferred.

---

## ⚠️ PREZIP is a dead end for T-100

`https://transtats.bts.gov/PREZIP/` looks like the obvious primary source and is not — which is
the trap, because the directory is live and browsable. **Every T-100 file in it is dated
2015-09-02** — abandoned one-off job outputs, never refreshed:

```
896820853_T_T100_SEGMENT_US_CARRIER_ONLY.zip    9/2/2015 12:14 PM
896834156_T_T100_SEGMENT_US_CARRIER_ONLY.zip    9/2/2015 12:38 PM
896816367_T_T100D_SEGMENT_ALL_CARRIER.zip       9/2/2015 12:04 PM
```

On-Time Performance files in the same directory *are* current to 2026, which is what makes
the directory look maintained. **There is no pre-zipped annual T-100 feed.** Don't spend a
day rediscovering this.

Re-check PREZIP once at ingest time anyway and log what's found — if BTS ever restores a
current T-100 feed there it becomes the cheaper path. Never assume it.

---

## The endpoint

| | |
|---|---|
| Table | **`Table_ID = 259`** — T-100 Domestic Segment (U.S. Carriers) |
| Database | `DB_ID = 110` (Air Carrier Statistics, Form 41 Traffic — U.S. Carriers) |
| Form | `https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FIM&QO_fu146_anzr=Nv4+Pn44vr45` |
| Lookups DB | `DB_ID = 595` (Aviation Support Tables) |

`DL_SelectFields.asp` (no `x`) 302-redirects to `.aspx`. Follow redirects.

### URL params are obfuscated — with two different ciphers

Implemented and tested in `pipeline/btscodec.py`; the test file carries all 17 observed
pairs as its fixtures.

**Query params** use **ROT13 over a 36-character alphabet** (`a-z` then `0-9`). Because the
alphabet is 36 wide, rotating by 13 is **not** an involution — encode and decode are
opposite directions, unlike ordinary ROT13. Letters cross into digits and back
(`o`↔`1`, `s`↔`5`, `r`↔`4`). So `QO_VQ` = `DB_ID`, `Nv4 Pn44vr45` = `Air Carriers`,
`FIM` = `259`.

The case rule is **asymmetric**, and getting it backwards silently breaks the table lookup:

| Input | Table used | Evidence |
|---|---|---|
| lowercase letter | lower | `o` → `1`, `v` → `8` |
| **digit (encoding)** | **upper** | `259` → `FIM` |
| **digit (decoding)** | **lower** | `Z1qr_VQ` → `Mode_ID` (lowercase `o`) |
| uppercase letter | upper | `A` → `N`, `F` → `2` |

**Lookup-table links use plain ROT13** (letters only, digits untouched, self-inverse):
`Y_fReiVPR_PYNff` = `L_SERVICE_CLASS`. Two ciphers on one page. They agree on any letter
that doesn't cross into the digit range — which is exactly what makes the difference easy to
miss, since `QO_VQ` → `DB_ID` decodes correctly under either.

> ⚠️ **BTS is itself inconsistent for one param.** `gnoyr_VQ` is the `Table_ID` param, but
> it decodes to `3able_ID` — its `T` was encoded with plain ROT13 (`g`) instead of the
> 36-cipher (`6`). Every other observed pair follows the rules above. **Don't "fix" the
> codec to accommodate it** — use the literal string. Tracked in
> `btscodec.ANOMALOUS_PARAMS` with a test pinning the behaviour.

This is why `Table_ID=259` is not findable by guessing — the table list has to be fetched
and decoded.

### It's ASP.NET WebForms — the POST is stateful

This is what makes the fetcher more than a `wget` loop:

1. `GET` the form page, keeping cookies (an F5 load-balancer session cookie plus
   `ASPSESSIONID`).
2. Scrape `__VIEWSTATE` (~5 KB), `__VIEWSTATEGENERATOR`, and `__EVENTVALIDATION` (~3.5 KB)
   from the returned HTML.
3. `POST` back to the same URL with those three, the select values, and one `name=on` pair
   **per field you want**.

A stale or missing `__VIEWSTATE` fails. Cookies and viewstate must come from the *same*
GET — don't cache viewstate across runs.

### Form controls

| Control | Values |
|---|---|
| `cboGeography` | `All` + 53 states |
| `cboYear` | `1990`–`2026` |
| `cboPeriod` | **`All`** (= All Months) + `1`–`12` |
| `chkDownloadZip` | `on` → zip response |
| `btnDownload` | `Download` (the submit) |
| 45 field checkboxes | named literally: `SEATS`, `AIRLINE_ID`, … |

Control checkboxes to *exclude* when enumerating data fields: `chkAllVars`, `chkAllGroups`,
`chkDownloadZip`, `chkshowNull`, `chkMergeSub`, `chkDocument`, `chkTermDef`.

**Request all 45 fields explicitly** — the ID columns the
[invariants](invariants.md) depend on are not in the default selection.

### Response

`Content-Type: application/zip`, filename
`T_T100D_SEGMENT_US_CARRIER_ONLY_<YYYYMMDD>_<HHMMSS>.zip`. **The filename is generated at
request time**, so it is not a stable cache key — key the cache on `(table, year)` and
record the served filename as metadata.

Zip contains `T_T100D_SEGMENT_US_CARRIER_ONLY.csv` plus `Documentation.csv` (field
descriptions only — *not* code lookups; fetch those separately from `Download_Lookup.asp`).

### Timing and volume — measured

| | |
|---|---|
| Single month (2024-01) | 7.3 s, 1.25 MB zip → 9.7 MB CSV, **35,936 rows** |
| Full year (2015, `cboPeriod=All`) | **145 s**, 11.7 MB zip, **367,360 rows**, all 12 months |

Roughly **4.4M rows** and **~150 MB** raw for 2015→present. Comfortable.

**Fetch strategy:** annual pulls mean **12 requests instead of 144**, but they're slow
enough to need a generous timeout (600 s) and they're all-or-nothing on failure. Prefer
per-year requests with per-year cache granularity, falling back to per-month on repeated
failure.

### Rules

- Fail loudly rather than silently writing a short file. Back off politely.
- Land raw zips in `data/raw/`. **Never mutate them** — they are the audit trail.

---

## The wider universe (context; all out of scope for v0)

| Dataset | Grain | Lag | Unlocks |
|---|---|---|---|
| **T-100 Domestic Segment (28DS)** | carrier × O × D × aircraft type × month | ~2–4 mo | **v0. Everything below.** |
| T-100 Domestic Market (28DM) | on-flight O&D | ~2–4 mo | Connecting vs. local traffic |
| T-100 International | + foreign carriers | ~6 mo | Transborder / long-haul |
| DB1B | 10% ticket sample, quarterly | ~6 mo | **Fares.** Monopoly premium, yield |
| On-Time Performance | flight + tail number | ~2 mo | Delays, cancellations, rotations |
| Schedule B-43 | aircraft by tail | annual | Fleet age, retirement curves |
| Form 41 | carrier financials | quarterly | CASM/RASM → profitability proxy |
