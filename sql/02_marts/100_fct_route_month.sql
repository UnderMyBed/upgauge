-- upgauge: view
-- object: fct_route_month
--
-- Directed route-month rollup of fct_segment_month, dropping the aircraft_type grain.
-- A view: purely derived, and cheap enough that materialising it would add an artifact to
-- keep honest for nothing.
--
-- Quarantined rows leave the measures but stay COUNTABLE. Dropping them silently hides the
-- dirt, which the UI is required to surface; including them corrupts the aggregate. So they
-- are excluded from every sum and carried as quarantined_rows.
--
-- `distance` is per-segment miles and is NOT additive -- SUM(distance) across the aircraft
-- types on a route is meaningless. It is carried as max(), a route attribute. See the
-- `distance` is not additive section of docs/data/model.md for the measurement.
--
-- No derived measure is stored. load_factor / asm / rpm / avg_gauge are computed by the
-- consumer from these sums.
--
-- year/quarter/month are pure functions of year_month (0 of 494,508 route-month groups --
-- distinct (year_month, op_airline_id, origin_airport_id, dest_airport_id) combos, not the
-- 36 distinct year_month values themselves -- have more than one distinct value of any of
-- the three, over the full 2015-2017 warehouse), so they are carried in GROUP BY rather
-- than any_value(). That is not cosmetic: any_value()
-- output is an opaque aggregate result to the optimizer, so a `WHERE year = 2017` on this
-- view could not be pushed into the underlying fct_segment_month scan and its Hive
-- partition pruning -- measured "Total Files Read: 3" (no File Filters) through
-- any_value(), vs. "Scanning Files: 1/3" once year is a GROUP BY key. See
-- docs/data/invariants.md.
SELECT
    year_month,
    year,
    quarter,
    month,

    op_airline_id,
    origin_airport_id,
    dest_airport_id,
    -- Unlike year/quarter/month/route_key_*, these are NOT a pure function of the grain --
    -- they are copied per filed row from raw.ORIGIN_CITY_MARKET_ID / DEST_CITY_MARKET_ID,
    -- and an airport genuinely can be reassigned between city markets over time. any_value()
    -- is safe here only because measurement shows it constant within the grain: 0 of 494,451
    -- non-quarantined route-months vary, over the full 2015-2017 warehouse. See
    -- docs/data/invariants.md.
    any_value(origin_city_market_id) AS origin_city_market_id,
    any_value(dest_city_market_id)   AS dest_city_market_id,

    -- Undirected pair, carried through for mart_route_health.
    any_value(route_key_low)  AS route_key_low,
    any_value(route_key_high) AS route_key_high,

    -- Every measure is FILTERed per-aggregate rather than in WHERE. A WHERE filter would
    -- remove quarantined rows before count(*) FILTER could see them, making
    -- quarantined_rows always 0 -- which is exactly the "silently hides the dirt" failure
    -- this column exists to prevent.
    --
    -- A route-month whose every row is quarantined therefore yields NULL here, not 0 -- do
    -- NOT wrap these in COALESCE(..., 0). A real 0 (the route filed, and genuinely carried
    -- nothing) and an untrustworthy 0 (nothing filed here can be trusted) must stay
    -- distinguishable; coalescing collapses that distinction silently.
    sum(departures_scheduled) FILTER (WHERE NOT is_quarantined) AS departures_scheduled,
    sum(departures_performed) FILTER (WHERE NOT is_quarantined) AS departures_performed,
    sum(seats)                FILTER (WHERE NOT is_quarantined) AS seats,
    sum(passengers)           FILTER (WHERE NOT is_quarantined) AS passengers,
    sum(freight)              FILTER (WHERE NOT is_quarantined) AS freight,
    sum(mail)                 FILTER (WHERE NOT is_quarantined) AS mail,
    sum(air_time)             FILTER (WHERE NOT is_quarantined) AS air_time,
    sum(ramp_to_ramp_time)    FILTER (WHERE NOT is_quarantined) AS ramp_to_ramp_time,

    max(distance) FILTER (WHERE NOT is_quarantined) AS distance,

    count(*) FILTER (WHERE is_quarantined) AS quarantined_rows
FROM fct_segment_month
GROUP BY year_month, year, quarter, month, op_airline_id, origin_airport_id, dest_airport_id
