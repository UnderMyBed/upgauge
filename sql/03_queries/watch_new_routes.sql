-- Route Birth Tracker. First appearance SINCE 2015 -- never "first ever": the dataset's window
-- starts in 2015 (CLAUDE.md), and the stronger claim is false precision this data cannot back.
--
-- p12_months_present = 0 is what "new" means here: nothing filed in the PRIOR 12-month window,
-- something filed in the trailing one -- which also silently excludes a route that stopped and
-- later resumed within the p12/t12 windows this mart computes, since that route has SOME p12
-- presence. That is a real limitation, not a bug this file's WHERE clause could fix without a
-- longer lookback than mart_route_health carries.
--
-- Ordered t12_seats DESC so the biggest new entrants lead, not the smallest charter filing.
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
  AND p12_months_present = 0
ORDER BY t12_seats DESC
LIMIT $limit
