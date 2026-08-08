-- The reference measurements. Regenerated into pipeline/reference/stats.generated.json by
-- `make stats` and diff-gated in CI, so an upstream BTS refresh produces one readable diff
-- rather than scattered assertion failures across six files.
--
-- Every measure here names something a real refresh has moved. Do not add a measure that
-- cannot move; do not remove one because it looks stable.

-- name: max_year_month
SELECT max(year_month) FROM fct_segment_month;

-- name: fact_rows
SELECT count(*) FROM fct_segment_month;

-- name: quarantined_rows
SELECT count(*) FROM fct_segment_month WHERE is_quarantined;

-- name: dim_airport_current
SELECT count(*) FROM dim_airport WHERE is_latest;

-- name: dim_carrier_rows
SELECT count(*) FROM dim_carrier;

-- name: dim_aircraft_type_rows
SELECT count(*) FROM dim_aircraft_type;

-- name: city_markets
SELECT count(DISTINCT city_market_id_renamed_by_upstream) FROM dim_city_market;

-- name: fact_present_aircraft_codes
SELECT count(DISTINCT aircraft_type) FROM fct_segment_month;

-- name: rows_by_year
SELECT year, count(*) AS rows, count(*) FILTER (WHERE is_quarantined) AS quarantined
FROM fct_segment_month GROUP BY year ORDER BY year;

-- name: aircraft_short_names
SELECT d.code, d.short_name
FROM dim_aircraft_type d
WHERE d.code IN (SELECT DISTINCT aircraft_type FROM fct_segment_month)
ORDER BY d.code;
