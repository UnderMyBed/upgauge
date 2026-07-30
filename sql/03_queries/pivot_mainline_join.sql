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
--
-- KNOWN, UNDOCUMENTED-UNTIL-NOW SEMANTIC GAP: a filter on op_airline_id is NOT coalesced the
-- way the SELECT/GROUP BY dimension is under grouping == "mainline". pivot.py's _dim_render
-- rewrites op_airline_id's SELECT/GROUP BY to
-- `coalesce(m.parent_airline_id, f.op_airline_id)`, but the {{FILTERS}} token in
-- pivot_segment.sql / pivot_route.sql always renders `op_airline_id IN (...)` against the
-- RAW column on the fact table -- pivot.py's filter loop never looks at `grouping` at all.
-- So filtering a mainline-grouped pivot to a parent airline_id (e.g. Alaska, 19930) EXCLUDES
-- the rows contributed by its wholly-owned subsidiaries (Virgin America, Hawaiian), even
-- though those rows appear, correctly rolled up, in the unfiltered mainline row for 19930.
-- Measured on 2017-01: the mainline row for op_airline_id=19930 shows 3,842,350 seats;
-- the same query plus a filter of op_airline_id:19930 returns only 2,336,210 -- Horizon and
-- Virgin America are folded into the row but excluded by the filter. This breaks
-- CLAUDE.md's "every insight row is one click from the raw rows that produced it" for a
-- mainline-grouped row filtered back to itself.
--
-- Deliberately NOT changed here -- whether the filter should instead target the coalesced
-- expression is a product decision, not something to fix silently inside a doc-fix wave.
-- pipeline/tests/test_pivot_real_data.py has a golden-style regression test pinning this
-- CURRENT behaviour so a future change to it is a deliberate, observed decision rather than
-- an accidental one.
LEFT JOIN map_mainline_group m
       ON m.airline_id = f.op_airline_id
      AND f.year_month >= m.effective_from
      AND (m.effective_to IS NULL OR f.year_month < m.effective_to)
