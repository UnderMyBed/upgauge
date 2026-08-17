-- Route Birth Tracker. RE-ENTRY, not first appearance -- and a CARRIER-ROUTE PAIR, not a route.
-- Both halves of that sentence are corrections; the name of this preset is the one thing about
-- it that overstates what it selects, and it is kept only because it is the product's.
--
-- p12_months_present = 0 is what "new" means here, and it is the whole of it: nothing filed in
-- the PRIOR 12-month window (asOf-23 .. asOf-12), something filed in the trailing one. TWO
-- claims do NOT follow from that, and this file's own header asserted both through M6.
--
-- 1. NOT "first appearance since 2015". This filter says nothing about the years before the p12
--    window, because mart_route_health carries no lookback beyond it. Measured on the 2026-05
--    warehouse: 303 of the 606 qualifying rows (50.0%) filed in at least one month BEFORE the
--    p12 window, and 19 of the 25 rows the page actually renders. Worst case QX BLI-SEA -- 99
--    distinct months on file, first filed 2015-01 -- which "first appearance since 2015"
--    presented as brand-new service. features.md's older reasoning ("a route flown in 2014 and
--    resumed in 2019 looks new") had the right failure mode and the wrong window: a route flown
--    in 2023 and resumed in 2025 looks new too, and that is half of these rows.
--
-- 2. NOT "new service nobody flew last year". THE GRAIN IS (op_airline_id, route_key_low,
--    route_key_high) -- one row per carrier per undirected route, never one row per route -- so
--    this filter is silent about every OTHER carrier on the same airport pair. Measured: 466 of
--    the 606 (76.9%), and 25 of the 25 rows this page renders, had a different carrier flying
--    that pair inside the p12 window. The #1 row is AS HNL-ITO, where HA, UA and WN filed
--    1,786,963 seats in that window -- 3.7x the subject's own trailing 12. AS DEN-SAN had SEVEN
--    other operators and 1.88M seats, 14x its own; AA FLL-LGA had three and 1.52M, 10.8x.
--
--    This one survived the fix wave that caught (1): "nobody flew last year" reads as the
--    accurate half of the old sentence and was carried over unexamined. Anything written about
--    this preset must name the carrier, or it is a claim about a route the query never made.
--
-- The converse limitation is unchanged: a pair that stopped and resumed WITHIN the p12/t12
-- windows has some p12 presence and is silently excluded. None of this is a bug this file's
-- WHERE clause could fix without a longer lookback than the mart computes; all of it is stated
-- on the page (ReEntryNote, app/src/app/watch/[preset]/page.tsx) rather than papered over.
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
