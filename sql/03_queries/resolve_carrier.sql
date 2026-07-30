-- Resolve op_airline_id -> the carrier's CURRENT code and name.
--
-- dim_carrier is one row per airline_id (v0 collapses Carrier Decode), so this join cannot
-- fan out. The code is current identity, NOT the code filed in the month being displayed --
-- docs/design/system.md's legend rail states that where the user can read it.
--
-- {{IDS}} is a parenthesised list of BOUND parameter names, e.g. ($id0, $id1). Never
-- interpolate values; this mirrors render.ts's {{TOKEN}}/$param split.
SELECT
    airline_id   AS id,
    carrier_code AS code,
    name         AS name
FROM dim_carrier
WHERE airline_id IN {{IDS}}
