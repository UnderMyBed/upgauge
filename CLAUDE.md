# Upgauge

A structural intelligence layer over US DOT / BTS airline data. Answers: *"Is this route
healthy, and what is the airline about to do to it?"* Not a flight search tool, not a fare
tracker, not real-time.

**Specs are the source of truth. Read them before non-trivial work:**
- `docs/PRODUCT.md` — product + engineering spec. §7 (data invariants) is the dangerous part.
- `docs/DESIGN_BRIEF.md` — visual identity handoff. Aesthetic is decided in a design session,
  not invented ad hoc.

This file records the rules that are **easy to violate accidentally**. It does not restate
the specs.

## Status

Greenfield — `docs/` only, nothing scaffolded. Current milestone: **M1** (ingest →
Parquet, §7 invariant tests passing). Milestones M1–M6 in `PRODUCT.md` §11 are ordered on
purpose; the Explorer (M3) is the foundation that the insight presets are saved views over.

## Architecture

Read-only dataset, refreshed monthly, **no writes ever** — so there is no database server.
DuckDB file + Parquet, queried in-process.

```
GitHub Actions (monthly cron) → Python ingest → Parquet → upgauge.duckdb
                                                   ├→ Cloudflare R2
                                                   └→ baked into container image
                                          Next.js app (single deployable)
                                          Hetzner ← Cloudflare CDN
```

Always-on, not scale-to-zero: DuckDB aggregation wants RAM (1–2GB/thread) and a cold start
lands on the first click of every shared link. `PRODUCT.md` §4 records the $0 alternatives
(Cloud Run, self-host + Tunnel) if that tradeoff ever changes.

```
pipeline/    Python 3.12 + uv. CI only, never runs in prod.
             fetch.py → normalize.py → build.py; tests/ gate the pipeline
sql/         01_staging/ 02_marts/ 03_queries/ — shared by pipeline AND server
app/         Next.js 15 App Router, TS, Tailwind, shadcn/ui
             api/ route handlers → @duckdb/node-api → sql/03_queries/
data/        gitignored. raw/ is the audit trail
```

Charts: Observable Plot. Maps: deck.gl `GreatCircleLayer` + MapLibre + Natural Earth
GeoJSON (no tiled basemap — tiles are usage-priced).

## Commands

Not yet scaffolded; these are the targets from `PRODUCT.md` §10. Create them as `make`
targets, don't invent a different interface.

| Command | Description |
|---------|-------------|
| `make ingest` | PREZIP enumerate → download → `data/raw/` → `data/parquet/` |
| `make build` | Run `sql/` in order → `upgauge.duckdb` |
| `make dev` | Next.js dev server |

## Hard rules

**Derived measures are never stored, never averaged.** Compute from summed numerator and
denominator at query time.

```sql
AVG(load_factor)                                  -- WRONG. Plausible-looking garbage.
SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)   -- RIGHT. Always.
```

Enforce structurally: **no `load_factor` column on any fact table.** Same for `asm`, `rpm`,
`avg_gauge`, `completion_factor`. Can't average what doesn't exist. This is the #1 bug in
every homemade T-100 tool.

**Key on `AIRLINE_ID` and `AIRPORT_ID`, never letter codes.** T-100 ships DOT-assigned IDs
that are stable across code/name/ownership changes, alongside IATA-style codes that **get
reused by different airlines over time**. Join on IDs, display codes. `AIRPORT_SEQ_ID` is
the point-in-time key for airport attributes; `AIRPORT_ID` is identity.

**Operating carrier is the grain and the truth.** T-100 Segment is filed by whoever
operated the metal — a Delta-branded regional flown by Endeavor files as `9E`, not `DL`.
Summing carriers on a route does *not* double-count. There is no marketing-carrier field;
don't try to infer one.

**`map_mainline_group` is DATE-RANGED and wholly-owned only.** Not a static map — Alaska
acquired Virgin America (2016-12) and Hawaiian (2024-09), both inside the 2015→present
window, so a flat map is wrong before each acquisition and omission is wrong after. Rows
and dates live in `PRODUCT.md` §2. Never roll up shared regionals (SkyWest `OO`, Republic
`YX`, Mesa `YV`) or contract carriers (Air Wisconsin `ZW`, ExpressJet `EV`) — no date range
fixes those; they fly for several mainlines on the same day. The rollup is a **display
grouping layered on the grain, never a replacement**; aircraft type stays at the grain so
downgauge stories remain visible.

Test the map has no overlapping ranges per `airline_id`, and that Hawaiian rolls up from
2024-09 but not 2024-08.

**Don't reuse the name `carrier_group`.** T-100 already ships `CARRIER_GROUP` /
`CARRIER_GROUP_NEW` — BTS's revenue-based filing classification, unrelated to our rollup.
Ours is `mainline_group`; theirs is preserved as `bts_carrier_group`.

Three labeling requirements, enforced in UI: a group is *"mainline + wholly-owned
subsidiaries"*, never "all branded flying"; United looks artificially small in group view —
annotate it; and **group composition changes over time** — annotate the acquisition
boundaries on any grouped series, because that step change is an ownership event, not
growth. Default view is operating carrier; group is an opt-in toggle.

**All query logic lives in `.sql` files.** Never inline SQL in Python or TS string
literals. This is what lets the pipeline and the server share definitions and keeps a
DuckDB-WASM port possible.

**Segment only.** Never blend T-100 Segment with T-100 Market or DB1B — that mixing is
where the real double-count comes from.

**Never mutate `data/raw/`.** Raw zips are the audit trail. BTS accepts amended filings and
silently overwrites, so stamp every ingest with a download date and retain prior Parquet
partitions.

**Stay portable.** `docker run` against the same `.duckdb` file must behave identically.
Docker + Parquet + env vars only. **Do not build on provider-specific runtimes** (Workers,
D1, KV) — Cloudflare is CDN and rate limiting, nothing more.

## Data gotchas

- **PREZIP is dead for T-100.** Every T-100 file at `transtats.bts.gov/PREZIP/` is dated
  2015-09-02 (On-Time files there *are* current, which is what makes it look maintained).
  The `DL_SelectFields.aspx` POST is the only path — a per-month form loop with disk cache
  and retries. Request **all fields**; the ID columns above aren't in the default selection.
- **Service class + config:** `CLASS = 'F'` is *Scheduled Passenger/Cargo* — a composite.
  It does not isolate passenger ops on its own; **`AIRCRAFT_CONFIG` is the freighter
  filter.** Resolve the exact `CLASS × AIRCRAFT_CONFIG` split empirically with a test —
  documentation conflicts on it.
- **Trailing comma:** T-100 CSVs ship a trailing comma → phantom `EMPTYFIELD` column.
- **Quarantine, don't clamp:** `seats = 0` → quarantine as a data error, do not divide —
  **this is not the freighter filter.** `load_factor > 1.0` → quarantine as a filing error,
  **never silently clamp.** Quarantined rows are excluded from aggregates but surfaced in
  the UI with count + reason. Showing the dirt is a trust feature.
- **Amended filings:** latest `download_date` wins per `(year_month, grain key)`. Prior
  partitions are audit-only and never feed a mart — otherwise rebuilds aren't deterministic.
- **Route identity:** store both directional (`PDX→AUS`) and undirected (`AUS-PDX`) keys;
  undirected is the two airport IDs sorted, so filing order doesn't matter.
- Window is 2015→present. Alaska/Virgin America (2016–18) is the only in-window merger.
  COVID is inside the window deliberately — it's the showcase, not a problem to filter out.

## UI constraints

From `PRODUCT.md` §3 — product truths, not style preferences. The design session owns
palette, type personality, and the signature element; it does not own these.

- **All numerics monospaced, tabular-figure, right-aligned, fixed decimals.**
  Non-negotiable.
- **`DATA AS OF: YYYY-MM` is a first-class element** on every data view, in the accent
  color. BTS data is 2–6 months lagged by nature; the lag is our credibility. Design around
  it, don't bury it.
- **Density over whitespace.** Sparklines in rows, hairline rules. No card soup.
- **URL-encoded query state on every view.** Permalinks are the entire growth mechanic —
  people paste links into forums and Discords. Not optional, not a later add-on.
- **Every insight row is one click from the raw rows that produced it.** Insights that can't
  be drilled into feel like astrology.
- Derived measures labeled as computed. Never imply precision the lagged, sampled data
  lacks.
- Quality floor: responsive, visible keyboard focus, reduced-motion honored.

## Workflow

- **§7 invariants are written as tests first**, before the pipeline that satisfies them.
  They gate M1.
- Marts must rebuild from scratch reproducibly via `make`. No manual steps.
- Every response gets `Cache-Control: public, s-maxage=2592000,
  stale-while-revalidate=86400`. Precompute leaderboards as static JSON at build time — the
  caching is the cost control, not the hosting tier.
- Build the **aircraft-type-mix chart before the load-factor chart**. Everyone does load
  factor; the gauge story is the differentiator.
- Build the generic Top-N builder once; the `/watch` presets are saved instances of it.
- **The cron must fail loudly.** A broken ingest doesn't error — the site keeps serving and
  `DATA AS OF` silently stops advancing. Alert when `max(year_month)` hasn't moved in ~45
  days. Serving stale data while claiming freshness is the worst failure this product has.

## Out of scope for v0 — do not let these leak in

DB1B / fares · on-time performance · international · Form 41 / profitability · full
mainline attribution for shared & contract regionals (the wholly-owned rollup **is** in
v0) · user accounts · alerts · email digests · anything predictive beyond the
trailing-window heuristic.

Also avoid: managed Postgres (pointless, no writes) · Mapbox tiles · always-on Redis ·
a global all-routes map (hairball) · a map on the route detail page (one arc is not
information).
