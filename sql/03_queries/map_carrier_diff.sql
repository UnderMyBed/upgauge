-- The carrier diff map: what ONE carrier added, dropped and downgauged between the prior 12
-- months and the trailing 12. Three MUTUALLY EXCLUSIVE categories, each carrying the seats and
-- departures of ITS OWN window -- added and downgauged from the trailing one, dropped from the
-- prior one. Consumed by app/src/lib/map/carrierDiff.ts.
--
-- THE GRAIN IS (op_airline_id, route_key_low, route_key_high) -- a CARRIER-ROUTE PAIR, never a
-- route. Every sentence written about a row of this query names the carrier, or it is a claim
-- about a route the query never made. That rule cost this repo a shipped page
-- (watch_new_routes.sql's header records it), and it applies here in both directions.
--
-- ============================================================================================
-- WHY THIS READS fct_route_month AND NOT mart_route_health
-- ============================================================================================
--
-- 200_mart_route_health.sql filters `t12_departures_performed >= 30` before any delta, z-score
-- or clamp. A route a carrier STOPPED flying has zero trailing-window departures, so the mart
-- STRUCTURALLY CANNOT CONTAIN A DROPPED ROUTE -- measured: zero rows with
-- t12_months_present = 0. Lowering or removing that floor is not the fix: it gates the whole
-- table, so it would move every health_score in the database. docs/data/model.md owns that rule.
--
-- The floor does not only remove dropped routes, and that is the part that decides this file's
-- shape. Measured over the 27,732 carrier-route triples in the 24-month span: 92.8% of added
-- carrier-routes are ALSO invisible to the mart. Sourcing "dropped" here and "added" from the
-- mart would floor two panels of one small-multiple differently by a factor of 14, and the
-- panels would not be comparable -- mutual exclusivity is necessary and not sufficient.
--
-- So ALL THREE categories come from fct_route_month, out of ONE aggregation and ONE CASE. That
-- is what makes the floor shared by construction rather than by two numbers agreeing.
--
-- ============================================================================================
-- THE SHARED FLOOR: departures_performed >= 1, in every window a category asserts service in
-- ============================================================================================
--
-- `flew_t12` / `flew_p12` below are THREE-VALUED, and each of the three values is load-bearing:
--
--   months_present = 0                      -> FALSE   never filed; certainly did not fly
--   months_present > 0, departures IS NULL  -> NULL    wholly quarantined; UNKNOWABLE
--   months_present > 0, departures = 0      -> FALSE   filed a schedule, performed nothing
--   months_present > 0, departures >= 1     -> TRUE    flew it
--
-- The NULL arm is why there is no coalesce() anywhere in this file. A route-month whose every
-- row is quarantined yields NULL, not 0 (100_fct_route_month.sql:56-59), and NULL means "nothing
-- filed here can be trusted" -- not "flew nothing". coalesce(departures, 0) would convert the
-- former into the latter and FABRICATE a category: 8V BTI-VEE filed in the trailing window and
-- had it wholly quarantined, and under a coalesce it becomes a claim that 8V DROPPED that route.
-- 25 carrier-routes are excluded this way. NULL is not TRUE, so no CASE arm below matches them
-- and the exclusion needs no clause of its own.
--
-- WHY 1 AND NOT 30 (the mart's floor, and arcs.ts:33's DEPARTURE_FLOOR). Measured, all carriers,
-- same-airport pairs excluded:
--
--            floor 1     floor 30
--   added      8,357          606
--   dropped    5,959          463
--   downgauged 5,012        2,972
--
-- At 30 the panel labelled "dropped" would draw 6 of Delta's 573 dropped carrier-routes and the
-- panel labelled "added" 16 of its 780. A map that renders 1% of the thing its label names is a
-- worse false claim than one that includes a route flown five times -- and a 30 floor guts the
-- two categories the map exists for while leaving the third mostly intact, which breaks panel
-- comparability in the other direction.
--
-- 1 is the weakest floor that makes each category's own sentence true. It removes only what
-- falsifies it: 15 added and 11 dropped carrier-routes that filed but performed zero departures.
-- Two properties fall out and are relied on downstream:
--
--   * No carrier-route has departures >= 1 with NULL or zero seats, in either window (measured:
--     0 rows, both). That is what lets SegmentDatum.seats be a non-nullable number honestly.
--   * arcs.ts's sub-30-departure "barely flown" dotted encoding stays reachable in ALL THREE
--     panels, identically -- AS carries 186 of 225 added, 133 of 138 dropped and 48 of 128
--     downgauged below 30. Under different per-category floors that encoding would be reachable
--     in one panel only, and a VISUAL difference would read as a DATA difference.
--
-- ============================================================================================
-- WHAT THE THREE CATEGORIES DO AND DO NOT CLAIM
-- ============================================================================================
--
-- Measured on the 2026-05 warehouse (t12 = 2025-06..2026-05, p12 = 2024-06..2025-05), same-
-- airport pairs excluded. Anything #110 renders takes its figures from HERE, not from the issue
-- or the plan -- both stated numbers that describe a different population (see below).
--
-- 1. "ADDED" IS RE-ENTRY, NOT FIRST APPEARANCE. The filter is "did not fly it in the prior 12
--    months", and that is the whole of it; this query has no lookback beyond the p12 window.
--    4,690 of 8,357 (56.1%) added carrier-routes had already filed that pair BEFORE the prior
--    window -- AS ORD-SAN first filed 2019-08, AA FLL-LGA 2016-09. The #1 added row by seats,
--    AS HNL-ITO, genuinely is a first appearance (first filed 2026-01); most are not.
--
-- 2. "ADDED" SAYS NOTHING ABOUT ANY OTHER CARRIER. 4,608 of 8,357 (55.1%) had a DIFFERENT
--    carrier flying the same pair inside the prior window. "New service nobody flew last year"
--    is the exact sentence /watch/new-routes shipped wrong; do not write it here.
--
-- 3. "DROPPED" IS A DROPPED CARRIER-ROUTE, NOT A DROPPED ROUTE. A pair a carrier stops flying
--    while three others keep flying it has not died. 3,638 of 5,959 (61.1%) dropped carrier-
--    routes had a different carrier flying the pair inside the TRAILING window. The largest is
--    F9 DFW-IAH: F9 filed 168,946 seats in the prior window and none in the trailing one, while
--    10 OTHER carriers filed 1,704,401 seats on that pair in the trailing window -- 10.1x F9's
--    own prior 12.
--
-- 4. "DROPPED" IS ALSO NOT "GONE FOR GOOD". A 12-month absence is an absence from one window,
--    not an exit; the converse limitation of (1), and unfixable without a longer lookback than
--    this query computes.
--
-- 5. "DOWNGAUGED" IS gauge_t12 < gauge_p12 ON A ROUTE FLOWN IN BOTH WINDOWS, with no magnitude
--    threshold -- a one-seat fall qualifies. Gauge is SUM(seats) / SUM(departures_performed) per
--    window, a ratio of sums, never an average of monthly ratios (CLAUDE.md's #1 homemade-tool
--    bug). Both denominators are >= 1 by the floor, so neither ratio can divide by zero.
--
-- The three are MUTUALLY EXCLUSIVE STRUCTURALLY, not by agreement between three filters: one
-- CASE over one row per triple, whose arms are the disjoint truth-table cells (T,F), (F,T) and
-- (T,T). A row cannot reach two of them. Measured: 0 triples assigned more than one category.
-- They do not PARTITION the space -- a route flown in both windows whose gauge rose or held is
-- in none of the three, and that is correct: it is not a change this map draws.
--
-- ============================================================================================
-- SAME-AIRPORT PAIRS, AND WHY THE PUBLISHED PER-CARRIER FIGURES DISAGREE WITH THIS FILE'S
-- ============================================================================================
--
-- route_key_low <> route_key_high is applied in the aggregation. A same-airport filing cannot be
-- an arc -- the renderer drops from.code === to.code -- so counting one would inflate
-- totalRoutes and make the "N of M" disclosure line state a number no panel could ever draw.
-- 500 such triples exist in this span.
--
-- Issue #109 and the wave-1 plan both quote per-carrier figures that INCLUDE them, and #109's
-- table additionally has the dropped and added labels SWAPPED. The figures this file produces,
-- which are the ones any page copy must use:
--
--        dropped   added   downgauged
--   AS       138     225          128
--   DL       573     780          512
--   OO     1,026   1,624          584        (the plan's 1,042 / 1,651 include same-airport pairs)
--
-- ============================================================================================
-- THE CAP, AND WHY THE ORDER BY HAS A TIEBREAK
-- ============================================================================================
--
-- $cap is NETWORK_ARC_CAP (app/src/lib/map/segmentMap.ts) -- one cap across all three maps in
-- epic #5, never a per-map number. 14 of the 162 non-empty (carrier, category) panels exceed it;
-- the worst is OO added at 1,624, and the median panel is 24.5 routes.
--
-- category_total is count(*) OVER (PARTITION BY category), computed BEFORE the QUALIFY filters,
-- so it is the TRUE pre-cap count and cannot be the capped one. Returning the capped count is
-- the mutant #105 exists to kill; here it is not merely tested against, it is unwritable.
--
-- The ORDER BY carries route_key_low, route_key_high after seats DESC because EVERY ONE of those
-- 14 over-cap panels has a seats tie sitting exactly on the cut. Worst: MQ added, where 317
-- routes tie at exactly 76.0 seats at row 400; WN added 237 tied at 175.0; OO dropped 225 tied
-- at 76.0. Without the tiebreak, WHICH of those 317 routes get drawn is SQL-unspecified and can
-- move between DuckDB versions or between two runs of the same build. The triple is unique
-- within a (carrier, category), so this is a total order.
WITH bounds AS (
    SELECT max(strptime(year_month, '%Y-%m')) AS end_m FROM fct_route_month
),
-- Byte-for-byte the window derivation in 200_mart_route_health.sql:19-27, and deliberately so:
-- two derivations of "the trailing 12" that are merely equivalent today diverge the first time
-- either is edited. NOT data_as_of.sql's max, which reads fct_segment_month -- fct_route_month
-- is a GROUP BY view over it with no WHERE, so the two are provably the same value, and this one
-- is the one the mart uses.
windows AS (
    SELECT
        strftime(end_m - INTERVAL 11 MONTH, '%Y-%m') AS t12_start_month,
        strftime(end_m,                     '%Y-%m') AS t12_end_month,
        strftime(end_m - INTERVAL 23 MONTH, '%Y-%m') AS p12_start_month,
        strftime(end_m - INTERVAL 12 MONTH, '%Y-%m') AS p12_end_month
    FROM bounds
),
-- UNDIRECTED, and filtered to one carrier in the scan rather than after it. fct_route_month's
-- grain is DIRECTED (year_month, op_airline_id, origin_airport_id, dest_airport_id), so grouping
-- on the endpoint ids instead of route_key_low/high would split every route flown both ways into
-- two rows and halve each half against the floor.
--
-- 'YYYY-MM' strings order and BETWEEN correctly, so no per-row date parsing is needed.
agg AS (
    SELECT
        r.route_key_low,
        r.route_key_high,
        w.*,

        count(DISTINCT r.year_month) FILTER (
            WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_months_present,
        sum(r.seats)                FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_seats,
        sum(r.passengers)           FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_passengers,
        sum(r.departures_performed) FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_departures_performed,

        count(DISTINCT r.year_month) FILTER (
            WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_months_present,
        sum(r.seats)                FILTER (WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_seats,
        sum(r.passengers)           FILTER (WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_passengers,
        sum(r.departures_performed) FILTER (WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_departures_performed
    FROM fct_route_month r
    CROSS JOIN windows w
    WHERE r.op_airline_id = $airline_id
      AND r.year_month BETWEEN w.p12_start_month AND w.t12_end_month
      AND r.route_key_low <> r.route_key_high
    GROUP BY r.route_key_low, r.route_key_high,
             w.t12_start_month, w.t12_end_month, w.p12_start_month, w.p12_end_month
),
-- The shared floor, stated once, read three times. See the header for why each arm exists.
flew AS (
    SELECT
        *,
        CASE WHEN t12_months_present = 0          THEN FALSE
             WHEN t12_departures_performed IS NULL THEN NULL
             ELSE t12_departures_performed >= 1 END AS flew_t12,
        CASE WHEN p12_months_present = 0          THEN FALSE
             WHEN p12_departures_performed IS NULL THEN NULL
             ELSE p12_departures_performed >= 1 END AS flew_p12
    FROM agg
),
categorized AS (
    SELECT
        *,
        CASE WHEN flew_t12 AND NOT flew_p12 THEN 'added'
             WHEN flew_p12 AND NOT flew_t12 THEN 'dropped'
             WHEN flew_t12 AND flew_p12
                  AND t12_seats / t12_departures_performed
                    < p12_seats / p12_departures_performed THEN 'downgauged'
        END AS category
    FROM flew
),
-- Each category's measures come from ITS OWN window. This CASE is the single place that mapping
-- is written; carrierDiff.ts reads window_start_month / window_end_month off the row rather than
-- deriving the window a second time from asOf.
panel AS (
    SELECT
        category,
        route_key_low,
        route_key_high,
        t12_end_month,
        CASE WHEN category = 'dropped' THEN p12_start_month ELSE t12_start_month END AS window_start_month,
        CASE WHEN category = 'dropped' THEN p12_end_month   ELSE t12_end_month   END AS window_end_month,
        CASE WHEN category = 'dropped' THEN p12_seats                ELSE t12_seats                END AS seats,
        CASE WHEN category = 'dropped' THEN p12_passengers           ELSE t12_passengers           END AS passengers,
        CASE WHEN category = 'dropped' THEN p12_departures_performed ELSE t12_departures_performed END AS departures
    FROM categorized
    WHERE category IS NOT NULL
)
-- LEFT JOIN, not INNER: an endpoint that fails to resolve returns NULL and carrierDiff.ts throws
-- naming the airport_id, the same fail-loud airportNetwork.ts's toArcDatum has. An inner join
-- would silently drop the arc and quietly disagree with category_total. `is_latest` is what makes
-- the join 1:1 -- dim_airport is keyed on airport_seq_id and 5,033 airport_ids carry more than
-- one seq row, so without it the join fans out and multiplies both the rows and the total
-- (map_airport_coords.sql documents the same hazard).
--
-- ::BIGINT after the aggregate for 200_mart_route_health.sql's reason: DuckDB promotes sum()
-- over a BIGINT column to HUGEINT, and this crosses into TypeScript through @duckdb/node-api.
SELECT
    p.category,
    p.window_start_month,
    p.window_end_month,
    p.t12_end_month AS dataset_end_month,
    p.route_key_low,
    p.route_key_high,
    lo.code AS from_code,
    lo.lat  AS from_lat,
    lo.lon  AS from_lon,
    hi.code AS to_code,
    hi.lat  AS to_lat,
    hi.lon  AS to_lon,
    p.seats::BIGINT      AS seats,
    p.departures::BIGINT AS departures,
    p.passengers / nullif(p.seats, 0) AS load_factor,
    count(*) OVER (PARTITION BY p.category)::BIGINT AS category_total
FROM panel p
LEFT JOIN dim_airport lo ON lo.airport_id = p.route_key_low  AND lo.is_latest
LEFT JOIN dim_airport hi ON hi.airport_id = p.route_key_high AND hi.is_latest
QUALIFY row_number() OVER (
    PARTITION BY p.category
    ORDER BY p.seats DESC, p.route_key_low, p.route_key_high) <= $cap
ORDER BY p.category, p.seats DESC, p.route_key_low, p.route_key_high
