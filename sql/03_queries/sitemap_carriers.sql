-- Every operating carrier with at least one filed segment row, for /sitemap.xml.
--
-- QUARANTINE IS NOT FILTERED -- see sitemap_routes.sql's header. Measured against the built
-- database, the carrier count happens to be identical either way (114) -- unlike airports,
-- aircraft and routes, no fact-present carrier's ENTIRE row history is quarantined -- but the
-- clause is still absent on purpose, for the same reason the other three files carry none:
-- existence is not aggregation, and a future refresh could easily produce a carrier whose
-- only filed rows are quarantined.
--
-- No `is_latest` needed: dim_carrier is already one row per airline_id (v0 collapses Carrier
-- Decode, CLAUDE.md), so this join cannot fan out -- same reasoning as resolve_carrier.sql
-- and lookup_carrier_by_code.sql, neither of which carries an is_latest clause either.
SELECT
    cc.carrier_code            AS code,
    max(f.year_month) || '-01' AS lastmod
FROM fct_segment_month f
JOIN dim_carrier cc ON cc.airline_id = f.op_airline_id
GROUP BY cc.carrier_code
