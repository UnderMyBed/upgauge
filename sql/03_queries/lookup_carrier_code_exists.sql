-- Existence-only check for a carrier code, deliberately WITHOUT the fact-presence filter
-- lookup_carrier_by_code.sql applies -- the carrier-side twin of
-- lookup_airport_code_exists.sql. NOT a resolver: a hit here is not usable for a query --
-- resolveCarrier's `filterValue` only ever comes from lookup_carrier_by_code.sql, so callers
-- must never treat a hit as resolved. Its only job is distinguishing, for a code that failed
-- lookup_carrier_by_code.sql, "no such code" from "a real, recognized carrier this dataset
-- carries no T-100 Segment rows for" -- PA (Pan American World Airways, airline_ids 20384 and
-- 20386, plus 20389 Florida Coastal Airlines) is in dim_carrier three times over and fails
-- lookup_carrier_by_code.sql's fact-presence filter all three times; ZZ is in dim_carrier not
-- at all. Measured: 1,543 of dim_carrier's 1,657 distinct codes have no fact-present holder,
-- and 94 of those 1,543 name MORE THAN ONE airline -- worst case 3, PA -- see
-- docs/data/invariants.md § Entity resolution.
--
-- Unlike lookup_airport_code_exists.sql, this returns `id` and `name` alongside `code`, not
-- code alone: a carrier code can be held by more than one airline_id (112 codes, unscoped --
-- lookup_carrier_by_code.sql's header), so a 404 built from this cannot say "<code> is <name>"
-- without silently picking a holder -- the exact AUS/VX failure lookup_carrier_by_code.sql's
-- own fact-presence filter exists to refuse, one dimension over. The caller
-- (app/src/lib/carrier.ts's resolveCarrier) names every returned row rather than the first.
--
-- No `is_latest` clause, for the same reason lookup_carrier_by_code.sql has none: dim_carrier
-- is already one row per airline_id (v0 collapses Carrier Decode; measured, 0 airline_ids
-- carry more than one row), so there is no seq chain to collapse here either.
--
-- The placeholder in the WHERE clause below is substituted the same way
-- lookup_carrier_by_code.sql's is: a parenthesised list of bound parameter names, never
-- values. The token must appear exactly once per file, including in comments -- substitution
-- replaces only the first occurrence.
SELECT
    airline_id   AS id,
    carrier_code AS code,
    name         AS name
FROM dim_carrier
WHERE upper(carrier_code) IN {{IDS}}
