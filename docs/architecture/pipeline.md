# Pipeline & repo layout

## Repo scaffold

```
upgauge/
├── docs/                       see docs/README.md
├── Makefile                    make ingest / make build / make dev
├── Dockerfile
├── pipeline/                   Python 3.12 + uv. Runs in CI only.
│   ├── btscodec.py             the two TranStats ROT13 variants (data/sources.md)
│   ├── fetch.py                DL_SelectFields POST loop + cache → data/raw/
│   ├── normalize.py            raw → data/parquet/t100_segment/year=YYYY/
│   ├── build.py                runs sql/ in order → upgauge.duckdb
│   └── tests/                  the data invariants. These gate the pipeline.
├── sql/
│   ├── 01_staging/             shared by pipeline AND server. Never inline SQL.
│   ├── 02_marts/
│   └── 03_queries/             the Explorer's parameterized queries
├── app/                        Next.js 15, App Router, TS, Tailwind, shadcn/ui
│   ├── api/                    route handlers → @duckdb/node-api → sql/03_queries/
│   └── (routes)/               explorer, route, airport, carrier, aircraft, watch
└── data/                       gitignored
```

**Charts:** Observable Plot (better than Recharts for dense multi-series time series).
**Maps:** deck.gl + MapLibre + Natural Earth GeoJSON.

---

## Milestones

| | |
|---|---|
| **M1** | Ingest: `DL_SelectFields` POST loop → raw → Parquet, 2015→present. **Invariant tests passing.** |
| **M2** | Marts built by SQL, fully reproducible from scratch via `make`. |
| **M3** | Explorer: pivot query + URL state + table. The foundation — get it right. |
| **M4** | Entity pages: route, airport, carrier, aircraft. Charts. Design system applied. |
| **M5** | Maps (airport + carrier + aircraft), then `/watch` presets. |
| **M6** | Deploy + Cloudflare cache + edge rate limit + monthly cron + **freshness alert**. |

### M1 phase order

Phase 0 is complete — see [../data/sources.md](../data/sources.md) for what it established.

| Phase | Work | Done when |
|---|---|---|
| ~~0~~ | ~~Spike the endpoint~~ | ✅ Endpoint driven, data validated, spec corrected |
| ~~1~~ | ~~Scaffold + toolchain~~ | ✅ `make check` green — uv/3.12, pytest, ruff, `btscodec` |
| ~~2~~ | ~~`fetch.py` — per-year POST loop, viewstate, cache, retries~~ | ✅ `make fetch`; verified live against BTS (see below) |
| ~~3~~ | ~~Invariant tests, written red~~ | ✅ 156 tests; rules in `invariants.py` + `mainline_map.py`, validated against a real extract |
| 4 | `normalize.py` — raw → Parquet, quarantine flags, `download_date` | Invariant suite green |
| 5 | Lookups → dims; `map_mainline_group` as checked-in declarative data | Dims build; map totality asserted |
| 6 | Reproducibility gate | `make ingest` from empty is byte-identical |

**Order rationale:** the spike came first because the acquisition path was the one part of
the spec proven *not* as documented. Tests come after the fetcher but before normalize,
because several invariants had to be resolved empirically — writing them from assumption is
how you get a green suite that's confidently wrong.

`btscodec` landed in phase 1 rather than 2 because it was already proven by the spike, and
leaving it in a scratch directory risked losing reverse-engineering work that took real
effort to recover. It also gives phase 1 something genuine to verify against.

### Fetcher design notes

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
45 columns for 2015, byte-identical to the phase-0 manual download, and a cached re-run
completing in 0.01 s with no network.

## Toolchain

`uv` pins **Python 3.12** via `.python-version`, independent of whatever the system has.
`make check` (lint + test) is the pre-commit gate. Unimplemented `make` targets exit
non-zero rather than succeeding silently, so a half-built pipeline can't look finished.

Node and Docker are not needed until M3 and M6 respectively.

> 🔔 **The cron must fail loudly.** If the monthly ingest breaks, nothing errors — the site
> keeps serving happily and `DATA AS OF` just quietly stops advancing. For a product whose
> entire credibility is that badge, silently serving stale data while claiming freshness is
> the worst failure mode available. Alert when `max(year_month)` hasn't moved in ~45 days,
> and surface staleness in the UI, not only in a log.
