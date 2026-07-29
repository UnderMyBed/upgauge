-- Raw T-100 Domestic Segment CSV -> the fct_segment_month shape.
--
-- Shared by the pipeline and (later) the server, which is why it lives here rather than in a
-- Python string. Parameters are bound, never interpolated:
--   $csv_path            path to the extracted CSV
--   $scheduled_class     'F'
--   $passenger_configs   [1, 3, 4]
--   $download_date       from the fetch sidecar; drives amended-filing resolution
--
-- Read as all-VARCHAR and cast explicitly. Letting the CSV sniffer choose types turns
-- AIRCRAFT_TYPE '079' into 79 and breaks the dim join silently.
WITH raw AS (
    SELECT *
    FROM read_csv($csv_path, all_varchar = true, header = true)
),
typed AS (
    SELECT
        printf('%s-%02d', raw.YEAR, CAST(raw.MONTH AS INTEGER))     AS year_month,
        CAST(raw.YEAR    AS SMALLINT)                                AS year,
        CAST(raw.QUARTER AS TINYINT)                                 AS quarter,
        CAST(raw.MONTH   AS TINYINT)                                 AS month,

        -- Operating carrier is the grain. Blank on ~158 rows/yr that still report traffic,
        -- so TRY_CAST and let the quarantine rule below surface them.
        TRY_CAST(raw.AIRLINE_ID AS INTEGER)                          AS op_airline_id,
        raw.UNIQUE_CARRIER                                           AS op_carrier_code,
        CAST(raw.CARRIER_GROUP AS TINYINT)                           AS bts_carrier_group,

        CAST(raw.ORIGIN_AIRPORT_ID     AS INTEGER)                   AS origin_airport_id,
        CAST(raw.ORIGIN_AIRPORT_SEQ_ID AS INTEGER)                   AS origin_airport_seq_id,
        CAST(raw.ORIGIN_CITY_MARKET_ID AS INTEGER)                   AS origin_city_market_id,
        raw.ORIGIN                                                   AS origin_code,
        raw.ORIGIN_STATE_ABR                                         AS origin_state,

        CAST(raw.DEST_AIRPORT_ID     AS INTEGER)                     AS dest_airport_id,
        CAST(raw.DEST_AIRPORT_SEQ_ID AS INTEGER)                     AS dest_airport_seq_id,
        CAST(raw.DEST_CITY_MARKET_ID AS INTEGER)                     AS dest_city_market_id,
        raw.DEST                                                     AS dest_code,
        raw.DEST_STATE_ABR                                           AS dest_state,

        -- Undirected key: the two airport IDs sorted, so it is stable regardless of
        -- filing direction.
        least(CAST(raw.ORIGIN_AIRPORT_ID AS INTEGER),
              CAST(raw.DEST_AIRPORT_ID   AS INTEGER))                AS route_key_low,
        greatest(CAST(raw.ORIGIN_AIRPORT_ID AS INTEGER),
                 CAST(raw.DEST_AIRPORT_ID   AS INTEGER))             AS route_key_high,

        raw.AIRCRAFT_TYPE                                            AS aircraft_type,
        CAST(raw.AIRCRAFT_GROUP  AS SMALLINT)                        AS aircraft_group,
        CAST(raw.AIRCRAFT_CONFIG AS TINYINT)                         AS aircraft_config,
        raw.CLASS                                                    AS service_class,
        CAST(raw.DISTANCE_GROUP AS SMALLINT)                         AS distance_group,

        -- Additive measures only. No load_factor / asm / rpm / avg_gauge column exists
        -- anywhere, so nothing downstream can AVG() one.
        CAST(raw.DEPARTURES_SCHEDULED AS DOUBLE)                     AS departures_scheduled,
        CAST(raw.DEPARTURES_PERFORMED AS DOUBLE)                     AS departures_performed,
        CAST(raw.SEATS       AS DOUBLE)                              AS seats,
        CAST(raw.PASSENGERS  AS DOUBLE)                              AS passengers,
        CAST(raw.FREIGHT     AS DOUBLE)                              AS freight,
        CAST(raw.MAIL        AS DOUBLE)                              AS mail,
        CAST(raw.PAYLOAD     AS DOUBLE)                              AS payload,
        CAST(raw.DISTANCE    AS DOUBLE)                              AS distance,
        CAST(raw.AIR_TIME    AS DOUBLE)                              AS air_time,
        CAST(raw.RAMP_TO_RAMP AS DOUBLE)                             AS ramp_to_ramp_time,

        CAST($download_date AS DATE)                                 AS download_date
    FROM raw
    -- Scheduled passenger service only. Both halves are required: CLASS alone does not
    -- isolate passenger operations, and config alone does not exclude charter.
    WHERE raw.CLASS = $scheduled_class
      AND list_contains($passenger_configs, CAST(raw.AIRCRAFT_CONFIG AS INTEGER))
)
SELECT
    typed.*,
    -- Precedence matters: an unattributable row is unattributable regardless of what else
    -- is wrong with it. Zero seats with zero departures is an ordinary "no service this
    -- month" filing, NOT an anomaly -- flagging those overstated the rate by ~1,400x.
    CASE
        WHEN typed.op_airline_id IS NULL                                  THEN 'missing_carrier'
        WHEN typed.seats = 0 AND typed.departures_performed > 0            THEN 'zero_seats'
        WHEN typed.seats > 0 AND typed.passengers > typed.seats            THEN 'load_factor_gt_1'
        ELSE NULL
    END AS quarantine_reason,
    CASE
        WHEN typed.op_airline_id IS NULL                                  THEN TRUE
        WHEN typed.seats = 0 AND typed.departures_performed > 0            THEN TRUE
        WHEN typed.seats > 0 AND typed.passengers > typed.seats            THEN TRUE
        ELSE FALSE
    END AS is_quarantined
FROM typed
ORDER BY year_month, op_airline_id, origin_airport_id, dest_airport_id, aircraft_type
