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
| ~~4~~ | ~~`normalize.py` — raw → Parquet, quarantine flags, `download_date`~~ | ✅ `make ingest`; 2015 → 282,036 rows, 8.6 MB Parquet |
| ~~5~~ | ~~Lookups → dims; `map_mainline_group` materialized~~ | ✅ 4 dims build; **zero orphans** joining 282,036 fact rows |
| ~~6~~ | ~~Reproducibility gate~~ | ✅ `make verify` — 7 artifacts byte-identical across two builds |

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

### Normalize design notes

- **The transform is SQL, in `sql/01_staging/normalize_t100_segment.sql`**, with bound
  parameters rather than interpolation. That is what lets the server reuse the definition.
- **Read the CSV as all-VARCHAR and cast explicitly.** Letting DuckDB's sniffer pick types
  turns `AIRCRAFT_TYPE` `079` into `79` and breaks the dim join silently.
- **Pre-flight checks run on the raw extract, before filtering.** The rollup-class check has
  to see a `K` row, and the service filter would already have dropped it.
- **Write to a staging dir and swap**, so a failure mid-write can't leave a half-written
  partition that later reads treat as complete. Replaces rather than appends, so a re-run
  cannot double every row.
- **A missing fetch sidecar is an error, not a default.** A guessed `download_date` would
  silently corrupt amended-filing resolution.
- **Nothing derived is stored** — no `load_factor`/`asm`/`rpm`/`avg_gauge` column exists, so
  nothing downstream can `AVG()` one.

**Verified on real 2015 data:** 367,360 raw rows → **282,036** scheduled-passenger rows,
12 months, only `CLASS='F'` and configs 1/3/4, **16 quarantined (0.006%)**, zero route-key
ordering violations, 8.6 MB Parquet from a 94 MB CSV.

### Reproducibility

`make verify` is the M1 exit criterion: `build_all` twice from identical raw inputs, sha256
every artifact, report any that differ by name. It reports rather than raises, so a drifting
build names the offending file.

Two things make it hold:

- **`data/raw/` is append-only.** Filenames carry the download date, so a re-fetch adds a
  file instead of overwriting the one that produced published numbers. `latest_raw` feeds the
  build; superseded downloads are audit-only and never read.
- **Parquet writes are pinned to `threads = 1`.** DuckDB's parallel writer is not byte-stable
  (see [../data/invariants.md](../data/invariants.md)). ~8 s cost across the window.

## M2 — the marts layer

`upgauge.duckdb` is a **hybrid**: facts and dims are views over the Parquet tree, and
`mart_route_health` is the only materialized table. Views keep M1's byte-identical Parquet gate
covering everything derived-free, and the mart materializes because trailing-12 windowing over
the full window is the one genuinely expensive thing in the layer.

Scope is `fct_route_month`, `dim_city_market`, and `mart_route_health`.
`mart_leaderboards` is deferred to M5: which leaderboards exist is an editorial `/watch`
decision, and they are all saved instances of a generic Top-N builder that M3 has not built
yet. Building them now means guessing the presets twice.

### The runner

`pipeline/marts.py` executes `sql/02_marts/*.sql` in filename order. Each file declares its own
materialization in a header directive, so the runner needs no separate manifest to drift:

```sql
-- upgauge: view          (or: table)
-- object: fct_route_month
SELECT ...
```

The runner wraps the body in `CREATE OR REPLACE VIEW <object> AS <body>` or
`CREATE TABLE <object> AS <body>`. That DDL wrapper is the only SQL in Python, and it is the
same shape as `normalize.py`'s already-accepted `COPY (<sql file>) TO ...` — the hard rule is
about *query logic*, which stays in `.sql`.

### Views cannot take bound parameters — so CWD is load-bearing

`CREATE VIEW` captures literal SQL text, so the Parquet root cannot be a `$param` the way every
other path in the pipeline is; it is interpolated at build time. DuckDB resolves relative paths
against the **process CWD, not the database file's directory**, which forces a choice:

- An *absolute* path works in CI and breaks in Docker, because the build machine's
  `/home/runner/...` does not exist in the image. Silently — the file opens fine and every
  query fails on read.
- A *relative* path works anywhere, provided CWD is fixed. So views reference
  `data/parquet/**` relatively, the container sets `WORKDIR /app` with data at `/app/data`, and
  CI builds from the repo root.

A test asserts no absolute path appears in any view definition, because that failure is
invisible until deploy.

### The M2 gate

`make verify` keeps sha256-ing Parquet, and adds: **export every database object back out
through M1's `threads = 1` writer and sha256 that.** Reusing a writer already proven byte-stable
beats inventing new hashing semantics, and it makes the mart's reproducibility the same kind of
claim as the facts'.

Whether the `.duckdb` file is *itself* byte-stable is unknown and is measured before the gate is
written — free-space metadata makes it doubtful, but "doubtful" is what produced the retracted
BTS-encoder-bug claim in M1, so it gets measured rather than assumed. Result recorded in
[../data/invariants.md](../data/invariants.md).

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
