# Scope & open decisions

## Out of scope for v0

DB1B / fares · On-time performance · International · Form 41 / profitability · **Full
mainline attribution for shared & serially-exclusive contract regionals** (the wholly-owned
rollup *is* in v0 — see [carrier-model](../data/carrier-model.md)) · User accounts · Alerts ·
Email digests · Anything predictive beyond the trailing-window heuristic.

These are v1+. **Do not let them leak into the skateboard.**

Also avoid: managed Postgres (pointless, no writes) · Mapbox tiles · always-on Redis · a
global all-routes map (hairball) · a map on the route detail page (one arc is not
information).

---

## Open decisions

Each has a milestone where deferring stops being free.

| # | Decision | Needed by | Notes |
|---|---|---|---|
| ~~D1~~ | ~~City-market dimension in or out?~~ **RESOLVED — IN, and built.** `fct_segment_month` carries `ORIGIN_CITY_MARKET_ID` / `DEST_CITY_MARKET_ID`; `dim_city_market` (`city_market_id`, `name`, built from Master Coordinate — see [model.md](../data/model.md)) now resolves them to a name, so the Explorer's city-market cut no longer renders bare integers. | — | Two integers per row at ingest vs. an expensive retrofit into the dimension model at M3. Enables "all NYC airports as one" — an aviation-native cut. Confirmed available in the live download. |
| **D4** | **The design session has never been run**, and `docs/design/brief.md` makes the data table deliverable #1 — "most of the product is this table in different clothes." M3 builds that table, so the visual system gets decided at M3 whether planned or not. **Resolved as an ordering, not a deferral:** M3 is split — M3a is the query contract (no design dependency, no Node), then the design session, then M3b builds the app against real tokens. See [pipeline.md](../architecture/pipeline.md#m3--the-explorer-split-into-m3a-and-m3b). | M3b | Retrofitting a token system through the product's core surface is the expensive kind of rework, and the brief's constraints (mono tabular numerals, density, the `DATA AS OF` badge) are structural rather than cosmetic. |
| **D2** | **Which entity pages actually exist, and which get indexed?** Entity pages are pitched for SEO but never bounded. `(carrier × origin × dest)` is a large set. | M4 | Doubles as the answer to the static-hosting file-count question (see [hosting](../architecture/hosting.md) — Cloudflare Pages caps at 20,000 files/site on free). Needs a minimum-traffic threshold and a sitemap/canonical rule. |
| **D3** | **Licensing / attribution line.** All source data is public-domain US Government filings. | M4 | One line on the methodology surface. Trivial, but a public data tool should say it. |
