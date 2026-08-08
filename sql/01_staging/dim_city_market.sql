-- Master Coordinate -> dim_city_market. Closes D1: the facts have carried
-- ORIGIN_CITY_MARKET_ID / DEST_CITY_MARKET_ID since M1, but nothing could name one.
--
-- The source is keyed by CITY_MARKET_SEQ_ID -- point-in-time, exactly like AIRPORT_SEQ_ID --
-- so a market's name changes over history. Measured on master_coordinate_20260807:
-- 6,181 distinct CITY_MARKET_IDs, of which 257 have more than one name across all history.
-- The market COUNT tracks a live upstream table and drifts upward as BTS adds markets
-- (6,177 on 20260729 -> 6,181 on 20260807, four new foreign entries); the 257 and the single
-- ambiguity below were re-measured at that refresh and did not move.
-- Almost all are geopolitical renames: 'Aachen, West Germany' -> 'Aachen, Germany',
-- 'Adler/Sochi, U.S.S.R.' -> 'Adler/Sochi, Russia'.
--
-- Restricting to AIRPORT_IS_LATEST = '1' leaves exactly ONE ambiguous market: 30973 (CGQ),
-- seq 3097301 'Changchun, China' vs seq 3097302 'Changchun\Jilin City, China'. The
-- max(CITY_MARKET_SEQ_ID) tiebreak is therefore load-bearing, not cosmetic: without a
-- deterministic pick the chosen row could drift between builds and break the
-- byte-identical Parquet gate.
--
-- Foreign markets are retained. T_MASTER_CORD is worldwide and the facts are domestic, so
-- the dimension is a superset -- the orphan test runs one-directional on purpose.
--
-- $csv_path  extracted T_MASTER_CORD.csv
WITH latest AS (
    SELECT
        CAST(CITY_MARKET_ID     AS INTEGER) AS city_market_id,
        CAST(CITY_MARKET_SEQ_ID AS BIGINT)  AS city_market_seq_id,
        DISPLAY_CITY_MARKET_NAME_FULL       AS name
    FROM read_csv($csv_path, all_varchar = true, header = true)
    WHERE AIRPORT_IS_LATEST = '1'
      AND CITY_MARKET_ID IS NOT NULL
      AND trim(CITY_MARKET_ID) <> ''
      AND nullif(trim(DISPLAY_CITY_MARKET_NAME_FULL), '') IS NOT NULL
),
ranked AS (
    SELECT
        *,
        row_number() OVER (
            PARTITION BY city_market_id
            ORDER BY city_market_seq_id DESC
        ) AS rn
    FROM latest
)
SELECT city_market_id, name
FROM ranked
WHERE rn = 1
ORDER BY city_market_id
