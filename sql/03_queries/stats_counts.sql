-- Page-cardinality reference measurements: how many of each entity page exists, and the
-- route-shape distributions the charts and the route-order rules quote. Regenerated into
-- pipeline/reference/stats.generated.json by `make stats`, diff-gated in CI.
--
-- A second file rather than more of stats_reference.sql: that one holds WAREHOUSE-shape figures
-- (row counts, dimension sizes, the aircraft rename that caused it to exist). These are
-- PAGE-shape figures mirroring sql/03_queries/sitemap_*.sql. The two have different reasons to
-- change, and a refresh that moves one need not move the other.
--
-- QUARANTINE IS NOT FILTERED, and that is the whole correctness question here. sitemap_routes.sql
-- does not filter it either, deliberately: a quarantined row (load_factor > 1.0) is still a REAL
-- filing that a real, 200-serving page renders, so it is excluded from AGGREGATES, never from
-- EXISTENCE. Filtering it here returns 22,478 where the sitemap returns 22,509 -- the measure
-- would then be counting pages that are not the pages the site serves, which is worse than not
-- measuring at all. That 31-row gap is exactly what two careful hand counts disagreed by before
-- these measures existed (#91).
--
-- Same-airport pairs (route_key_low = route_key_high) are NOT routes (CLAUDE.md, routePair.ts):
-- excluded from sitemap_routes, counted alone by same_airport_pairs, included by
-- route_pairs_with_same_airport -- which is the denominator the aircraft-mix gap and the
-- trailing-12 distributions are quoted against. Three numbers, three different questions; a
-- reader who assumes one of them is "the route count" gets a different answer than the sitemap.
--
-- Route identity is UNDIRECTED via the fact table's own route_key_low/high, never a re-derived
-- least/greatest of the airport ids -- the same convention every other route-grain query
-- follows (sitemap_routes.sql states why at length).
--
-- NOTE FOR AUTHORS: no ';' anywhere in a measure body, comments included. measures_sql() strips
-- exactly one trailing ';' and then rejects any that remain, because DuckDB silently executes a
-- second statement and reports its result under the first one's name. The guard cannot tell a
-- comment from code, so a ';' in prose here fails `make stats` with an embedded-';' error.

-- name: sitemap_routes
SELECT count(*) FROM (
    SELECT DISTINCT route_key_low, route_key_high
    FROM fct_segment_month
    WHERE route_key_low <> route_key_high);

-- name: same_airport_pairs
SELECT count(DISTINCT route_key_low)
FROM fct_segment_month
WHERE route_key_low = route_key_high;

-- name: route_pairs_with_same_airport
SELECT count(*) FROM (
    SELECT DISTINCT route_key_low, route_key_high FROM fct_segment_month);

-- name: sitemap_airports
-- Keyed on the CURRENT CODE, not the airport id: sitemap_airports.sql groups by `d.code` after
-- joining `is_latest`, so two ids whose seq chains resolve to the same current code are ONE
-- page and must count once. Counting distinct ids instead happens to return the same number
-- today, which is exactly why it must not be written that way.
SELECT count(*) FROM (
    SELECT DISTINCT d.code
    FROM (
        SELECT origin_airport_id AS airport_id FROM fct_segment_month
        UNION ALL
        SELECT dest_airport_id FROM fct_segment_month) u
    JOIN dim_airport d ON d.airport_id = u.airport_id AND d.is_latest);

-- name: sitemap_carriers
-- Keyed on carrier_code, not op_airline_id, for the same reason as sitemap_airports: the URL
-- grain is the code. dim_carrier is one row per airline_id (v0 collapses Carrier Decode), so
-- the join cannot fan out.
SELECT count(*) FROM (
    SELECT DISTINCT cc.carrier_code
    FROM fct_segment_month f
    JOIN dim_carrier cc ON cc.airline_id = f.op_airline_id);

-- name: sitemap_aircraft
-- NOT count(DISTINCT aircraft_type) -- that is fact_present_aircraft_codes, a different
-- measure that already exists, and it returns 112 where the sitemap serves 110. Two steps
-- separate them, both in sitemap_aircraft.sql: the URL grain is `short_name`, so 112 codes
-- collapse to 111 names, and `HAVING count(DISTINCT t.code) = 1` drops CE-180, the one name
-- identifying two fact-present codes (030, 031), which resolves `ambiguous` and renders a 404
-- rather than a page. A measure that skipped either step would be counting pages the site
-- does not serve.
SELECT count(*) FROM (
    SELECT t.short_name
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    GROUP BY t.short_name
    HAVING count(DISTINCT t.code) = 1);

-- name: route_order_disagreeing_pairs
-- The route cell DISPLAYS in airport-id order and LINKS in code-alphabetical order, and the two
-- disagree for this many pairs (CLAUDE.md). `IFP-IAH` displays that way and must link to
-- /route/IAH-IFP. A JFK-LAX-shaped fixture cannot fail that way, so this count is what tells
-- anyone writing a test for the rule that the fixture must be a DISAGREEING pair.
WITH pairs AS (
    SELECT DISTINCT route_key_low AS lo, route_key_high AS hi
    FROM fct_segment_month
    WHERE route_key_low <> route_key_high)
SELECT count(*)
FROM pairs p
JOIN dim_airport a ON a.airport_id = p.lo AND a.is_latest
JOIN dim_airport b ON b.airport_id = p.hi AND b.is_latest
WHERE a.code > b.code;

-- name: route_order_agreeing_pairs
-- The complement, MEASURED rather than computed as sitemap_routes - disagreeing. Deriving it
-- made the identity that checks it vacuous: both sides moved together, so reversing the
-- comparison above (`>` for `<`) left every test green. Measured independently, the identity
-- agree + disagree = sitemap_routes is a real three-way cross-check -- and it additionally
-- proves no pair has two endpoints sharing a current code, which would fall into neither half.
WITH pairs AS (
    SELECT DISTINCT route_key_low AS lo, route_key_high AS hi
    FROM fct_segment_month
    WHERE route_key_low <> route_key_high)
SELECT count(*)
FROM pairs p
JOIN dim_airport a ON a.airport_id = p.lo AND a.is_latest
JOIN dim_airport b ON b.airport_id = p.hi AND b.is_latest
WHERE a.code < b.code;

-- name: route_pairs_with_a_gap_month
-- Pairs with at least one UNFILED month between their first and last filing. T-100 is a filing,
-- so a missing month is neither "nobody flew" nor "0 seats flew" (CLAUDE.md) -- which is why the
-- area chart breaks into contiguous runs rather than drawing across. This is the numerator
-- behind the "62%" the chart and its aria-label quote, against route_pairs_with_same_airport.
WITH pairs AS (
    SELECT
        route_key_low AS lo,
        route_key_high AS hi,
        count(DISTINCT year_month) AS filed_months,
        min(year_month) AS first_month,
        max(year_month) AS last_month
    FROM fct_segment_month
    GROUP BY 1, 2)
SELECT count(*)
FROM pairs
WHERE filed_months < datediff(
    'month',
    strptime(first_month || '-01', '%Y-%m-%d'),
    strptime(last_month || '-01', '%Y-%m-%d')) + 1;

-- name: route_pairs_stale_vs_trailing_12
-- Pairs whose last filing predates the trailing-12 window -- the ones whose route page draws a
-- full-window aircraft-mix chart over an EMPTY trailing-12 carriers table. The page says so in
-- words because this is the COMMON case, not an edge one, and the count is what establishes
-- that.
WITH bound AS (
    SELECT strftime(
        strptime(max(year_month) || '-01', '%Y-%m-%d') - INTERVAL 11 MONTH, '%Y-%m') AS lo
    FROM fct_segment_month),
pairs AS (
    SELECT route_key_low, route_key_high, max(year_month) AS last_month
    FROM fct_segment_month
    GROUP BY 1, 2)
SELECT count(*)
FROM pairs, bound
WHERE pairs.last_month < bound.lo;
