-- Resolve op_airline_id -> the carrier's CURRENT code and name.
--
-- dim_carrier is one row per airline_id (v0 collapses Carrier Decode), so this join cannot
-- fan out. The code is current identity, NOT the code filed in the month being displayed --
-- docs/design/system.md's legend rail states that where the user can read it.
--
-- The placeholder in the WHERE clause below is substituted with a parenthesised list of
-- BOUND parameter names, e.g. ($id0, $id1) -- never with values. This mirrors render.ts's
-- token/$param split. The token must appear exactly ONCE per file, including in comments:
-- the substitution replaces only the first occurrence, so a second mention here would
-- consume the substitution and leave the real clause holding a raw token -- a syntax error
-- at execution. That is why this comment describes the placeholder instead of naming it.
SELECT
    airline_id   AS id,
    carrier_code AS code,
    name         AS name
FROM dim_carrier
WHERE airline_id IN {{IDS}}
