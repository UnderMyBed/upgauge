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
| Implementing a feature or bugfix | `superpowers:test-driven-development` |
| A bug, test failure, unexpected behavior | `superpowers:systematic-debugging` |
| Before claiming anything works/passes | `superpowers:verification-before-completion` |
| A spec or requirements → multi-step work | `superpowers:writing-plans` |

TDD matters most here: the data invariants are written as **failing tests before** the
pipeline that satisfies them. That is both this project's rule and the skill's shape.

## Status

**M1, phase 4** (`normalize.py`: raw → Parquet). Phases 0–3 done: endpoint validated,
scaffold up, `make fetch` verified live, and the invariants are enforceable code
(`pipeline/invariants.py`, `pipeline/mainline_map.py`) with 156 tests green.

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
| `make ingest` | `fetch` + normalize → `data/parquet/` | M1 p4 |
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

**Key on `AIRLINE_ID` and `AIRPORT_ID`, never letter codes.** DOT-assigned IDs are stable
across code/name/ownership changes; IATA-style codes **get reused by different airlines over
time**. Join on IDs, display codes. `AIRPORT_SEQ_ID` is the point-in-time key.

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

**Never mutate `data/raw/`.** Raw zips are the audit trail. BTS accepts amended filings and
silently overwrites — latest `download_date` wins per `(year_month, grain key)`; prior
partitions are audit-only.

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
- **Rows with no `AIRLINE_ID` exist** (158 in 2015, carrying real traffic) → `missing_carrier`
  quarantine. Unattributable to an operating carrier, so they can't reach an aggregate.
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
