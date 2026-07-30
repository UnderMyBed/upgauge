-- Substituted into the {{MAINLINE_JOIN}} token in pivot_segment.sql / pivot_route.sql when
-- PivotQuery.grouping == "mainline" (empty string when grouping == "operating"). No request
-- input reaches this file -- pivot.py only chooses whether to include it verbatim, so it is
-- query logic living in SQL, not a string built in Python.
--
-- effective_from/effective_to are VARCHAR 'YYYY-MM', compared lexically against year_month
-- directly -- no date parsing needed at that granularity. effective_to is EXCLUSIVE: a
-- carrier whose thru-month is '2018-04' has already stopped rolling up BY 2018-04, not
-- after it. See docs/data/carrier-model.md for the boundary evidence (Virgin America,
-- Hawaiian) and pipeline/tests/test_pivot_real_data.py for the mutation-tested proof.
--
-- The fact table must be aliased AS f by the including template, both so this predicate is
-- unambiguous and so a second `is_quarantined`-named column could never silently shadow the
-- one every measure's FILTER depends on (map_mainline_group has no such column, but the
-- alias makes that a structural fact of the join, not a coincidence of today's schema).
LEFT JOIN map_mainline_group m
       ON m.airline_id = f.op_airline_id
      AND f.year_month >= m.effective_from
      AND (m.effective_to IS NULL OR f.year_month < m.effective_to)
