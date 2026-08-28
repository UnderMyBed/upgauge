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
-- shape. Measured over the 27,232 arc-forming carrier-route triples in the 24-month span: 92.7%
-- of added carrier-routes are ALSO invisible to the mart. (92.8% counting same-airport pairs in,
-- which is the convention docs/data/model.md states it in; this file counts arcs only.) Sourcing "dropped" here and "added" from the
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
-- falsifies it: 5 added and 3 dropped carrier-routes that filed in the deciding window and
-- performed zero departures there. (7 and 4 route-windows file with zero performed departures
-- altogether; most of those routes are excluded by something else first.)
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
--    IT HAS TWO CONSUMERS, and they fail differently. The category CASE decides MEMBERSHIP, and
--    averaging there moves the counts above. `gauge_fall` decides the downgauged panel's RANKING,
--    and averaging only THAT leaves every count identical while replacing routes in every
--    over-cap panel's drawn 400 -- 26 of OO's, 19 of WN's, 17 each of DL's and AA's, so 52/38/34/34
--    routes change places counting both directions. AA's first ten reorder. A test asserting
--    only counts cannot see the second one; carrierDiff.test.ts asserts AA's leading order for
--    exactly that reason.
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
-- panel by seats -- which this file did until it was measured -- inverts the panel. FOUR panels
-- exceed the cap, not one, and every one of them inverts. Median gauge fall among the routes a
-- SEATS ranking draws against the ones it cuts, and the largest fall it discards:
--
--          n    med drawn   med cut   largest fall cut
--   OO   584         1.50      7.50      26.00  (the largest in the set)
--   WN   535         3.01     16.00      38.00  (the largest in the set)
--   DL   512         6.48     23.42      86.25  (the largest in the set)
--   AA   442         6.00     29.30      65.00  (the largest in the set)
--
-- Each panel drew the SMALLEST downgauges and cut the largest, and in all four the biggest fall
-- in the whole set was discarded -- under a disclosure reading "400 of 584", which any reader
-- takes to mean the biggest 400. arcs.ts encodes seats as stroke width, so the visually dominant
-- arcs were the least downgauged ones. That is /watch/new-routes' failure shape exactly: a label
-- true row by row while the rendering encodes something else. DL, AA and WN are the three
-- highest-traffic carrier pages on the site.
--
-- So `rank_key` is per category, and its UNIT DIFFERS BY CATEGORY -- seats for added and
-- dropped, seats-per-departure for downgauged. That is safe only because every use of it is
-- PARTITIONED BY category, so two categories' keys are never compared; it is a ranking key and
-- is deliberately not emitted as a measure. The precedent is this repo's own existing view of
-- the same phenomenon: watch_gauge.sql ranks ORDER BY gauge_delta, never on seats.
--
-- THAT PRECEDENT IS ONLY HALF APPLICABLE, and the missing half matters. watch_gauge.sql ranks
-- over mart_route_health, whose population is ALREADY floored at t12_departures_performed >= 30 --
-- which is WHY nothing with one departure can lead /watch/gauge. This file floors at 1 for
-- cross-panel comparability, so it inherits the key WITHOUT the floor that made the key safe
-- there. The consequence is measured and stated below rather than assumed away.
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
-- WHAT FALL-RANKING FIXES, AND WHAT IT DOES NOT. It fixes the CUT: the drawn 400 really are the
-- 400 largest falls, which is what the disclosure claims. It does NOT make the panel READABLE,
-- and that is a live defect stated in the present tense because it is still there:
--
--        sub-30-dep    of which in    corr(seats, fall)
--        of the 400     the top 100   inside the drawn 400
--   OO          230              89                -0.29
--   WN          178              97                -0.39
--   DL          222              82                -0.32
--   AA          199              76                -0.37
--
-- Two mechanisms, and neither is reachable from this file. arcs.ts:82-83 gives EVERY
-- sub-30-departure arc the same fixed 1px dotted --ink-3 stroke, so 178-230 of each panel's 400
-- arcs are visually identical -- a reader cannot tell rank 1 from rank 400 in the very region the
-- disclosure points at, and 76-97 of each top 100 are in it. Meanwhile the one channel that DOES
-- vary, width, encodes seats, which correlates NEGATIVELY with the ranking key inside the drawn
-- set: the widest arcs are among the least downgauged.
--
-- Ranking on fall also lets a thinly flown route lead: DL's leader is BNA-JFK at TWO performed
-- departures and AA's is BOS-STL at one.
--
-- The volume term in the ORDER BY below does NOT address this and is not claimed to. Measured on
-- all four panels, it moves ZERO routes into or out of the drawn 400: it breaks exact ties only,
-- and no over-cap panel has one at its cut. (NOT because fall is continuous -- 125 of OO's 584
-- falls are whole numbers. The ties are at the panel MAXIMUM; see the tiebreak section.) What it
-- does fix is which of a tied set leads: OO's leader
-- moves from ACV-FAT (1 departure) to ATW-SBN (4), and WN's from BDL-STL (1) to JAN-MCI (2).
--
-- IT HELPS EXACTLY HALF THE AFFECTED PANELS, and nothing here should let a reader think
-- otherwise: DL and AA have UNIQUE maxima, so no tiebreak can reach them and their leaders remain
-- BNA-JFK at 2 performed departures and BOS-STL at 1. A thinly flown route still leads two of the
-- four cut panels, and that is the readability defect above, not something this term addresses.
--
-- Nothing stronger is available here without breaking a claim. Demoting the thin arcs in the
-- ranking would make "the 400 largest falls" FALSE; excluding them would be a SECOND floor on one
-- category, which is the incomparability this file's whole shape exists to prevent.
--
-- FOR #110, and this is the real fix: the panel cannot render the ordering it is cut by. Either
-- the caption says so, or arcs.ts needs a channel for fall. The disclosure must also name the key
-- -- "400 of 584" alone reads as the largest 400 ROUTES, not the largest 400 falls.
--
-- NO PANEL HAS A UNIQUE TOP DOWNGAUGED ROUTE, so nothing may write "the biggest downgauge is X":
-- 17 OO routes tie at the panel maximum of 26.0 seats per departure, and 13 WN routes at 38.0.
-- Which of them leads is decided by the tiebreak, not by the data.
--
-- THE VOLUME TERM, downgauged only. `rank_key DESC` alone leaves an exact tie in gauge fall to be
-- broken by airport id, which on OO and WN is a 17-way and a 13-way tie AT THE PANEL MAXIMUM --
-- so the arc a reader sees first was chosen alphabetically. Ordering the tied set by performed
-- departures picks the most-flown of them instead. The CASE evaluates to NULL for every row of a
-- non-downgauged partition, so those partitions compare equal on it and fall straight through to
-- the id tiebreak, unchanged.
--
-- IT IS CATEGORY-SCOPED AS DEFENCE, not because it changes a cut today -- and the difference is
-- worth stating, because the obvious justification is wrong. Applying it to all three categories
-- moves NO added or dropped panel's cut at all: every one of the 10 tie-at-cut blocks has a
-- SINGLE distinct departure count, so ordering the tied set by departures is a no-op there (MQ's
-- 317 routes tied at 76 seats all performed exactly 1 departure -- 76 seats is one flight of a
-- 76-seat aircraft, so equal seats forces equal departures at the cut). What it DOES move is 7
-- carriers' panel INTERIORS, where seats tie at a value two different frequencies can reach: in
-- 8V's dropped panel ANV-KYU and KGX-NUL both file 6 seats over 1 and 2 departures, and an
-- unscoped term would swap them. So the scope is kept for the same reason the id tiebreak is
-- kept -- "no reorder at the cut today" is a property of this month's data, not of the query --
-- and carrierDiff.test.ts pins that interior ordering, on 8V, so a whole-term un-scoping goes red.
-- That coverage claim is bounded on purpose: the term is written ONCE now (see `ranked` below),
-- so there is no second copy to edit independently -- which is what an earlier two-clause version
-- had, where un-scoping one copy was a semantic no-op no data-driven test could have caught.
--
-- THE TIEBREAK. The ranking ORDER BY carries route_key_low, route_key_high after rank_key
-- because 10 of the 14 over-cap panels have a tie sitting exactly on the cut -- every added and
-- dropped one. Worst: MQ added, where 317 routes tie at exactly 76 seats spanning row 400; WN
-- added 237 tied at 175; OO dropped 225 tied at 76. Without the tiebreak, WHICH of those 317 are
-- drawn is SQL-unspecified and moves between runs.
--
-- The four downgauged panels do not tie AT THE CUT, but not for the reason an earlier revision of
-- this comment gave: gauge fall is NOT free of round numbers -- 125 of OO's 584 falls are whole
-- numbers. Downgauged ties land at the panel MAXIMUM instead, where 12 carriers have a multi-way
-- tie and the worst is 17-way. That is what the volume term above addresses; the id terms remain
-- the final total order, because the triple is unique within a (carrier, category).
--
-- category_total is count(*) OVER (PARTITION BY category), computed in `ranked` over the full
-- partition BEFORE `rn <= $cap` filters it, so it is the TRUE pre-cap count and cannot be the
-- capped one. Returning the capped count is
-- the mutant #105 exists to kill. NOT "unwritable" -- an earlier revision said so and it was the
-- same over-claim this file exists to avoid: replacing `r.category_total` in the final SELECT with
-- `count(*) OVER (PARTITION BY r.category)` compiles and yields 400 of 400, because by then the
-- cap filter has already run. What is true is narrower and is the reason for the CTE: the count is
-- taken inside `ranked`, over the PRE-CUT partition, and carrierDiff.test.ts is what keeps it
-- there.
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
-- an empty map on the page. Unlike the quarantine count above, these seats are per CATEGORY, so
-- they have nowhere to go on a record that carries no panel for their category; this one stays a
-- disclosure for #110 to make from the carrier's own totals.
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
-- there. That is SegmentMapInput.quarantinedRoutes' PURPOSE, but NOT the letter of its current
-- doc, and the difference is not cosmetic because #104's renderer emits that doc's sentence into
-- a footer and an aria-label. It says "every filing behind them was quarantined". Measured over
-- these 25: ZERO have both windows quarantined. 14 are trailing-window-only and 11 prior-only,
-- and 7 performed real departures in the window that stayed clean -- 8V BTI-VEE has 8 clean
-- prior-window departures. 8V's own 16 split 10 trailing / 6 prior. The property they all share
-- is narrower and exact: the window that DECIDES the category was wholly quarantined, so no
-- category could be assigned. #105's 34 groups are all-quarantined and satisfy both readings;
-- these satisfy only the second, so the shared sentence has to be the second.
--
-- SEPARATELY, and NOT this field: 87 of the drawn carrier-routes touch at least one quarantined
-- row in EITHER window without being wholly quarantined -- 75 of them downgauged, where a
-- partially quarantined window shifts the very gauge ratio that assigns the category. Those arcs
-- ARE drawn and ARE counted; their measures are computed from the non-quarantined remainder,
-- which is what CLAUDE.md's quarantine rule requires. Both windows are counted because both
-- participate in every category decision -- added and dropped each test one window for absence
-- and read the other for measures, and downgauged reads both.
--
-- ONE CARRIER LOSES THIS COUNT ENTIRELY, and it is a live page, not a hypothetical.
-- undrawable_routes rides on arc rows, and carrierDiff.ts returns [] when there are none, so a
-- carrier with wholly-quarantined windows and NO categorized arc drops it on the floor -- the
-- exact "no trace" this count exists to prevent. Measured across all 114 carrier codes: exactly
-- one is in that state, F4 (21615, Air Flamenco), with 3 undrawable carrier-routes and 0 arcs.
--
-- #105 HAS THE SAME CASE AND SOLVES IT, and the reason that solution does not port is structural
-- rather than a difference of care. carrierTypeNetwork.ts refuses to return null when quarantine
-- alone empties a view -- "returning null there hides a data-quality fact behind a missing panel"
-- -- and emits a map with totalRoutes 0 carrying the count, which segmentMap.ts's totalRoutes doc
-- now blesses explicitly. That works because #105 renders ONE map per view, so a carrier-wide
-- count has somewhere to live. This query renders THREE panels, and an undrawable route has NO
-- CATEGORY by construction -- that is what being undrawable means here -- so there is no panel it
-- belongs to and inventing one would put an empty map face on the page under a category label
-- the data never supported.
--
-- SO IT IS HOISTED OFF THE PANELS ENTIRELY. fetchCarrierDiff returns
-- `{ panels, quarantinedRoutes }`, and the count rides on the record where a carrier-wide fact
-- belongs. That fixes both disclosed defects at once: F4 gets its count with no panel to hang it
-- on, and 8V stops stating the same 16 routes on three faces (a reader summing the small multiple
-- got 48). Each panel now passes 0 for SegmentMapInput's required field, which is true of it --
-- no route of THAT category went undrawn -- and renders no footer sentence, since
-- segmentMap.ts's quarantinedNote returns null at 0.
--
-- A THIRD GROUP REACHES NO COUNT AT ALL, and this section would read as exhaustive without it:
-- 2 carrier-routes are BOTH wholly quarantined AND same-airport. `undrawable_routes` carries
-- `route_key_low <> route_key_high`, so they are not an arc, not in category_total, not in
-- same_airport_seats and not in undrawable_routes either. They are the "vanish with no trace"
-- this field exists to prevent, at 2 instead of 25. Left that way deliberately: counting them in
-- undrawable_routes would state them on a map face as routes that could not be drawn, when the
-- reason they cannot be drawn is that they are not routes -- two different absences summed into
-- one number is what the same-airport split exists to avoid.
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
        -- t12_end_month is deliberately NOT carried out of this CTE, though the CASE below reads
        -- it from `categorized`. It was the column the pre-anchor query sourced dataset_end_month
        -- from, so leaving it on an arc row would make `a.dataset_end_month` -> `r.t12_end_month`
        -- a one-token edit that compiles and silently reverts the asOf guard to arc-conditional --
        -- i.e. skipped for the 48 of 114 carriers with no arc. Removing the column removes the
        -- re-source path.
        CASE WHEN category = 'dropped' THEN p12_start_month ELSE t12_start_month END AS window_start_month,
        CASE WHEN category = 'dropped' THEN p12_end_month   ELSE t12_end_month   END AS window_end_month,
        CASE WHEN category = 'dropped' THEN p12_seats                ELSE t12_seats                END AS seats,
        CASE WHEN category = 'dropped' THEN p12_passengers           ELSE t12_passengers           END AS passengers,
        CASE WHEN category = 'dropped' THEN p12_departures_performed ELSE t12_departures_performed END AS departures,
        -- Per category, in the category's own unit. Never compared across categories -- every
        -- use is PARTITION BY category. See the header's ranking section.
        CASE WHEN category = 'downgauged' THEN gauge_fall
             WHEN category = 'dropped'    THEN p12_seats
             ELSE t12_seats END AS rank_key,
        -- Carried through for the payload, NOT for ranking (rank_key above owns that). NULL on
        -- added and dropped by construction: neither has both windows.
        CASE WHEN category = 'downgauged' THEN gauge_fall END AS gauge_fall
    FROM categorized
    WHERE category IS NOT NULL
),
-- Seats on the pairs that cannot be arcs, per category, so they are disclosed rather than lost.
--
-- THE COUNT IS NOT REDUNDANT WITH THE SUM, and #121 is why. `panel.seats` comes from
-- fct_route_month, whose measures are `SUM(x) FILTER (WHERE NOT is_quarantined)` -- so
-- `sum(seats)` here returns NULL for a category whose same-airport pairs were ALL quarantined,
-- which is a different fact from the LEFT JOIN below missing because the category has no
-- same-airport pair at all. Both arrive at the consumer as a NULL column, and it read them as
-- one: `?? 0` said "no seats are being withheld" about a pair that IS being withheld by an
-- amount nobody can state.
--
-- LATENT, NOT LIVE. The wholly-quarantined same-airport pair is real (8V's VEE-VEE in the
-- trailing 12, airline 21745's STT-STT in the prior 12), but a panel folds every same-airport
-- pair in its category together and every such fold on this warehouse contains at least one
-- stateable pair -- measured across all 115 carriers, zero panels return NULL. No page renders
-- the wrong sentence today; the coercion is one refresh away from making it do so.
-- `100_fct_route_month.sql` states the rule this disambiguation serves, in its own comment:
-- "do NOT wrap these in COALESCE(..., 0)".
same_airport AS (
    SELECT category, count(*) AS same_airport_pairs, sum(seats) AS same_airport_seats
    FROM panel
    WHERE is_same_airport
    GROUP BY category
),
arcs AS (
    SELECT * FROM panel WHERE NOT is_same_airport
),
-- ONE window-function expression, computed ONCE, decides BOTH the cut (`rn <= $cap` below) and
-- the display order (`ORDER BY rn`). It is written this way because the alternative already cost
-- this unit a blocking round: the ranking key used to appear in a QUALIFY and again in a final
-- ORDER BY, and reverting only the QUALIFY reproduced the original defect -- a panel cut by seats
-- while displaying in fall order -- with every ordering test still green. Two clauses that must
-- agree can disagree; one expression cannot. The same shape defeated two mutant scripts of this
-- file, which edited one clause and not the other and so reported a passing gate.
--
-- Safe to compute before the dim_airport joins because those joins are provably 1:1 -- `is_latest`
-- makes airport_id unique (0 airport_ids carry more than one is_latest row), so no join below can
-- duplicate a row and change a count taken here.
ranked AS (
    SELECT
        *,
        row_number() OVER (
            PARTITION BY category
            ORDER BY rank_key DESC,
                     CASE WHEN category = 'downgauged' THEN departures END DESC,
                     route_key_low, route_key_high) AS rn,
        count(*) OVER (PARTITION BY category)::BIGINT AS category_total
    FROM arcs
),
-- EXACTLY ONE ROW, ALWAYS -- `windows` has one row and the scalar subquery is a bare aggregate.
-- That is what makes the two carrier-wide facts below reachable even when the carrier has no
-- drawable arc at all. F4 (21615) has 3 wholly-quarantined-window carrier-routes and zero arcs;
-- before this anchor existed the query returned no rows for it and the count was lost on the
-- floor -- the exact "no trace" it exists to prevent -- and there was nothing for a page-level
-- disclosure to be built FROM, so deferring it foreclosed the remedy in the one case that needed
-- it. `dataset_end_month` rides here for the same reason: read off an arc row it could only be
-- checked when arcs existed, which left the asOf guard silently inactive on 48 of the 114 carrier
-- codes.
anchor AS (
    SELECT
        w.t12_end_month AS dataset_end_month,
        (SELECT count(*) FILTER (
             WHERE (flew_t12 IS NULL OR flew_p12 IS NULL)
               AND route_key_low <> route_key_high)
         FROM flew)::BIGINT AS undrawable_routes
    FROM windows w
)
-- LEFT JOIN from the anchor, not FROM arcs: a carrier with no drawable arc still returns its one
-- anchor row, with every arc column NULL. carrierDiff.ts distinguishes the two cases on
-- `category IS NULL` -- which cannot collide with a data NULL, because `panel` already filtered
-- `category IS NOT NULL`.
--
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
    a.dataset_end_month,
    a.undrawable_routes,
    r.category,
    r.window_start_month,
    r.window_end_month,
    r.route_key_low,
    r.route_key_high,
    lo.code AS from_code,
    lo.lat  AS from_lat,
    lo.lon  AS from_lon,
    hi.code AS to_code,
    hi.lat  AS to_lat,
    hi.lon  AS to_lon,
    r.seats,
    r.departures,
    r.passengers / nullif(r.seats, 0) AS load_factor,
    r.gauge_fall,
    r.category_total,
    s.same_airport_pairs,
    s.same_airport_seats
FROM anchor a
LEFT JOIN ranked r        ON r.rn <= $cap
LEFT JOIN same_airport s  ON s.category = r.category
LEFT JOIN dim_airport lo  ON lo.airport_id = r.route_key_low  AND lo.is_latest
LEFT JOIN dim_airport hi  ON hi.airport_id = r.route_key_high AND hi.is_latest
ORDER BY r.category, r.rn
