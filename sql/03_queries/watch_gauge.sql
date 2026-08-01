-- Gauge Watch. Upgauging and downgauging are the SAME query, sorted oppositely -- the two
-- tables app/src/lib/watch.ts's Gauge Watch preset renders.
--
-- {{DIRECTION}} is a token, substituted in watch.ts's runPreset() from a closed set (only the
-- literals "ASC"/"DESC", chosen by looking up the requested direction in the preset's OWN
-- `directions` registry entry) -- never a caller-supplied string concatenated straight into
-- ORDER BY. This is the one preset whose direction varies; the other three watch_*.sql files
-- hardcode their ORDER BY because each of them only ever renders one table.
--
-- gauge_delta IS NOT NULL excludes the 688 routes with no prior-window data
-- (p12_months_present = 0, measured: gauge_delta IS NULL count matches it exactly). That is a
-- SINGLE cause, not health_score's three-reason union (813 -- docs/product/features.md) --
-- gauge_delta only depends on gauge_t12/gauge_p12, and gauge_t12 is never NULL for any row
-- that reaches mart_route_health at all (the >= 30 t12-departures floor in
-- 200_mart_route_health.sql's `derived` CTE guarantees that). A route with no gauge_delta has
-- nothing for either table to lead with.
SELECT
    op_airline_id,
    route_key_low,
    route_key_high,
    lf_t12, lf_delta, gauge_t12, gauge_delta,
    capacity_delta, frequency_delta, completion_factor,
    t12_seats, t12_departures_performed, t12_quarantined_rows,
    health_score
FROM mart_route_health
WHERE route_key_low <> route_key_high
  AND gauge_delta IS NOT NULL
ORDER BY gauge_delta {{DIRECTION}}
LIMIT $limit
