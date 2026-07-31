-- Every UNAMBIGUOUS fact-present aircraft short name, for /sitemap.xml.
--
-- QUARANTINE IS NOT FILTERED -- see sitemap_routes.sql's header. Measured against the built
-- database, filtering it out drops exactly 2 short names (SHORT360, TRISLNDR) that resolve
-- and serve today.
--
-- `GROUP BY short_name` is what collapses the BTS-code grain to the URL grain -- the fact
-- table's join key is `aircraft_type` (the zero-padded BTS code), but the page and the URL
-- are keyed on `short_name` (resolve_aircraft_type.sql's header: nobody pastes /aircraft/612).
-- 112 fact-present codes collapse to 111 distinct short names.
--
-- `HAVING count(DISTINCT t.code) = 1` is the part that makes this file more than a plain
-- GROUP BY: it excludes CE-180, the one short name that identifies TWO different fact-present
-- codes (030 CESSNA 180, 031 CESSNA 180A/B -- lookup_aircraft_by_name.sql's header has the
-- full account). `/aircraft/CE-180` resolves `ambiguous` and renders a named-disambiguation
-- 404 (aircraftSlug.ts's `resolveFromMatches`), not a 200 -- so it does not belong in a
-- sitemap, and this clause is what takes 111 distinct short names down to the 110 that
-- actually resolve to a page. `lastmod` for an excluded short name is simply never computed;
-- there is no page to date.
--
-- No `is_latest` clause: dim_aircraft_type is one row per code (measured, 0 codes carry more
-- than one row -- lookup_aircraft_by_name.sql's header), so there is no seq chain to collapse.
SELECT
    t.short_name                AS short_name,
    max(f.year_month) || '-01'  AS lastmod
FROM fct_segment_month f
JOIN dim_aircraft_type t ON t.code = f.aircraft_type
GROUP BY t.short_name
HAVING count(DISTINCT t.code) = 1
