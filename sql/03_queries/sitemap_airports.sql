-- Every airport that appears as an ORIGIN OR a DEST in a filed segment row, for
-- /sitemap.xml. Counting one endpoint only is the exact silent-halving bug
-- docs/architecture/hosting.md's prerender table and pipeline.md's M4d section both measure
-- on /airport/SEA -- origin-only would emit 741 URLs instead of the 1,045 that actually 200.
--
-- QUARANTINE IS NOT FILTERED -- see sitemap_routes.sql's header for why the fact-presence
-- shape here carries no quarantine clause on purpose: a quarantined row is still a real
-- filing and a real page. Measured against the built database: filtering it out drops
-- exactly 4 airports (A18, DJN, OQZ, POB) that resolve and serve today.
--
-- `is_latest` alone is sufficient here (unlike lookup_airport_by_code.sql's reverse
-- direction) because this is airport_id -> code, and is_latest already picks the one current
-- row per id's own seq chain -- there is no code collision to guard against in this
-- direction. GROUP BY code rather than airport_id for the same reason resolve_airport.sql
-- can: among fact-present airport_ids, a code is unique (measured: the 36-code collision
-- lookup_airport_by_code.sql's header describes is a reverse-lookup phenomenon, taken to 0
-- once scoped to fact-present ids).
SELECT
    d.code                    AS code,
    max(u.year_month) || '-01' AS lastmod
FROM (
    SELECT origin_airport_id AS airport_id, year_month FROM fct_segment_month
    UNION ALL
    SELECT dest_airport_id AS airport_id, year_month FROM fct_segment_month
) u
JOIN dim_airport d ON d.airport_id = u.airport_id AND d.is_latest
GROUP BY d.code
