# Upgauge

A structural intelligence layer over US DOT / BTS airline data. Answers: *"Is this route
healthy, and what is the airline about to do to it?"* Not a flight search tool, not a fare
tracker, not real-time.

**`docs/` is the source of truth — start at [docs/README.md](docs/README.md).** This file
records the rules that are easy to violate accidentally. It does not restate the docs.

## Working agreements

### Docs are part of every change

A change to behavior, a data rule, or a decision **is not done until the relevant doc
reflects it — in the same commit.** Not a follow-up, not a TODO.

**Decompose findings into the topic docs. Never add a new markdown file per
investigation.** Review notes, spike results, and audit findings belong in the file that
owns the subject — `docs/data/invariants.md`, `docs/architecture/hosting.md`, and so on.
One-off artifact files fragment the truth, go stale silently because nothing forces a
revisit, and end up stating the same rule three ways.

**Keep evidence attached to the rule it justifies.** Measured counts, distributions, and
prices go inline next to the constraint they support. A rule without its evidence gets
re-litigated or "simplified" by someone who doesn't know why it exists.

### Use the superpowers skills

Invoke the applicable skill before starting a unit of work, and say which one:

| Situation | Skill |
|---|---|
| Any creative/design work, new feature | `superpowers:brainstorming` **first** |
| A spec or requirements → multi-step work | `superpowers:writing-plans` |
| **A written plan → doing the work** | **`superpowers:subagent-driven-development`** |
| Implementing a feature or bugfix | `superpowers:test-driven-development` |
| A bug, test failure, unexpected behavior | `superpowers:systematic-debugging` |
| Before claiming anything works/passes | `superpowers:verification-before-completion` |

**A milestone is never hand-walked phase by phase in the main conversation.** M1 was, and it
cost real quality: the phase-1 "BTS encoder bug" claim survived four phases before phase 5
disproved it, and `zero_seats`, the `CARRIER`/`UNIQUE_CARRIER` direction, and the
append-only raw rule each shipped wrong and got corrected two phases later. A plan file with
one task per unit of work, each dispatched to a subagent that reports back, is what catches
that at the task boundary instead of three commits downstream. Plan → tasks → subagents.

TDD matters most here: the data invariants are written as **failing tests before** the
pipeline that satisfies them. That is both this project's rule and the skill's shape.

## Status

**M1 COMPLETE.** `make ingest` fetches and builds facts + 4 dims from BTS; `make verify`
proves 7 artifacts byte-identical across two builds. 253 tests green, zero join orphans.
`data/raw/` currently holds 2015–2017; run `make fetch` for the full window.

Next: **M2** — marts built by SQL in `sql/02_marts/`, reproducible via `make build`.

## Architecture

Read-only dataset, refreshed monthly, **no writes ever** — so there is no database server.
DuckDB file + Parquet, queried in-process. Always-on box (not scale-to-zero): DuckDB
aggregation wants RAM, and a cold start lands on the first click of every shared link.

```
pipeline/    Python 3.12 + uv. CI only, never runs in prod.
sql/         01_staging/ 02_marts/ 03_queries/ — shared by pipeline AND server
app/         Next.js 15 App Router, TS, Tailwind, shadcn/ui
data/        gitignored. raw/ is the audit trail
```

Charts: Observable Plot. Maps: deck.gl + MapLibre + Natural Earth GeoJSON (no tiled
basemap — tiles are usage-priced).

## Commands

`uv` pins Python 3.12 via `.python-version`. Unimplemented targets exit non-zero on purpose.

| Command | Description | |
|---------|-------------|---|
| `make install` | `uv sync --extra dev` | ✅ |
| `make check` | **Lint + test. Run before every commit.** | ✅ |
| `make test` / `make lint` / `make fmt` | pytest / ruff check / ruff format | ✅ |
| `make fetch` | BTS T-100 zips → `data/raw/` (skips cached years) | ✅ |
| `make fetch-reference` | BTS support tables → `data/raw/` | ✅ |
| `make normalize` | Raw zips → `data/parquet/t100_segment/year=YYYY/` | ✅ |
| `make warehouse` | Facts + all 4 dims from `data/raw/` | ✅ |
| **`make verify`** | **M1 gate: build twice, prove byte-identical** | ✅ |
| `make ingest` | `fetch` + `fetch-reference` + `warehouse` | ✅ |
| `make build` | Run `sql/` in order → `upgauge.duckdb` | M2 |
| `make dev` | Next.js dev server (needs node) | M3 |

## Hard rules

**Derived measures are never stored, never averaged.** Compute from summed numerator and
denominator at query time.

```sql
AVG(load_factor)                                  -- WRONG. Plausible-looking garbage.
SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)   -- RIGHT. Always.
```

Enforce structurally: **no `load_factor` column on any fact table.** Same for `asm`, `rpm`,
`avg_gauge`, `completion_factor`. Can't average what doesn't exist. The #1 bug in every
homemade T-100 tool.

**Key on `AIRLINE_ID` and `AIRPORT_ID`, never letter codes.** `CARRIER` (raw IATA) is
reused — 135 of 1,825 codes map to >1 airline. `UNIQUE_CARRIER` doesn't collide, but only
because BTS suffixes it (`2T (1)`), so it's a poor display code. Join on IDs, display
`carrier_code`. `AIRPORT_SEQ_ID` is the point-in-time key.

**`dim_carrier` carries the CURRENT carrier code, not the point-in-time one.** v0 collapses
Carrier Decode to one row per airline. Never join on `carrier_code`, and don't present it as
historical fact. Also: BTS dates arrive as strings like `1/1/1960 12:00:00 AM` — **parse
before sorting**, or Horizon surfaces as `HOZ` and SkyWest as `SEA`.

**Operating carrier is the grain and the truth.** T-100 Segment is filed by whoever operated
the metal — a Delta-branded regional flown by Endeavor files as `9E`, not `DL`. Summing
carriers on a route does *not* double-count. There is no marketing-carrier field; don't try
to infer one.

**`map_mainline_group` is DATE-RANGED and wholly-owned only.** Alaska acquired Virgin
America (2016-12) and Hawaiian (2024-09), both in-window, so a flat map is wrong before each
acquisition and omission is wrong after. Never roll up shared regionals (SkyWest `OO`,
Republic `YX`, Mesa `YV`) or contract carriers — no date range fixes those; they fly for
several mainlines on the same day. Test: no overlapping ranges per `airline_id`, and
Hawaiian rolls up from 2024-09 but not 2024-08.

**Don't reuse the name `carrier_group`.** T-100 already ships `CARRIER_GROUP` /
`CARRIER_GROUP_NEW` — BTS's revenue-based filing classification, unrelated to our rollup.
Ours is `mainline_group`; theirs is `bts_carrier_group`.

**All query logic lives in `.sql` files.** Never inline SQL in Python or TS string literals.
This is what lets the pipeline and the server share definitions and keeps a DuckDB-WASM port
possible.

**Segment only.** Never blend T-100 Segment with Market or DB1B.

**`data/raw/` is APPEND-ONLY.** Filenames carry the download date
(`t100d_segment_us_2015_20260729.zip`), so a re-fetch adds a file rather than destroying the
one that produced published numbers. `latest_raw()` feeds the build; superseded downloads are
audit-only. Parquet is derived and freely rebuilt.

**All Parquet writes go through `_writer_connection()` (`threads = 1`).** DuckDB's parallel
writer is not byte-stable — it drifts *intermittently*, which is worse than consistently.
Never call `duckdb.connect()` directly for a write.

**Stay portable.** `docker run` against the same `.duckdb` file must behave identically.
Docker + Parquet + env vars only. **No provider-specific runtimes** (Workers, D1, KV) —
Cloudflare is CDN and rate limiting, nothing more.

## Data gotchas

Full detail and the measurements behind each: `docs/data/invariants.md`.

- **PREZIP is dead for T-100** — every file there is dated 2015-09-02. The
  `DL_SelectFields.aspx` POST is the only path, it's ASP.NET WebForms (GET for cookies +
  `__VIEWSTATE`, then POST), and TranStats obfuscates URL params with *two* ROT13 variants.
- **Passenger filter is `AIRCRAFT_CONFIG IN (1,3,4)`**, not `= 1` — configs 3 (combi) and 4
  (seaplane) carry real passengers.
- **`CLASS` has rollup codes** `K`(=F+G), `V`, `Z`. Summing service classes can double-count.
  Assert their absence.
- **`seats = 0` needs both checks** — quarantine only when config is a passenger config
  **and** departures were performed. 5,713 of 2015's 5,717 zero-seat rows never flew; they
  are ordinary "no service" filings, not anomalies.
- **Rows with no `AIRLINE_ID` exist** (158 in 2015, carrying real traffic) — but all are
  `CLASS='L'` charter, so the service filter removes them. `missing_carrier` is a
  **defensive** rule, not routine handling.
- **`load_factor > 1.0`** → quarantine, **never clamp.** Quarantined rows are excluded from
  aggregates but surfaced in the UI with count + reason. Showing the dirt is a trust feature.
- **Zero-padded codes stay strings** — `AIRCRAFT_TYPE` `079` becomes `79` if int-parsed, and
  the join breaks silently.
- **No trailing comma / `EMPTYFIELD`** in what BTS serves today. Assert the 45-column count
  instead of writing the workaround.

## UI constraints

Product truths, not style preferences. The design session owns palette, type, and the
signature element; it does not own these.

- **All numerics monospaced, tabular-figure, right-aligned, fixed decimals.**
- **`DATA AS OF: YYYY-MM` is a first-class element** on every data view, in the accent color.
  The lag is our credibility.
- **Density over whitespace.** Sparklines in rows, hairline rules. No card soup.
- **URL-encoded query state on every view.** Permalinks are the entire growth mechanic.
- **Every insight row is one click from the raw rows that produced it.**
- Derived measures labeled as computed. Quality floor: responsive, visible keyboard focus,
  reduced-motion honored.

## Workflow

- **Invariants are written as failing tests first**, before the pipeline that satisfies them.
- Marts must rebuild from scratch reproducibly via `make`. No manual steps.
- Every response gets `Cache-Control: public, s-maxage=2592000,
  stale-while-revalidate=86400`. Precompute leaderboards as static JSON at build time — the
  caching is the cost control, not the hosting tier.
- Build the **aircraft-type-mix chart before the load-factor chart**. Everyone does load
  factor; the gauge story is the differentiator.
- Build the generic Top-N builder once; the `/watch` presets are saved instances of it.
- **The cron must fail loudly.** A broken ingest doesn't error — the site keeps serving and
  `DATA AS OF` silently stops advancing. Alert when `max(year_month)` hasn't moved in ~45
  days.
