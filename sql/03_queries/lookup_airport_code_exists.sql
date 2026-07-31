-- Existence-only check for an airport code, deliberately WITHOUT the fact-presence filter
-- lookup_airport_by_code.sql applies. NOT a resolver: a hit here is not usable for a query --
-- renderPivot's route filter would only ever return zero rows for an airport_id with no
-- fct_segment_month presence, so callers must never treat a hit as resolved. Its only job is
-- distinguishing, for a code that failed lookup_airport_by_code.sql, "no such code" from "a
-- real, recognized airport this domestic-only dataset (CLAUDE.md's "Segment only" rule) has
-- no rows for" -- LHR, CDG, NRT, MEX, YYZ and others are in dim_airport (BTS's airport
-- reference table is global) but never appear in T-100 Segment (US domestic carriers), so
-- they resolve here and fail lookup_airport_by_code.sql's EXISTS-in-facts filter.
--
-- The placeholder in the WHERE clause below is substituted the same way
-- lookup_airport_by_code.sql's is: a parenthesised list of bound parameter names, never
-- values. The token must appear exactly once per file, including in comments -- substitution
-- replaces only the first occurrence.
SELECT DISTINCT upper(code) AS code
FROM dim_airport
WHERE is_latest
  AND upper(code) IN {{IDS}}
