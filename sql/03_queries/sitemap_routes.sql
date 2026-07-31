-- Every undirected route pair with at least one filed segment row, for /sitemap.xml.
--
-- QUARANTINE IS NOT FILTERED HERE, deliberately. The other three sitemap_*.sql files carry
-- the same absence, for the same reason lookup_airport_by_code.sql's fact-presence filter
-- carries none: a quarantined row (load_factor > 1.0, CLAUDE.md) is still a REAL filing that
-- a real, 200-serving page renders -- CLAUDE.md's "showing the dirt is a trust feature" means
-- the row is excluded from AGGREGATES, never from EXISTENCE. Filtering `NOT is_quarantined`
-- here would drop 31 route pairs that resolve and serve today (measured against the built
-- database), silently shrinking the crawl graph below what actually exists.
--
-- Route identity is UNDIRECTED (docs/data/invariants.md § Route identity): a segment files
-- origin -> dest in one direction only, so the pair is grouped by LEAST/GREATEST of the two
-- airport ids, the same shape render.ts / pipeline/pivot.py use for the composite `route`
-- dimension filter. Same-airport rows (`origin_airport_id = dest_airport_id`) are excluded --
-- CLAUDE.md / routePair.ts: those are not routes.
--
-- `lo_code`/`hi_code` come back in AIRPORT-ID order, NOT the alphabetical order the sitemap
-- URL needs -- they disagree for 154 of 22,420 pairs (routePair.ts's own header; HPN/BNH is
-- the measured example: id order is HPN-BNH, alphabetical is BNH-HPN). Re-sorting into the
-- canonical URL is app/src/lib/sitemap.ts's job, via routeHrefFromCodes -- the same function
-- /explore's route cells link through (entityLink.ts) -- so there is exactly one place in the
-- codebase that turns two airport codes into a route URL, not two that could drift.
--
-- `is_latest` alone resolves an airport_id -> its current code without the
-- lookup_airport_by_code.sql union/fact-presence dance: that machinery exists for the REVERSE
-- direction (code -> id, where two different ids can share a code), and this is the FORWARD
-- direction (id -> code), where is_latest alone already picks the single current row for a
-- given id's own seq chain (resolve_airport.sql does the same).
WITH pairs AS (
    SELECT
        least(origin_airport_id, dest_airport_id)    AS lo_id,
        greatest(origin_airport_id, dest_airport_id) AS hi_id,
        max(year_month)                              AS last_month
    FROM fct_segment_month
    WHERE origin_airport_id <> dest_airport_id
    GROUP BY 1, 2
)
SELECT
    a.code           AS lo_code,
    b.code           AS hi_code,
    p.last_month || '-01' AS lastmod
FROM pairs p
JOIN dim_airport a ON a.airport_id = p.lo_id AND a.is_latest
JOIN dim_airport b ON b.airport_id = p.hi_id AND b.is_latest
