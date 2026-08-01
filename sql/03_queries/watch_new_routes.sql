-- Route Birth Tracker. RE-ENTRY, not first appearance -- and emphatically not "first appearance
-- since 2015", which is what this comment, lib/watch.ts's frame, docs/product/features.md and
-- docs/design/system.md all said through M6 and which the final whole-branch review measured as
-- false.
--
-- p12_months_present = 0 is what "new" means here, and it is the whole of it: nothing filed in
-- the PRIOR 12-month window (asOf-23 .. asOf-12), something filed in the trailing one. It says
-- nothing at all about the years before that window, because mart_route_health carries no
-- lookback beyond the prior 12 months. Measured on the 2026-04 warehouse: 334 of the 688
-- qualifying routes (48.5%) filed in at least one month BEFORE the p12 window, and 17 of the 25
-- rows the page actually renders. Worst case MQ AZO-ORD -- 93 distinct months on file, first
-- filed 2015-01 -- which "first appearance since 2015" presented as brand-new service. The
-- older reasoning (features.md's "a route flown in 2014 and resumed in 2019 looks new") was
-- right about the failure mode and one rung too high about the window: a route flown in 2023
-- and resumed in 2025 looks new too, and that is 48% of these rows.
--
-- The converse limitation is unchanged: a route that stopped and resumed WITHIN the p12/t12
-- windows has some p12 presence and is silently excluded. Neither is a bug this file's WHERE
-- clause could fix without a longer lookback than the mart computes; both are stated on the
-- page (ReEntryNote, app/src/app/watch/[preset]/page.tsx) rather than papered over.
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
