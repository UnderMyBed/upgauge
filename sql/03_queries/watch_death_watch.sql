-- Route Death Watch. health_score ascending, NULLS LAST.
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
-- The reason this guarantee matters at all: 813 of 8,080 routes have a NULL health_score for
-- one of three data-availability reasons (688 no prior window, 180 no filed schedule, overlap
-- 55 -- docs/product/features.md). A NULL sorted first would present them as the most
-- distressed routes in the system, which is exactly the misrepresentation that document's
-- standing UI requirement forbids.
--
-- gauge_t12 >= 50 is the CRJ-200's seat count -- a real airframe boundary, not a round number.
-- Without it this leaderboard is nine-seat Alaska and Puerto Rico operators whose absolute
-- swings are trivial and whose log ratios are enormous (docs/data/model.md). The floor is a
-- property of THIS PRESET, not of the mart: mart_route_health keeps scoring every route it can.
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
  AND health_score IS NOT NULL
  AND gauge_t12 >= 50
ORDER BY health_score ASC NULLS LAST
LIMIT $limit
