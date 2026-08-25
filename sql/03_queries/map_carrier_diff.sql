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
-- EVERY FIGURE BELOW was measured on the 2026-05 warehouse over t12 = 2025-06..2026-05 and
-- p12 = 2024-06..2025-05, against THIS file's own category definitions, and counts ARCS ONLY
-- (same-airport pairs excluded -- see the section on them). Each figure states the predicate
-- that produced it precisely enough to re-derive; a figure whose definition is not stated is
-- one nobody can reconcile after the next BTS refresh.
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
-- mart would floor two panels of one small multiple differently by a factor of 14, and the
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
-- NULL is not TRUE, so no CASE arm below matches such a row and the exclusion needs no clause of
-- its own. 25 carrier-routes are excluded this way; they are COUNTED and returned, not silently
-- dropped -- see the quarantine section.
--
-- WHY 1 AND NOT 30 (the mart's floor, and arcs.ts:33's DEPARTURE_FLOOR). Measured, all carriers:
--
--            floor 1     floor 30
--   added      8,357          606
--   dropped    5,959          463
--   downgauged 5,012        2,972
--
-- At 30 the panel labelled "dropped" would draw 6 of Delta's 573 dropped carrier-routes and the
-- panel labelled "added" 16 of its 780. A map that renders 1% of the thing its label names is a
-- worse false claim than one that includes a route flown five times -- and a 30-floor guts the
-- two categories the map exists for while leaving the third mostly intact, breaking panel
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
-- FOR #110: arcs.ts:28-32 documents that encoding as "trailing-window departures". On the
-- DROPPED panel the departures are PRIOR-window ones. The encoding stays internally consistent
-- -- every arc in a panel is measured over that panel's own window -- but a caption saying
-- "trailing" would be false on one panel in three.
--
-- ============================================================================================
-- WHAT THE THREE CATEGORIES DO AND DO NOT CLAIM
-- ============================================================================================
--
-- Anything #110 renders takes its figures from HERE, not from issue #109 or the plan -- both
-- stated numbers that describe a different population.
--
-- 1. "ADDED" IS RE-ENTRY, NOT FIRST APPEARANCE. The filter is "did not fly it in the prior 12
--    months", and that is the whole of it; this query has no lookback beyond the p12 window.
--    4,691 of 8,357 (56.1%) added carrier-routes had already filed that pair before the prior
--    window. PREDICATE: EXISTS a fct_route_month row with the same op_airline_id, the same
--    (route_key_low, route_key_high), and year_month < p12_start_month. AS ORD-SAN first filed
--    2019-08, AA FLL-LGA 2016-09. The #1 added row by seats, AS HNL-ITO, genuinely is a first
--    appearance (first filed 2026-01); most are not.
--
-- 2. "ADDED" SAYS NOTHING ABOUT ANY OTHER CARRIER. 4,608 of 8,357 (55.1%) had a DIFFERENT
--    carrier flying the same pair inside the prior window. PREDICATE: EXISTS a fct_route_month
--    row with a different op_airline_id, the same pair, and year_month BETWEEN p12_start_month
--    AND p12_end_month -- FILED AT ALL, with no departures floor applied to the other carrier.
--    "New service nobody flew last year" is the exact sentence /watch/new-routes shipped wrong;
--    do not write it here.
--
-- 3. "DROPPED" IS A DROPPED CARRIER-ROUTE, NOT A DROPPED ROUTE. A pair a carrier stops flying
--    while three others keep flying it has not died. 3,640 of 5,959 (61.1%) dropped carrier-
--    routes had a different carrier flying the pair inside the TRAILING window -- same predicate
--    as (2), with the trailing window substituted. The largest is F9 DFW-IAH: F9 filed 168,946
--    seats in the prior window and none in the trailing one, while 10 OTHER carriers filed
--    1,704,401 seats on that pair in the trailing window, 10.1x F9's own prior 12.
--
-- 4. "DROPPED" IS ALSO NOT "GONE FOR GOOD". A 12-month absence is an absence from one window,
--    not an exit; the converse limitation of (1), and unfixable without a longer lookback than
--    this query computes.
--
-- 5. "DOWNGAUGED" IS A FALL OF ANY SIZE, AND THE TAIL IS MOSTLY TINY. The test is
--    gauge_t12 < gauge_p12 on a route flown in both windows, with no magnitude threshold, so a
--    one-seat fall qualifies and so does a hundredth of a seat. Measured over the 5,012:
--
--      313 (6.2%)   fall by less than 0.1 seats per departure
--    1,439 (28.7%)  by less than 1
--    3,233 (64.5%)  by less than 5
--    median 2.83, max 86.25
--
--    So "downgauged" is TRUE of a route and can mean nothing about it. AS SEA-SFO is a
--    929,745-seat arc that fell 1.42 seats per departure; AS SEA-SJC is 642,685 seats and fell
--    0.393. Copy that presents membership in this panel as a finding, rather than as a
--    direction of travel, overstates two thirds of it.
--
--    Gauge is SUM(seats) / SUM(departures_performed) per window -- a RATIO OF SUMS, never an
--    average of monthly ratios (CLAUDE.md's #1 homemade-tool bug). This is not a decorative
--    distinction: averaging the monthly ratios instead yields 5,030 downgauged carrier-routes
--    rather than 5,012, and moves the count for 32 carriers. Both denominators are >= 1 by the
--    floor, so neither ratio can divide by zero.
--
-- The three are MUTUALLY EXCLUSIVE STRUCTURALLY, not by agreement between three filters: one
-- CASE over one row per triple, whose arms are the disjoint truth-table cells (T,F), (F,T) and
-- (T,T). A row cannot reach two of them. They do not PARTITION the space -- a route flown in
-- both windows whose gauge rose or held is in none of the three, and that is correct: it is not
-- a change this map draws.
--
-- ============================================================================================
-- THE RANKING KEY IS PER CATEGORY, BECAUSE THE CAP MUST CUT ON WHAT THE LABEL CLAIMS
-- ============================================================================================
--
-- $cap is NETWORK_ARC_CAP (app/src/lib/map/segmentMap.ts) -- one cap across all three maps in
-- epic #5. 14 of the 162 non-empty (carrier, category) panels exceed it; the worst is OO added
-- at 1,624, and the median panel is 24.5 routes.
--
-- For ADDED and DROPPED the claim's magnitude IS seats, so seats ranks them. For DOWNGAUGED it
-- is NOT: the claim is a fall in gauge, and seats is orthogonal to it. Ranking the downgauged
-- panel by seats -- which this file did until it was measured -- inverts the panel. On OO, the
-- only carrier whose downgauged panel is cut:
--
--                          median fall   max fall
--   drawn (top 400 by seats)      1.50      25.45
--   cut   (ranks 401+)            7.50      26.00
--
-- The panel drew the SMALLEST downgauges and cut the largest, the median discarded fall being
-- five times the median drawn one, with the biggest fall in the whole set discarded -- under a
-- disclosure reading "400 of 584", which any reader takes to mean the biggest 400. arcs.ts
-- encodes seats as stroke width, so the visually dominant arcs were the least downgauged ones.
-- That is /watch/new-routes' failure shape exactly: a label true row by row while the rendering
-- encodes something else.
--
-- So `rank_key` is per category, and its UNIT DIFFERS BY CATEGORY -- seats for added and
-- dropped, seats-per-departure for downgauged. That is safe only because every use of it is
-- PARTITIONED BY category, so two categories' keys are never compared; it is a ranking key and
-- is deliberately not emitted as a measure. The precedent is this repo's own existing view of
-- the same phenomenon: watch_gauge.sql ranks ORDER BY gauge_delta, never on seats.
--
-- "Seats removed" (fall x departures) was the other candidate, and it is DISQUALIFIED BY
-- MEASUREMENT rather than by argument -- it does not actually fix the inversion. Same panel,
-- the three candidate keys, median gauge fall among the routes drawn vs the routes cut:
--
--                       med drawn   med cut   largest fall cut
--   fall                     5.00      0.39               1.12
--   seats removed            2.44      3.06              23.00
--   seats (the old key)      1.50      7.50              26.00
--
-- Seats-removed still discards a larger median fall than it draws, and still throws away a
-- 23-seat downgauge. Only ranking on the fall itself makes the disclosure true. It is also the
-- key that avoids smuggling frequency into a gauge claim: capacity is frequency plus gauge in
-- log space (docs/data/model.md verifies the identity to 2.66e-15), which is why health_score
-- excludes capacity_delta from its composite.
--
-- THE COST, stated because it is real: ranking on fall lets a thinly flown route lead the panel.
-- OO's top downgauged arc is ACV-FAT at ONE performed departure, and 230 of its 400 drawn arcs
-- are below 30 departures, against 74 under the old seats key. arcs.ts draws every one of those
-- dotted and muted -- "barely flown" is already an encoding on this map -- so the fragility is
-- disclosed on the arc rather than hidden by it. A departures floor high enough to suppress them
-- would be a SECOND floor applying to one category, which is the incomparability this file's
-- whole shape exists to prevent.
--
-- FOR #110: the downgauged panel's disclosure must say what it ranks on. "400 of 584" alone
-- reads as the largest 400 routes; the honest form names the key -- the 400 largest gauge falls.
--
-- THE TIEBREAK. The ranking ORDER BY carries route_key_low, route_key_high after rank_key
-- because 10 of the 14 over-cap panels have a tie sitting exactly on the cut -- every added and
-- dropped one. Worst: MQ added, where 317 routes tie at exactly 76 seats spanning row 400; WN
-- added 237 tied at 175; OO dropped 225 tied at 76. Without the tiebreak, WHICH of those 317 are
-- drawn is SQL-unspecified and moves between runs. The four downgauged panels do NOT tie at the
-- cut -- gauge fall is continuous where seats are integral -- but they carry the same tiebreak,
-- because "no tie today" is a property of this month's data, not of the query. The triple is
-- unique within a (carrier, category), so this is a total order.
--
-- category_total is count(*) OVER (PARTITION BY category), computed BEFORE the QUALIFY filters,
-- so it is the TRUE pre-cap count and cannot be the capped one. Returning the capped count is
-- the mutant #105 exists to kill; here it is unwritable.
--
-- ============================================================================================
-- SAME-AIRPORT PAIRS ARE EXCLUDED FROM THE ARCS AND DISCLOSED IN SEATS
-- ============================================================================================
--
-- A same-airport filing cannot be an arc -- its great circle has zero angular length, and the
-- renderer drops from.code === to.code -- so counting one in category_total would make the
-- "N of M" disclosure state a number no panel could ever draw. They are therefore out of
-- `arcs` and out of category_total, and their SEATS are returned separately, per category, so
-- they surface rather than vanish (SegmentMapInput.sameAirportSeats; #104 owns that field's
-- contract and states that such a pair is counted in neither totalRoutes nor the renderer's own
-- derived drawn count).
--
-- Measured: 500 same-airport triples in the span, 308 of them categorizable -- 84 added
-- (8,180 seats), 145 downgauged (304,457) and 79 dropped (9,251), 321,888 seats across 32
-- carriers. OO alone accounts for 111 of the downgauged ones.
--
-- KNOWN GAP, stated rather than papered over: for 5 (carrier, category) pairs the ONLY member is
-- a same-airport pair. There are no arcs, so no panel is emitted, so those seats reach no map
-- face at all. Emitting an arc-less panel to carry them would be a worse trade -- it would put
-- an empty map on the page - and the alternative is a page-level disclosure that is #110's to
-- make, not this query's.
--
-- Issue #109 and the wave-1 plan both quote per-carrier figures that INCLUDE same-airport pairs.
-- The figures this file produces, which are the ones page copy must use:
--
--        dropped   added   downgauged
--   AS       138     225          128
--   DL       573     780          512
--   OO     1,026   1,624          584        (the plan's 1,042 / 1,651 include same-airport pairs)
--
-- ============================================================================================
-- QUARANTINE: TWO DIFFERENT QUANTITIES, AND ONLY ONE OF THEM IS A FIELD
-- ============================================================================================
--
-- `undrawable_routes` counts carrier-routes this query could not categorize AT ALL because a
-- window was WHOLLY quarantined -- flew_t12 or flew_p12 is NULL. They are in no panel, in no
-- category_total, and without this count they would vanish with no trace that anything was
-- there. That is exactly SegmentMapInput.quarantinedRoutes' declared contract (#104 owns it:
-- "routes the producer could not draw because every filing behind them was quarantined").
-- Measured: 25 across all carriers, 16 of them 8V's.
--
-- SEPARATELY, and NOT this field: 87 of the drawn carrier-routes touch at least one quarantined
-- row in EITHER window without being wholly quarantined -- 75 of them downgauged, where a
-- partially quarantined window shifts the very gauge ratio that assigns the category. Those arcs
-- ARE drawn and ARE counted; their measures are computed from the non-quarantined remainder,
-- which is what CLAUDE.md's quarantine rule requires. Both windows are counted because both
-- participate in every category decision -- added and dropped each test one window for absence
-- and read the other for measures, and downgauged reads both.
--
-- Quarantine is a per-aggregate FILTER and never a WHERE (100_fct_route_month.sql:56-59): a
-- WHERE would make quarantined_rows always 0, which is the bug the FILTER form exists to
-- prevent.
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
-- Same-airport pairs are NOT filtered out here -- they are carried to the `same_airport` CTE and
-- dropped from `arcs`, so their seats can be disclosed rather than lost.
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
        END AS category,
        -- Ratio of sums on BOTH sides, subtracted. Positive means the average seats per
        -- departure FELL. NULL unless the route flew in both windows, which is exactly when the
        -- downgauged arm can match.
        CASE WHEN t12_departures_performed >= 1 AND p12_departures_performed >= 1
             THEN p12_seats / p12_departures_performed
                - t12_seats / t12_departures_performed END AS gauge_fall
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
        route_key_low = route_key_high AS is_same_airport,
        t12_end_month,
        CASE WHEN category = 'dropped' THEN p12_start_month ELSE t12_start_month END AS window_start_month,
        CASE WHEN category = 'dropped' THEN p12_end_month   ELSE t12_end_month   END AS window_end_month,
        CASE WHEN category = 'dropped' THEN p12_seats                ELSE t12_seats                END AS seats,
        CASE WHEN category = 'dropped' THEN p12_passengers           ELSE t12_passengers           END AS passengers,
        CASE WHEN category = 'dropped' THEN p12_departures_performed ELSE t12_departures_performed END AS departures,
        -- Per category, in the category's own unit. Never compared across categories -- every
        -- use is PARTITION BY category. See the header's ranking section.
        CASE WHEN category = 'downgauged' THEN gauge_fall
             WHEN category = 'dropped'    THEN p12_seats
             ELSE t12_seats END AS rank_key
    FROM categorized
    WHERE category IS NOT NULL
),
-- Seats on the pairs that cannot be arcs, per category, so they are disclosed rather than lost.
same_airport AS (
    SELECT category, sum(seats) AS same_airport_seats
    FROM panel
    WHERE is_same_airport
    GROUP BY category
),
-- Carrier-routes that reached no category because a window was wholly quarantined. A bare
-- aggregate with no GROUP BY, so this ALWAYS returns exactly one row -- the CROSS JOIN below
-- would annihilate the result set if it could return none.
undrawable AS (
    SELECT count(*) FILTER (
        WHERE (flew_t12 IS NULL OR flew_p12 IS NULL)
          AND route_key_low <> route_key_high)::BIGINT AS undrawable_routes
    FROM flew
),
arcs AS (
    SELECT * FROM panel WHERE NOT is_same_airport
)
-- LEFT JOIN dim_airport, not INNER: an endpoint that fails to resolve returns NULL and
-- carrierDiff.ts throws naming the airport_id, the same fail-loud airportNetwork.ts's toArcDatum
-- has. An inner join would silently drop the arc and quietly disagree with category_total.
-- `is_latest` is what makes the join 1:1 -- dim_airport is keyed on airport_seq_id and 5,033
-- airport_ids carry more than one seq row, so without it the join fans out and multiplies both
-- the rows and the total (map_airport_coords.sql documents the same hazard).
--
-- seats, passengers and departures_performed are DOUBLE at rest in fct_route_month
-- (db.ts:120-127 records this), so their sums are DOUBLE and reach TypeScript as ordinary
-- numbers. They are deliberately NOT cast to BIGINT: the cast would round, and it would put that
-- rounding between the ranking key and the emitted seats. Only the two COUNTS are cast, because
-- count() is BIGINT and arrives as a JS bigint that demoteBigInts must convert.
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
    p.seats,
    p.departures,
    p.passengers / nullif(p.seats, 0) AS load_factor,
    count(*) OVER (PARTITION BY p.category)::BIGINT AS category_total,
    s.same_airport_seats,
    u.undrawable_routes
FROM arcs p
LEFT JOIN same_airport s ON s.category = p.category
CROSS JOIN undrawable u
LEFT JOIN dim_airport lo ON lo.airport_id = p.route_key_low  AND lo.is_latest
LEFT JOIN dim_airport hi ON hi.airport_id = p.route_key_high AND hi.is_latest
QUALIFY row_number() OVER (
    PARTITION BY p.category
    ORDER BY p.rank_key DESC, p.route_key_low, p.route_key_high) <= $cap
ORDER BY p.category, p.rank_key DESC, p.route_key_low, p.route_key_high
