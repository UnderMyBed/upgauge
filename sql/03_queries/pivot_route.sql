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
SELECT
    {{DIM_SELECT}},
    {{MEASURE_SELECT}},
    sum(quarantined_rows)                                        AS quarantined_rows
FROM fct_route_month AS f{{MAINLINE_JOIN}}
WHERE year_month BETWEEN $time_from AND $time_to
  AND ({{FILTERS}})
GROUP BY {{GROUP_BY}}
ORDER BY {{SORT}}
LIMIT $limit
