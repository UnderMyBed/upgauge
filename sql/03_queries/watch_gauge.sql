-- Gauge Watch. Upgauging and downgauging are the SAME query, sorted oppositely -- the two
-- tables app/src/lib/watch.ts's Gauge Watch preset renders.
--
-- {{DIRECTION}} is a token, substituted in watch.ts's runPreset() from a closed set (only the
-- literals "ASC"/"DESC", chosen by looking up the requested direction in the preset's OWN
-- `directions` registry entry) -- never a caller-supplied string concatenated straight into
-- ORDER BY. This is the one preset whose direction varies; the other three watch_*.sql files
-- hardcode their ORDER BY because each of them only ever renders one table.
--
-- gauge_delta IS NOT NULL excludes the 813 routes mart_route_health cannot score a delta for
-- (docs/product/features.md's three-reason NULL contract) -- a route with no gauge_delta has
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
