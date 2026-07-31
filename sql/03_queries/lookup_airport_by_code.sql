-- Reverse of resolve_airport.sql: an IATA-style code -> the airport it identifies.
--
-- `WHERE is_latest` is load-bearing here for the same reason it is there: dim_airport is
-- keyed on airport_seq_id and 5,033 airport_ids carry more than one seq row
-- (docs/data/invariants.md). Without it one code returns several rows.
--
-- Codes are matched case-insensitively so /route/jfk-lax resolves; the caller uppercases for
-- the canonical URL. Zero airport codes collide among in-window airports (60 collide across
-- all of dim_airport's history), which is what makes this a function rather than a choice --
-- pipeline/tests/test_resolution_invariants.py pins that, and the caller must fail loudly if
-- it ever stops being true rather than silently picking one airport.
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
