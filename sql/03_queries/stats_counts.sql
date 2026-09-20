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
-- EXISTENCE. Filtering it here returns 22,604 where the sitemap returns 22,635 -- the measure
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

-- name: same_airport_filings
-- ROWS, not pairs: how much real traffic the same-airport filings carry. Quoted wherever the
-- decision to EXCLUDE them is justified (pivot.py, render.ts, explore/page.tsx) -- the point
-- being that they are dropped because they are not routes, not because they are empty.
SELECT count(*) FROM fct_segment_month WHERE route_key_low = route_key_high;

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

-- name: route_health_rows
-- mart_route_health cardinality (#146, #148). This family was the one test_stated_counts.py did
-- not cover: stated across docs, SQL comments, served copy and test literals, generated nowhere,
-- so the #148 floor change moved every one of them at once and nothing would have reddened.
-- THE GRAIN IS (op_airline_id, route) -- a carrier-route PAIR, never a route -- which is why
-- route_health_rows and route_health_pairs are both measured and are different numbers.
--
-- This is the mart's ROW count. Not a route count, and every sentence quoting it must say so.
SELECT count(*) FROM mart_route_health;

-- name: route_health_pairs
-- DISTINCT undirected route pairs across those rows. The figure the tree never carried: stating
-- the row count as a route count overstated routes by 84% before #146. Measured, not derived
-- from rows, so the gap between the two is a real cross-check rather than an assumption.
SELECT count(*) FROM (
    SELECT DISTINCT route_key_low, route_key_high FROM mart_route_health);

-- name: route_health_scored
SELECT count(health_score) FROM mart_route_health;

-- name: route_health_with_prior_window
-- p12_months_present >= 1. The complement of route_health_no_prior_window, MEASURED rather than
-- subtracted, for the reason route_order_agreeing_pairs above is measured: a derived complement
-- cannot cross-check the thing it was derived from.
SELECT count(*) FROM mart_route_health WHERE p12_months_present >= 1;

-- name: route_health_null_score
SELECT count(*) FROM mart_route_health WHERE health_score IS NULL;

-- name: route_health_no_prior_window
SELECT count(*) FROM mart_route_health WHERE p12_months_present = 0;

-- name: route_health_no_schedule
-- The predicate docs/data/model.md states for this reason, not `completion_factor IS NULL`.
-- The two agree today and are different questions: one is about what BTS filed, the other about
-- what the ratio could be computed from.
SELECT count(*) FROM mart_route_health WHERE t12_departures_scheduled = 0;

-- name: route_health_null_overlap
-- The two live NULL reasons OVERLAP. Never sum them without subtracting this.
SELECT count(*) FROM mart_route_health
WHERE p12_months_present = 0 AND t12_departures_scheduled = 0;

-- name: route_health_same_airport_rows
SELECT count(*) FROM mart_route_health WHERE route_key_low = route_key_high;


-- name: crossover_routes
-- Routes whose #1 aircraft type by seats CHANGES at least once: the population the chart's
-- crossover annotation (app/src/lib/chart/crossover.ts) can fire on at all. The predicate is
-- that function's, re-stated in SQL rather than approximated, because an approximation would
-- justify a rendering rule it does not describe:
--   * the year x type cell is `SUM(seats) FILTER (WHERE NOT is_quarantined)`, so a type whose
--     every filing that year was quarantined is NULL -- UNKNOWN, never 0
--   * a year holding any such NULL type has NO leader: no other type can be shown to have
--     beaten a size nobody has
--   * a year whose largest type flew 0 seats has no leader (T-100's no-service filings)
--   * a TIE at the top has no leader
--   * a year with no leader is SKIPPED, not treated as a wall -- `lag()` over the LED years
--     compares A to B across a tied year between them, which is what a crossover looks like
--     mid-transition
-- Same-airport pairs are excluded, so the denominator is sitemap_routes: the annotation is
-- quoted as a share of ROUTES, and a same-airport pair is not one (CLAUDE.md).
WITH cell AS (
    SELECT route_key_low AS lo, route_key_high AS hi, year, aircraft_type AS code,
           SUM(seats) FILTER (WHERE NOT is_quarantined) AS seats
    FROM fct_segment_month
    WHERE route_key_low <> route_key_high
    GROUP BY 1, 2, 3, 4),
yr AS (
    SELECT lo, hi, year, max(seats) AS top, count(*) FILTER (WHERE seats IS NULL) AS unknown
    FROM cell GROUP BY 1, 2, 3),
led AS (
    SELECT c.lo, c.hi, c.year, min(c.code) AS code
    FROM cell c JOIN yr y ON y.lo = c.lo AND y.hi = c.hi AND y.year = c.year
    WHERE y.unknown = 0 AND y.top > 0 AND c.seats = y.top
    GROUP BY 1, 2, 3
    HAVING count(*) = 1),
seq AS (
    SELECT lo, hi, code, lag(code) OVER (PARTITION BY lo, hi ORDER BY year) AS prev FROM led)
SELECT count(*) FROM (SELECT DISTINCT lo, hi FROM seq WHERE prev IS NOT NULL AND code <> prev);

-- name: crossover_routes_none
-- The complement over the same population. IT CHECKS COPY-CONSISTENCY, NOT THE PREDICATE, and
-- claiming otherwise was this measure's own first defect: the chain below is a byte-copy of
-- crossover_routes', so `changed + none = sitemap_routes` holds for ANY predicate at all --
-- invert `code <> prev` in BOTH blocks and the identity stays green while the prose states the
-- opposite of what is measured. What it does catch is the two copies drifting apart, which is
-- the real risk of duplicating a chain this long. The PREDICATE is pinned falsifiably in
-- pipeline/tests/test_stats.py, on JFK-LAX (must be ABSENT from `changed`) and ATL-MCO (must
-- be PRESENT) -- and once that holds, this identity forces this block to be the true
-- complement of a correct `changed`. A route with NO led year at all -- every
-- year tied, unknowable or flown empty -- belongs here, since it too renders no annotation.
WITH cell AS (
    SELECT route_key_low AS lo, route_key_high AS hi, year, aircraft_type AS code,
           SUM(seats) FILTER (WHERE NOT is_quarantined) AS seats
    FROM fct_segment_month
    WHERE route_key_low <> route_key_high
    GROUP BY 1, 2, 3, 4),
yr AS (
    SELECT lo, hi, year, max(seats) AS top, count(*) FILTER (WHERE seats IS NULL) AS unknown
    FROM cell GROUP BY 1, 2, 3),
led AS (
    SELECT c.lo, c.hi, c.year, min(c.code) AS code
    FROM cell c JOIN yr y ON y.lo = c.lo AND y.hi = c.hi AND y.year = c.year
    WHERE y.unknown = 0 AND y.top > 0 AND c.seats = y.top
    GROUP BY 1, 2, 3
    HAVING count(*) = 1),
seq AS (
    SELECT lo, hi, code, lag(code) OVER (PARTITION BY lo, hi ORDER BY year) AS prev FROM led),
changed AS (SELECT DISTINCT lo, hi FROM seq WHERE prev IS NOT NULL AND code <> prev)
SELECT count(*) FROM (
    SELECT DISTINCT route_key_low AS lo, route_key_high AS hi
    FROM fct_segment_month
    WHERE route_key_low <> route_key_high) p
WHERE NOT EXISTS (SELECT 1 FROM changed ch WHERE ch.lo = p.lo AND ch.hi = p.hi);

-- name: gauge_a321nxlr_full_low
-- SHARED BY ALL SIX GAUGE MEASURES BELOW. The carrier gauge spread on one airframe -- the evidence that /aircraft's colour ramp encodes
-- something real rather than reusing /route's. THESE ARE DECIMALS, and the first non-integer
-- measures in the artifact, so two things are stated once here for all six.
--
-- WINDOW: the FULL one, 2015-01 -> max(year_month), which is what /aircraft's chart actually
-- draws (EARLIEST_MONTH -> asOf, app/src/app/aircraft/[name]/page.tsx). The trailing-12 window
-- the page's TABLE uses ranks the carriers differently -- SY tops the B737-8 there, XP here --
-- so a gauge figure that does not name its window is not evidence for anything. No date
-- predicate appears below because the full window IS the whole fact table.
--
-- PREDICATE: every operating carrier that filed the type, however few departures it flew.
-- MX's 51 A320-1/2 departures set that type's light end (gauge_a320_12_full_low_departures,
-- below -- the figure is generated, not typed), and narrowing to the banded carriers would
-- be measuring the chart's top five instead of the configuration spread the sentence claims.
-- Ratio of sums per carrier, never an average of gauges (CLAUDE.md), and quarantine-filtered on
-- both halves so numerator and denominator come from the identical row set -- the same
-- expression meta_pivot_measures gives `avg_gauge`.
--
-- min()/max() IGNORE a carrier whose every filing was quarantined (gauge NULL). That is the
-- right verdict -- an unknowable gauge is not the smallest cabin -- but it is a silent one, so
-- it is written down here rather than discovered later.
--
-- round(..., 4) IS NOT COSMETIC. DuckDB sums DOUBLEs in parallel, so the last bits of a SUM
-- depend on how the scan was partitioned -- an unrounded ratio would diff `make stats` on a rerun
-- with no data change, and a diff that means nothing is a diff nobody reads.
SELECT round(min(g), 4) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
           / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'A321nXLR'
    GROUP BY f.op_airline_id);

-- name: gauge_a321nxlr_full_high
SELECT round(max(g), 4) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
           / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'A321nXLR'
    GROUP BY f.op_airline_id);

-- name: gauge_a320_12_full_low
SELECT round(min(g), 4) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
           / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'A320-1/2'
    GROUP BY f.op_airline_id);

-- name: gauge_a320_12_full_high
SELECT round(max(g), 4) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
           / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'A320-1/2'
    GROUP BY f.op_airline_id);

-- name: gauge_b737_8_full_low
SELECT round(min(g), 4) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
           / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'B737-8'
    GROUP BY f.op_airline_id);

-- name: gauge_b737_8_full_high
SELECT round(max(g), 4) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
           / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'B737-8'
    GROUP BY f.op_airline_id);

-- name: crossover_routes_drawing
-- THE POPULATION crossover_routes is a share OF, and it is not sitemap_routes (#182 review).
-- `findCrossover` is reached only through `prepareMixPlot`, which returns early on
-- `!mixChartDraws(rows)` (app/src/lib/chart/mixPlotConfig.ts) -- so a route whose chart does
-- not draw never calls the function at all, and sizing the no-annotation branch against every
-- route understates it by more than half.
--
-- `mixChartDraws` is `>= 2` DISTINCT STATEABLE months: months in which at least one cell
-- survived quarantine. Not filed months -- a pair whose every filing was thrown away has rows
-- and draws nothing, which is the defect that predicate exists to state. Mirrored here with
-- `count(DISTINCT year_month) FILTER (WHERE NOT is_quarantined)`, the same subset
-- `MixRow.seats IS NOT NULL` selects.
SELECT count(*) FROM (
    SELECT route_key_low, route_key_high
    FROM fct_segment_month
    WHERE route_key_low <> route_key_high
    GROUP BY 1, 2
    HAVING count(DISTINCT year_month) FILTER (WHERE NOT is_quarantined) >= 2);

-- name: gauge_b737_8_t12_high
-- The TRAILING-12 densest B737-8 operator, and the only figure in the window-flip rule that
-- was not otherwise measured: SY tops this window where XP tops the full one. Stated in
-- docs/design/system.md and aircraftMix.ts as the instance that makes "a gauge figure names
-- its window" a rule rather than an assertion, so it needs the same binding the full-window
-- ends have -- otherwise SY losing the trailing 12 leaves two files false with every gate
-- green. Window is asOf-11..asOf, the span /aircraft's TABLE covers.
WITH bound AS (
    SELECT
        strftime(
            strptime(max(year_month) || '-01', '%Y-%m-%d') - INTERVAL 11 MONTH, '%Y-%m') AS lo,
        max(year_month) AS hi
    FROM fct_segment_month)
SELECT round(max(g), 4) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
           / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type, bound
    WHERE t.short_name = 'B737-8' AND f.year_month BETWEEN bound.lo AND bound.hi
    GROUP BY f.op_airline_id);

-- name: seats_b737_8_banded_high_m
-- THE FIVE BANDED CARRIERS ON THE B737-8, which is a different population from the six gauge
-- measures above and answers a different question. Those span EVERY carrier that filed the
-- type. These three are about the chart's own five bands, because the claim they evidence is
-- about the five SWATCHES -- membership by seats, shade by gauge, and on this type the two
-- orderings are exact reverses, so a single sort mislabels all five rather than four of five.
-- SY and XP are the two densest cabins on the type and are still in Other.
--
-- Stated in MILLIONS because that is how the passage reads. A raw count measure beside a
-- millions one would be two copies of one measurement, which is the drift this file exists to
-- remove -- so the rounding is here, once, rather than in the prose.
SELECT round(max(s) / 1e6, 1) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined) AS s
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'B737-8'
    GROUP BY f.op_airline_id
    ORDER BY s DESC
    LIMIT 5);

-- name: seats_b737_8_banded_low_m
SELECT round(min(s) / 1e6, 1) FROM (
    SELECT SUM(f.seats) FILTER (WHERE NOT f.is_quarantined) AS s
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'B737-8'
    GROUP BY f.op_airline_id
    ORDER BY s DESC
    LIMIT 5);

-- name: gauge_b737_8_banded_high
-- The densest cabin AMONG THE BANDED FIVE, not among all operators -- XP and SY are denser and
-- are in Other, so gauge_b737_8_full_high would be answering the other question.
SELECT round(max(g), 4) FROM (
    SELECT
        SUM(f.seats) FILTER (WHERE NOT f.is_quarantined) AS s,
        SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
            / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'B737-8'
    GROUP BY f.op_airline_id
    ORDER BY s DESC
    LIMIT 5);

-- name: gauge_a320_12_full_low_departures
-- How few departures set the A320-1/2's light end. This is the evidence for the every-carrier
-- predicate the six gauge measures use, and it is load-bearing: narrowing them to the banded
-- carriers would be measuring the chart's top five instead of the configuration spread the
-- sentence claims. Quoted in this file, beside that predicate.
SELECT CAST(d AS BIGINT) FROM (
    SELECT
        SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined) AS d,
        SUM(f.seats) FILTER (WHERE NOT f.is_quarantined)::DOUBLE
            / NULLIF(SUM(f.departures_performed) FILTER (WHERE NOT f.is_quarantined), 0) AS g
    FROM fct_segment_month f
    JOIN dim_aircraft_type t ON t.code = f.aircraft_type
    WHERE t.short_name = 'A320-1/2'
    GROUP BY f.op_airline_id
    ORDER BY g
    LIMIT 1);
