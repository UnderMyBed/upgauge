-- Empty Planes. Lowest trailing-12 load factor among carrier-route pairs flown on real
-- airliner metal at the mart's rate floor.
--
-- NOT "at a meaningful trailing-12 frequency", which this header said until #148 while the
-- predicate behind it was being deleted. No trailing-12 frequency floor survives anywhere:
-- the mart admits on a per-month RATE, which a two-month operation clears trivially. 11 of
-- the 25 rendered rows fall below 360 trailing-12 departures and the leader flew 65 across 2
-- months -- both true and both fine, but only under a sentence that does not promise
-- frequency.
--
-- gauge_t12 >= 50 (the CRJ-200's seat count, same boundary watch_death_watch.sql uses) is the
-- floor THIS PRESET owns, and the reason it needs one: without it the leaderboard is Alaska
-- bush freight and a Grand Canyon sightseeing operator flying 4-to-6-seat aircraft -- GCH
-- 1G4-BLD leads unfloored, LF 0.0000 on gauge 5.98. The preset is billed as "a mainline
-- wasting capacity"; unfloored it delivers cargo runs and sightseeing flights instead, which is
-- a materially different, and false, story about the row.
--
-- THE DEPARTURE FLOOR IS THE MART'S, NOT THIS PRESET'S (#148). 200_mart_route_health.sql's
-- `derived` CTE admits only carrier-route pairs running >= 30 departures per month FLOWN --
-- the rate app/src/lib/floor.ts declares and every table and map applies -- so every row
-- reaching this query already clears it and there is nothing left for a second predicate here
-- to do.
--
-- This file used to carry `t12_departures_performed >= 360` on top of that. It is DELETED, not
-- restated as a rate, and both halves of that are deliberate:
--
--   * 360 is a FLAT ANNUAL TOTAL, the reading #134 ruled wrong. A route flying three months at
--     40 departures a month files 120, runs at four times the rate floor, and 360 excluded it
--     anyway. 753 such carrier-route pairs were being withheld from this leaderboard.
--   * Restating it as `>= 30 * t12_months_flown` would enforce NOTHING. The mart's window is
--     twelve months, so t12_months_flown <= 12 and `>= 360` was already a strict SUBSET of the
--     mart's own gate (verified: zero rows satisfy `t12_departures_performed >= 360 AND
--     t12_departures_performed < 30 * t12_months_flown`). A predicate that reads like a rule
--     and removes no row is worse than no predicate, and declaring the floor in two places is
--     the defect #134 closed.
--
-- The page states the mart's floor in words on every preset (DeparturesFloorNote,
-- app/src/app/watch/[preset]/page.tsx), not on this one alone: it is a property of the table
-- all four read, the same way the same-airport exclusion is.
SELECT
    op_airline_id,
    route_key_low,
    route_key_high,
    lf_t12, lf_delta, gauge_t12, gauge_delta,
    capacity_delta, frequency_delta, completion_factor,
    t12_seats, t12_departures_performed, t12_months_flown, t12_quarantined_rows,
    health_score
FROM mart_route_health
WHERE route_key_low <> route_key_high
  AND lf_t12 IS NOT NULL
  AND gauge_t12 >= 50
--
-- ORDER BY carries the mart's whole grain -- (op_airline_id, route_key_low, route_key_high) --
-- as a tiebreak, because lf_t12 alone is ONE column and rows tying on it AT THE LIMIT BOUNDARY
-- would otherwise come back in DuckDB's merge order rather than by the query. All three
-- columns, never the route pair alone: the grain is a carrier-route PAIR. watch_gauge.sql
-- carries the full rule and the measurement that proves route alone is not total.
--
-- This preset has ZERO tie runs in its 5,205 qualifying rows on the 2026-05 warehouse, which is
-- why watch.test.ts's real-data determinism test does NOT cover it -- a case with no tie to
-- order asserts nothing. Its guard here is the ORDER BY property test, and a future warehouse
-- that gives it a tie is a reason to ADD the real-data case, not evidence one was missing.
ORDER BY lf_t12 ASC, op_airline_id, route_key_low, route_key_high
LIMIT $limit
