# Scope & the decision record

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

## Decision record

**All four are resolved.** Kept struck-through rather than deleted: each records *why* the
call went the way it did, and a resolved decision with its reasoning is what stops it being
re-litigated. New decisions go here; outstanding WORK goes to
[GitHub Issues](https://github.com/UnderMyBed/upguage/issues).

| # | Decision | Notes |
|---|---|---|
| ~~D1~~ | ~~City-market dimension in or out?~~ **RESOLVED — IN, and built.** `fct_segment_month` carries `ORIGIN_CITY_MARKET_ID` / `DEST_CITY_MARKET_ID`; `dim_city_market` (`city_market_id`, `name`, built from Master Coordinate — see [model.md](../data/model.md)) now resolves them to a name, so the Explorer's city-market cut no longer renders bare integers. | Two integers per row at ingest vs. an expensive retrofit into the dimension model later. Enables "all NYC airports as one" — an aviation-native cut. Confirmed available in the live download. |
| ~~D4~~ | ~~When does the design session run?~~ `docs/design/brief.md` makes the data table deliverable #1 — "most of the product is this table in different clothes" — so building that table decides the visual system whether or not that is planned for. **RESOLVED as an ordering, not a deferral:** the query contract first (no design dependency, no Node), then the design session, then the app built against real tokens. See [pipeline.md § The pivot contract](../architecture/pipeline.md#the-pivot-contract). | Retrofitting a token system through the product's core surface is the expensive kind of rework, and the brief's constraints (mono tabular numerals, density, the `DATA AS OF` badge) are structural rather than cosmetic. |
| ~~D2~~ | ~~Which entity pages actually exist, and which get indexed?~~ **RESOLVED — every fact-present, unambiguous entity, no traffic threshold.** `/sitemap.xml` (`app/src/app/sitemap.ts`, fed by `app/src/lib/sitemap.ts` and `sql/03_queries/sitemap_{routes,airports,carriers,aircraft}.sql`) emits **23,694** URLs: 22,420 routes + 1,045 airports + 114 carriers + 110 aircraft + 5 `/watch` pages. Every entity count is **quarantine-inclusive** — a quarantined row is still a real filing and its page still 200s (CLAUDE.md: "showing the dirt is a trust feature"), and excluding it would silently drop 4 airports, 2 aircraft types and 31 route pairs that serve today. The considered "minimum-traffic threshold" was rejected: there is no volume floor below which a page stops existing, only the fact-presence floor entity resolution already enforces — an entity absent from `fct_segment_month` entirely has no page and is not a 404-worth-avoiding case, it simply isn't in the set. The one exclusion is `/aircraft/CE-180`, which resolves `ambiguous` and 404s (two BTS codes share one short name) — 112 fact-present codes → 111 distinct short names → 110 unambiguous pages. Canonical rule: routes are the **code-alphabetical** pair (`routeHrefFromCodes`, shared with `/explore`'s cell links), never the id-ordered pair `fct_segment_month` itself groups by — they disagree for 154 of 22,420 pairs. `lastmod` is each entity's own last-filed month, never the sitemap's build date; `/watch`'s five pages have no "last-filed month" of their own (they aren't entities), so they carry the build's own `dataAsOf()` instead. | Also answers the static-hosting file-count question (see [hosting](../architecture/hosting.md) — Cloudflare Pages caps at 20,000 files/site on free): 23,694 sitemap URLs is not 23,694 prerendered files (routes are served, not statically built — hosting.md's prerender table), so the cap is not in tension with this count. |
| ~~D3~~ | ~~Licensing / attribution line.~~ **RESOLVED.** One line, unconditional (present on every rail, not gated behind an opt-in group, because every view the rail appears on is built from the same source whether or not it draws a chart): *"Source: US DOT / Bureau of Transportation Statistics, T-100 Segment (All Carriers) — public-domain US Government data."* Lives in the legend rail (`app/src/components/LegendRail.tsx`), the methodology surface every data view already carries (`docs/design/system.md` § The legend rail) — not a second, separate footer to go stale. | One line on the methodology surface. Trivial, but a public data tool should say it. |
