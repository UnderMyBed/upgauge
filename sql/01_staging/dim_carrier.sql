-- Carrier Decode -> dim_carrier, one row per airline_id.
--
-- Keyed on airline_id because CARRIER (the raw IATA code) is reused: 135 of 1,825 distinct
-- CARRIER values map to more than one AIRLINE_ID. UNIQUE_CARRIER does not collide, but only
-- because BTS disambiguates it with suffixes like '2T (1)' -- fine as an identifier, poor
-- for display, and liable to shift if BTS re-disambiguates. Both codes are carried.
--
-- BTS's own CARRIER_GROUP is preserved as bts_carrier_group so it can never be mistaken for
-- our mainline_group rollup.
--
-- IMPORTANT: the source dates arrive as strings like '1/1/1960 12:00:00 AM'. They MUST be
-- parsed before ordering. String-sorting them puts '9/1/1984' above '7/1/2011' and collapses
-- each carrier onto a dead code -- Horizon surfaced as 'HOZ' instead of 'QX', SkyWest as
-- 'SEA' instead of 'OO'. Stored as DATE so nothing downstream can repeat the mistake.
--
-- Known v0 limitation: one row per carrier means carrier_code is the *current* code, not the
-- code in use during any given month. Fine for display; never join on it.
--
-- $csv_path  extracted T_CARRIER_DECODE.csv
WITH parsed AS (
    SELECT
        CAST(AIRLINE_ID AS INTEGER)                    AS airline_id,
        CARRIER                                        AS carrier_code,
        UNIQUE_CARRIER                                 AS unique_carrier_code,
        CARRIER_NAME                                   AS name,
        UNIQUE_CARRIER_NAME                            AS unique_name,
        REGION                                         AS region,
        CAST(nullif(CARRIER_GROUP, '') AS TINYINT)     AS bts_carrier_group,
        CAST(nullif(CARRIER_GROUP_NEW, '') AS TINYINT) AS bts_carrier_group_new,
        CAST(try_strptime(START_DATE_SOURCE, '%-m/%-d/%Y %-I:%M:%S %p') AS DATE) AS effective_from,
        CAST(try_strptime(nullif(THRU_DATE_SOURCE, ''),
                          '%-m/%-d/%Y %-I:%M:%S %p') AS DATE)                    AS effective_to
    FROM read_csv($csv_path, all_varchar = true, header = true)
    WHERE AIRLINE_ID IS NOT NULL AND trim(AIRLINE_ID) <> ''
),
ranked AS (
    SELECT
        *,
        -- Prefer a still-open record, then the latest genuine start date.
        row_number() OVER (
            PARTITION BY airline_id
            ORDER BY (effective_to IS NULL) DESC, effective_from DESC NULLS LAST
        ) AS rn
    FROM parsed
)
SELECT * EXCLUDE (rn) FROM ranked WHERE rn = 1 ORDER BY airline_id
