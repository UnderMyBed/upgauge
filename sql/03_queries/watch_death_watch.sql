-- Route Death Watch. health_score ascending, NULLS LAST, then the mart's own grain so the
-- ordering is total -- see the ORDER BY.
--
-- NULLS LAST is currently a NO-OP, not load-bearing: the WHERE clause below already excludes
-- every NULL health_score before ORDER BY ever runs, so there is no NULL left in the sorted
-- column for NULLS FIRST vs. NULLS LAST to arbitrate (verified: byte-identical output with the
-- clause present or removed, on the real warehouse). It is retained as forward defense for a
-- future variant of this query that relaxes the WHERE clause -- e.g. one that shows unscored
-- routes too, sorted last, instead of dropping them -- at which point it would start doing
-- real work again. The actual guarantee TODAY is the `health_score IS NOT NULL` filter two
-- lines below, same as CASE guards elsewhere in this codebase that are documentation rather
-- than the load-bearing mechanism (200_mart_route_health.sql's `p12_months_present = 0` CASE).
--
-- The reason this guarantee matters at all: 373 of the 5,611 carrier-route pairs in
-- mart_route_health have a NULL health_score for one of three data-availability reasons:
-- 297 no prior window, 89 no filed schedule, overlap 13 (docs/product/features.md). A NULL
-- sorted first would present them as the most distressed pairs in the system, which is
-- exactly the misrepresentation that document's standing UI requirement forbids.
--
-- gauge_t12 >= 50 is the CRJ-200's seat count -- a real airframe boundary, not a round number.
-- Without it this leaderboard is nine-seat Alaska and Puerto Rico operators whose absolute
-- swings are trivial and whose log ratios are enormous (docs/data/model.md). The GAUGE floor is
-- a property of THIS PRESET; the DEPARTURE floor is the mart's own admission gate (#148) and
-- applies to every preset. mart_route_health scores every carrier-route pair it admits.
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
  AND health_score IS NOT NULL
  AND gauge_t12 >= 50
--
-- ORDER BY carries the mart's whole grain -- (op_airline_id, route_key_low, route_key_high) --
-- as a tiebreak, because health_score alone is ONE column and rows tying on it AT THE LIMIT
-- BOUNDARY would otherwise come back in DuckDB's merge order rather than by the query. All
-- three columns, never the route pair alone: the grain is a carrier-route PAIR. watch_gauge.sql
-- carries the full rule and the measurement that proves route alone is not total.
--
-- Ties are real here even on a float score: 1 tie run covering 6 of the 4,935 qualifying rows.
ORDER BY health_score ASC NULLS LAST, op_airline_id, route_key_low, route_key_high
LIMIT $limit
