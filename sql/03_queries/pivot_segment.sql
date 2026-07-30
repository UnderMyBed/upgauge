-- The Explorer's pivot over fct_segment_month.
--
-- {{TOKENS}} are IDENTIFIERS, substituted only after allowlist validation against
-- meta_pivot_dimensions / meta_pivot_measures. $params are VALUES, always bound. Request
-- input never reaches a token slot un-validated. Same shape as M2's {{PARQUET_ROOT}}.
--
-- Quarantined rows leave the measures but stay countable: dropping them silently hides the
-- dirt the UI is required to surface, and including them corrupts the aggregate. So every
-- measure is FILTERed per aggregate rather than in WHERE -- a WHERE filter would remove them
-- before count(*) FILTER could see them, making quarantined_rows always 0.
--
-- The mainline-join token (after FROM) renders to pivot_mainline_join.sql's contents when
-- PivotQuery.grouping == "mainline", else the empty string -- see that file for the join and
-- its boundary semantics. The fact table is aliased AS f so the join predicate is
-- unambiguous; when grouping == "mainline", op_airline_id's dimension expression becomes
-- coalesce(m.parent_airline_id, f.op_airline_id) instead of the catalog's bare column_expr.
SELECT
    {{DIM_SELECT}},
    {{MEASURE_SELECT}},
    count(*) FILTER (WHERE is_quarantined)                       AS quarantined_rows,
    string_agg(DISTINCT quarantine_reason, ',')
        FILTER (WHERE is_quarantined)                            AS quarantine_reasons
FROM fct_segment_month AS f{{MAINLINE_JOIN}}
WHERE year_month BETWEEN $time_from AND $time_to
  AND ({{FILTERS}})
GROUP BY {{GROUP_BY}}
ORDER BY {{SORT}}
LIMIT $limit
