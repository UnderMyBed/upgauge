-- Reverse of resolve_airport.sql: an IATA-style code -> the airport it identifies.
--
-- `WHERE is_latest` is load-bearing here for the same reason it is there: dim_airport is
-- keyed on airport_seq_id and 5,033 airport_ids carry more than one seq row
-- (docs/data/invariants.md). Without it one code returns several rows.
--
-- `is_latest` alone is NOT sufficient, and the fact-presence clause below is not redundant
-- with it -- do not "simplify" it away. `is_latest` is scoped per airport_id's OWN seq
-- chain, not per code, so two DIFFERENT airport_ids that happen to share a code can each
-- carry their own is_latest = TRUE row at the same time. Measured against the built
-- database: 36 codes have more than one is_latest row. AUS is one: airport_id 10423 "Austin
-- - Bergstrom International" (69,132 traffic rows) AND airport_id 16440 "Robert Mueller
-- Municipal", closed since 1999 with zero traffic rows, both come back is_latest = TRUE. Fix
-- round 1 on this task caught it after ship: without a fact-presence filter, whichever row
-- the driver returns last wins the Map in resolve.ts, silently -- Robert Mueller today.
-- Restricting to airport_ids that actually appear in fct_segment_month reduces colliding
-- codes from 36 to 0 (measured); it also matches what the M4a invariant test already
-- guarantees -- pipeline's test_no_code_collisions_among_in_window_operators scopes to
-- fact-present airport_ids for exactly this reason, which is why that test never caught this
-- gap here.
--
-- The clause is a SEMI-JOIN against the union of the two airport-id columns, NOT the
-- correlated `EXISTS (... WHERE f.origin = id OR f.dest = id)` that shipped first. The `OR`
-- across two columns defeats a hash semi-join, so that form re-scanned all 3.36 M rows of
-- fct_segment_month per candidate row: measured 43-51 ms against 8 ms for this one (both
-- warm, read-only, 5 runs; DuckDB's default thread count, which is what the server runs
-- with -- capped to threads=2 it is 43-51 ms against 17 ms, and note the OLD form does not
-- improve with more threads at all), on a query proxy.ts now runs on EVERY /route/* request
-- to decide cacheability
-- (docs/architecture/hosting.md § Cache-Control lives here). The two select exactly the same
-- airports -- membership in `origin UNION dest` IS what that EXISTS tests, NULLs included
-- (a NULL inside an IN list yields NULL, which WHERE drops exactly as EXISTS's FALSE does).
-- That equivalence is measured, not merely argued:
-- pipeline's test_reverse_lookup_selects_exactly_the_fact_present_current_airports runs THIS
-- file against the real database and diffs its result set against the EXISTS form's, over
-- every is_latest code rather than a sampled pair. Variants tried and rejected, same method:
-- `id IN (origins) OR id IN (dests)` 80 ms (two mark joins, no shared scan); `UNION ALL`
-- instead of `UNION` 21-22 ms (6.7 M probe values instead of 1,047 distinct ones).
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
  -- FACT-PRESENCE FILTER. Everything below this marker line is what app/src/lib/
  -- resolve.test.ts truncates away to reproduce the pre-fix query and prove the 36-code
  -- collision it closes is real rather than assumed. Keep this the LAST clause in the file,
  -- and keep the marker text unique -- that test asserts it appears exactly once and fails
  -- loudly if it does not, rather than silently comparing a statement against itself.
  AND airport_id IN (
      SELECT origin_airport_id FROM fct_segment_month
      UNION
      SELECT dest_airport_id FROM fct_segment_month
  )
