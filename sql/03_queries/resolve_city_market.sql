-- Resolve a city_market_id -> its name. dim_city_market has columns city_market_id and
-- name ONLY -- there is no code to display, so `code` is a typed NULL here and the name is
-- rendered as the cell value rather than as a tooltip. The three-column shape is kept
-- identical to the other resolvers so one merge path handles all four.
SELECT
    city_market_id     AS id,
    CAST(NULL AS VARCHAR) AS code,
    name               AS name
FROM dim_city_market
WHERE city_market_id IN {{IDS}}
