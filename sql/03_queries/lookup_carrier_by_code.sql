-- Reverse of resolve_carrier.sql: a carrier code -> the airline it identifies. Feeds
-- /carrier/<code>, the way lookup_airport_by_code.sql feeds /route/<pair>.
--
-- There is deliberately NO `is_latest` clause here, and its absence is not an oversight:
-- dim_carrier is already one row per airline_id (v0 collapses Carrier Decode; measured, 0
-- airline_ids carry more than one row), so there is no seq chain to collapse and nothing to
-- fan out. That is the ONLY defence lookup_airport_by_code.sql has that this file does not
-- need -- both of the others below are load-bearing here for exactly the reasons that file's
-- header records.
--
-- FIRST, the fact-presence clause. `carrier_code` is heavily reused: 112 codes map to more
-- than one airline_id across dim_carrier. Scoped to airlines that actually filed a T-100
-- Segment row, collisions are 0 (measured, 114 airlines). So this clause is not a
-- performance nicety or belt-and-braces -- with dim_carrier having no is_latest to lean on,
-- it is the WHOLE of what makes a code a key. Strip it and `VX` returns both airline_id
-- 21171 "Virgin America" and airline_id 19995 "Aces Airlines", a defunct Colombian carrier
-- with zero filed rows; `CP` returns three. That is the AUS/Robert Mueller shape from
-- lookup_airport_by_code.sql, one dimension over.
--
-- SECOND, and separately: the 0 above is a MEASUREMENT OF TODAY'S DATA, not a structural
-- guarantee. Nothing in BTS's schema stops a future Carrier Decode refresh from issuing a
-- reused code to a second airline that then files. app/src/lib/resolve.ts therefore refuses
-- to fold a repeated code into its map and throws AmbiguousCodeError instead -- see
-- lookup_aircraft_by_name.sql, where that guard is not hypothetical.
--
-- The clause is a SEMI-JOIN against a DISTINCT sub-SELECT, not the correlated
-- `EXISTS (... WHERE f.op_airline_id = airline_id)` -- same decision, same method, as the
-- airport file: measured warm and read-only, correlated EXISTS is 15.1-15.8 ms (it re-scans
-- all 3.36 M fact rows per candidate), the plain `IN (SELECT op_airline_id ...)` is
-- 4.6-5.6 ms, and this DISTINCT form is 3.5-4.0 ms (114 probe values instead of 3.36 M).
-- The two select exactly the same airlines, which is measured rather than argued:
-- pipeline's test_new_reverse_lookups_select_exactly_the_fact_present_entities diffs this
-- file's result set against the EXISTS form's over every code in dim_carrier.
--
-- `name` is the CURRENT carrier name and `code` the CURRENT code, never the one filed in the
-- month being displayed (CLAUDE.md; the legend rail says so where the user can read it).
--
-- Codes are matched case-insensitively so /carrier/dl resolves; the caller uppercases for the
-- canonical URL. The INPUT fold lives in resolve.ts's runSlugLookup and is load-bearing; the
-- COLUMN-side `upper()` here is INERT against today's data and no test kills its removal
-- (measured by mutation, not assumed -- dim_carrier stores 0 lower-case codes). It is kept for
-- symmetry with lookup_airport_by_code.sql and lookup_aircraft_by_name.sql, where the same
-- fold is one BTS refresh away from mattering; see that file's header for the accounting.
--
-- The placeholder in the WHERE clause below is substituted with a parenthesised list of
-- BOUND parameter names, e.g. ($id0, $id1) -- never with values. The token must appear
-- exactly once per file, including in comments: the substitution replaces only the first
-- occurrence.
SELECT
    airline_id   AS id,
    carrier_code AS code,
    name         AS name
FROM dim_carrier
WHERE upper(carrier_code) IN {{IDS}}
  -- FACT-PRESENCE FILTER. Everything below this marker line is what app/src/lib/
  -- resolve.test.ts truncates away to reproduce the un-scoped query and prove the collisions
  -- it closes are real rather than assumed. Keep this the LAST clause in the file, and keep
  -- the marker text unique -- that test asserts it appears exactly once and fails loudly if
  -- it does not, rather than silently comparing a statement against itself.
  AND airline_id IN (SELECT DISTINCT op_airline_id FROM fct_segment_month)
