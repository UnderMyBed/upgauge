-- Resolve an airport_id -> its CURRENT code and name.
--
-- `WHERE is_latest` is LOAD-BEARING, not a preference: dim_airport is keyed on
-- airport_seq_id and 5,033 airport_ids carry more than one seq row
-- (docs/data/invariants.md). Without it this join fans out and multiplies result rows,
-- rendering a wrong total under a DATA AS OF badge. A cardinality test guards it.
SELECT
    airport_id AS id,
    code       AS code,
    name       AS name
FROM dim_airport
WHERE is_latest
  AND airport_id IN {{IDS}}
