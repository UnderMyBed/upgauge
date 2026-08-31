-- The Explorer's pivot over fct_route_month.
--
-- {{TOKENS}} are IDENTIFIERS, substituted only after allowlist validation against
-- meta_pivot_dimensions / meta_pivot_measures. $params are VALUES, always bound. Request
-- input never reaches a token slot un-validated. Same shape as M2's {{PARQUET_ROOT}}.
--
-- DIFFERENCE FROM pivot_segment.sql -- fct_route_month already carries a per-row
-- quarantined_rows COUNT (rolled up from fct_segment_month by sql/02_marts/100_fct_route_month.sql),
-- so this template SUMs that column rather than counting quarantined rows itself, and it does
-- NOT have a quarantine_reasons column at all: the reason string does not survive the rollup
-- from segment to route grain. A consumer of this template must not expect
-- quarantine_reasons to exist at route grain -- only at segment grain.
--
-- The mainline-join token (after FROM) renders to pivot_mainline_join.sql's contents when
-- PivotQuery.grouping == "mainline", else the empty string -- see that file for the join and
-- its boundary semantics. The fact table is aliased AS f so the join predicate is
-- unambiguous; when grouping == "mainline", op_airline_id's dimension expression becomes
-- coalesce(m.parent_airline_id, f.op_airline_id) instead of the catalog's bare column_expr.
--
-- `active_months` IS THE DEPARTURE FLOOR'S DENOMINATOR (#134), and it is a companion COUNT
-- like quarantined_rows, never a catalog measure -- so it can never be selected, sorted on,
-- or rendered as a column, and adding it to meta_pivot_measures would have required a
-- `make build` this change deliberately does not need.
--
-- The floor is MONTHLY -- 30 departures per month FLOWN, docs/design/system.md -- but every surface
-- that applies it queries a trailing-12 window, so comparing a twelve-month SUM against 30
-- made the rule ~12x too lenient: a route flying 2.5 departures a month cleared it. The
-- honest denominator is the months the group ACTUALLY FLEW, which is what this counts.
--
-- `departures_performed > 0`, not merely "a row exists": a month that filed a schedule and
-- performed nothing did not fly, and counting it would understate the rate. `NOT
-- is_quarantined` for the same reason every measure carries it -- numerator and denominator
-- must be drawn from the identical row set (CLAUDE.md's ratio-of-sums rule), or the floor
-- divides clean departures by a month count including months whose every filing was thrown
-- away. Correct at BOTH grains without a branch: fct_route_month exposes the structural
-- `FALSE AS is_quarantined` its sums already applied, and its `departures_performed` is the
-- rolled-up sum, NULL for a wholly-quarantined route-month -- so `> 0` is NULL there and the
-- month is excluded, which is the same verdict the segment grain reaches.
SELECT
    {{DIM_SELECT}},
    {{MEASURE_SELECT}},
    sum(quarantined_rows)                                        AS quarantined_rows,
    count(DISTINCT year_month) FILTER (
        WHERE NOT is_quarantined AND departures_performed > 0)   AS active_months
FROM fct_route_month AS f{{MAINLINE_JOIN}}
WHERE year_month BETWEEN $time_from AND $time_to
  AND ({{FILTERS}})
--
-- The ORDER BY repeats the grouping keys as a tiebreak. The sort token names ONE measure
-- column, so rows tying on it AT THE LIMIT BOUNDARY were returned in DuckDB's
-- aggregation-merge order -- a Top-N permalink could render a different row set across
-- redeploys with no data change (#136). The grouping key set is unique per output row by
-- definition of GROUP BY, so appending it makes the ordering total. It is a SUFFIX: the
-- requested sort still ranks, the tiebreak only decides who wins a tie.
--
-- It is a SEPARATE token from the grouping one, carrying the identical string, and that is
-- load-bearing. Python's str.replace substitutes EVERY occurrence; JavaScript's
-- String.replace with a string pattern substitutes only the FIRST. One token used twice
-- would render correctly in pipeline/pivot.py and leave a literal token in the SQL
-- app/src/lib/pivot/render.ts sends to DuckDB. Both files rely on every token appearing
-- exactly once -- which is also why no real token is spelled with its braces in these
-- comments.
GROUP BY {{GROUP_BY}}
ORDER BY {{SORT}}, {{TIEBREAK}}
LIMIT $limit
