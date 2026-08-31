-- Gauge Watch. Upgauging and downgauging are the SAME query, sorted oppositely -- the two
-- tables app/src/lib/watch.ts's Gauge Watch preset renders.
--
-- {{DIRECTION}} is a token, substituted in watch.ts's runPreset() from a closed set (only the
-- literals "ASC"/"DESC", chosen by looking up the requested direction in the preset's OWN
-- `directions` registry entry) -- never a caller-supplied string concatenated straight into
-- ORDER BY. This is the one preset whose direction varies; the other three watch_*.sql files
-- hardcode their ORDER BY because each of them only ever renders one table.
--
-- gauge_delta IS NOT NULL excludes the 297 carrier-route pairs with no prior-window data
-- (p12_months_present = 0, measured: gauge_delta IS NULL count matches it exactly). That is a
-- SINGLE cause, not health_score's three-reason union (373 -- docs/product/features.md) --
-- gauge_delta only depends on gauge_t12/gauge_p12, and gauge_t12 is never NULL for any row
-- that reaches mart_route_health at all (the rate floor in 200_mart_route_health.sql's
-- `derived` CTE admits only pairs performing >= 30 departures per month flown, so
-- t12_departures_performed is always >= 30 there). A pair with no gauge_delta has nothing for
-- either table to lead with.
SELECT
    op_airline_id,
    route_key_low,
    route_key_high,
    lf_t12, lf_delta, gauge_t12, gauge_delta,
    capacity_delta, frequency_delta, completion_factor,
    t12_seats, t12_departures_performed, t12_months_flown, t12_quarantined_rows,
    health_score
FROM mart_route_health
WHERE route_key_low <> route_key_high
  AND gauge_delta IS NOT NULL
--
-- The ORDER BY carries mart_route_health's whole grain as a tiebreak. gauge_delta alone is ONE
-- column, so rows tying on it AT THE LIMIT BOUNDARY are returned in DuckDB's merge order rather
-- than by the query -- the same class of gap #136 closed for the pivot templates. The grain,
-- (op_airline_id, route_key_low, route_key_high), is 200_mart_route_health.sql's own GROUP BY
-- and is unique per row of that table (5,611 rows, 5,611 distinct triples, no NULL in any of the
-- three); these presets neither join nor aggregate, so one output row is one mart row and
-- appending the triple makes the ordering total. It is a SUFFIX -- gauge_delta still ranks.
--
-- ALL THREE COLUMNS, never the route pair alone, and here that is measured rather than argued:
-- gauge_delta = 0.0 is a SINGLE tie run of 546 rows spanning 27 carriers and 515 distinct route
-- pairs, inside which 31 pairs are flown by more than one carrier. A route-only tiebreak leaves
-- those 31 pairs' rows in merge order -- still nondeterministic, and green against any fixture
-- keyed on route alone. The grain is a carrier-route PAIR, never a route.
--
-- The tiebreak is written LITERALLY rather than as a second substituted token, and that is the
-- point. The pivot templates need a token because their GROUP BY varies per query; this grain is
-- fixed, so a constant string does the whole job and there is no second substitution site for
-- Python's replace-EVERY-occurrence to diverge from JavaScript's replace-only-the-FIRST. This
-- file still carries exactly one direction token outside its comments, which is what
-- substituteDirection() (app/src/lib/watch.ts) requires of it.
--
-- ASCENDING in BOTH directions: this is an identity key, not a ranking. Making it follow the
-- direction token would create precisely the second substitution site the paragraph above
-- exists to avoid, and ascending is the order 200_mart_route_health.sql stores its rows in.
--
-- Ties are real in this data, not hypothetical: 3 tie runs covering 550 of the 5,308
-- qualifying rows.
ORDER BY gauge_delta {{DIRECTION}}, op_airline_id, route_key_low, route_key_high
LIMIT $limit
