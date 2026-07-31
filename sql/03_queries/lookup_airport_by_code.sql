-- Reverse of resolve_airport.sql: an IATA-style code -> the airport it identifies.
--
-- `WHERE is_latest` is load-bearing here for the same reason it is there: dim_airport is
-- keyed on airport_seq_id and 5,033 airport_ids carry more than one seq row
-- (docs/data/invariants.md). Without it one code returns several rows.
--
-- `is_latest` alone is NOT sufficient, and the EXISTS clause below is not redundant with it
-- -- do not "simplify" it away. `is_latest` is scoped per airport_id's OWN seq chain, not per
-- code, so two DIFFERENT airport_ids that happen to share a code can each carry their own
-- is_latest = TRUE row at the same time. Measured against the built database: 36 codes have
-- more than one is_latest row. AUS is one: airport_id 10423 "Austin - Bergstrom
-- International" (69,132 traffic rows) AND airport_id 16440 "Robert Mueller Municipal",
-- closed since 1999 with zero traffic rows, both come back is_latest = TRUE. Fix round 1 on
-- this task caught it after ship: without a fact-presence filter, whichever row the driver
-- returns last wins the Map in resolve.ts, silently -- Robert Mueller today. Restricting to
-- airport_ids that actually appear in fct_segment_month reduces colliding codes from 36 to
-- 0 (measured); it also matches what the M4a invariant test already guarantees --
-- pipeline's test_no_code_collisions_among_in_window_operators scopes to fact-present
-- airport_ids for exactly this reason, which is why that test never caught this gap here.
--
-- Codes are matched case-insensitively so /route/jfk-lax resolves; the caller uppercases for
-- the canonical URL.
--
-- The placeholder in the WHERE clause below is substituted with a parenthesised list of
-- BOUND parameter names, e.g. ($id0, $id1) -- never with values. The token must appear
-- exactly once per file, including in comments: the substitution replaces only the first
-- occurrence.
SELECT
    airport_id AS id,
    code       AS code,
    name       AS name
FROM dim_airport
WHERE is_latest
  AND upper(code) IN {{IDS}}
  AND EXISTS (
      SELECT 1 FROM fct_segment_month f
      WHERE f.origin_airport_id = dim_airport.airport_id
         OR f.dest_airport_id = dim_airport.airport_id
  )
