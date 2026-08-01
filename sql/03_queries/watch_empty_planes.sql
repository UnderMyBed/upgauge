-- Empty Planes. Lowest load factor among routes actually flown on real airliner metal, at a
-- meaningful trailing-12 frequency.
--
-- gauge_t12 >= 50 (the CRJ-200's seat count, same boundary watch_death_watch.sql uses) is THE
-- reason this preset needs a floor at all: without it the leaderboard is Alaska bush freight
-- and a Grand Canyon sightseeing operator flying 4-to-6-seat aircraft -- GCH 1G4-BLD leads
-- unfloored, LF 0.0000 on gauge 6.0. The preset is billed as "a mainline wasting capacity";
-- unfloored it delivers cargo runs and sightseeing flights instead, which is a materially
-- different, and false, story about the row.
--
-- t12_departures_performed >= 360 is features.md's "min 30 departures/mo" floor restated over
-- the trailing TWELVE months (30 x 12), and it is ADDITIONAL to, not a restatement of, the
-- mart's own floor: 200_mart_route_health.sql's `derived` CTE already drops every route below
-- 30 departures for the WHOLE table before this preset ever runs. The two differ by 12x.
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
  AND lf_t12 IS NOT NULL
  AND gauge_t12 >= 50
  AND t12_departures_performed >= 360
ORDER BY lf_t12 ASC
LIMIT $limit
