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
| ~~D1~~ | ~~City-market dimension in or out?~~ **RESOLVED — IN.** Carry `ORIGIN_CITY_MARKET_ID` / `DEST_CITY_MARKET_ID` on `fct_segment_month`; add a `city_market` dimension to the Explorer. | — | Two integers per row at ingest vs. an expensive retrofit into the dimension model at M3. Enables "all NYC airports as one" — an aviation-native cut. Confirmed available in the live download. |
| **D2** | **Which entity pages actually exist, and which get indexed?** Entity pages are pitched for SEO but never bounded. `(carrier × origin × dest)` is a large set. | M4 | Doubles as the answer to the static-hosting file-count question (see [hosting](../architecture/hosting.md) — Cloudflare Pages caps at 20,000 files/site on free). Needs a minimum-traffic threshold and a sitemap/canonical rule. |
| **D3** | **Licensing / attribution line.** All source data is public-domain US Government filings. | M4 | One line on the methodology surface. Trivial, but a public data tool should say it. |
