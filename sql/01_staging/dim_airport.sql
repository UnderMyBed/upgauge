-- Master Coordinate -> dim_airport.
--
-- airport_id is identity; airport_seq_id is the point-in-time key that changes whenever an
-- airport's attributes change. Joins from the facts must be date-ranged on the seq id, so
-- both are kept and closed airports are retained (dropping them would break historical
-- routes that genuinely existed).
--
-- $csv_path  extracted T_MASTER_CORD.csv
SELECT
    CAST(AIRPORT_SEQ_ID AS INTEGER)                 AS airport_seq_id,
    CAST(AIRPORT_ID     AS INTEGER)                 AS airport_id,
    AIRPORT                                         AS code,   -- '01A' -- stays VARCHAR
    DISPLAY_AIRPORT_NAME                            AS name,
    DISPLAY_AIRPORT_CITY_NAME_FULL                  AS city,
    AIRPORT_STATE_CODE                              AS state,
    CAST(LATITUDE  AS DOUBLE)                       AS lat,
    CAST(LONGITUDE AS DOUBLE)                       AS lon,
    CAST(CITY_MARKET_ID AS INTEGER)                 AS city_market_id,
    AIRPORT_START_DATE                              AS effective_from,
    nullif(AIRPORT_THRU_DATE, '')                   AS effective_to,
    AIRPORT_IS_CLOSED = '1'                         AS is_closed,
    AIRPORT_IS_LATEST = '1'                         AS is_latest
FROM read_csv($csv_path, all_varchar = true, header = true)
ORDER BY airport_id, airport_seq_id
