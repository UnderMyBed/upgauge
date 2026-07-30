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
SELECT
    year_month,
    any_value(year)    AS year,
    any_value(quarter) AS quarter,
    any_value(month)   AS month,

    op_airline_id,
    origin_airport_id,
    dest_airport_id,
    any_value(origin_city_market_id) AS origin_city_market_id,
    any_value(dest_city_market_id)   AS dest_city_market_id,

    -- Undirected pair, carried through for mart_route_health.
    any_value(route_key_low)  AS route_key_low,
    any_value(route_key_high) AS route_key_high,

    -- Every measure is FILTERed per-aggregate rather than in WHERE. A WHERE filter would
    -- remove quarantined rows before count(*) FILTER could see them, making
    -- quarantined_rows always 0 -- which is exactly the "silently hides the dirt" failure
    -- this column exists to prevent.
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
GROUP BY year_month, op_airline_id, origin_airport_id, dest_airport_id
