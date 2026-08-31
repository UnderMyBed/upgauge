-- The Explorer's dimension allowlist, as catalog rows.
--
-- Read by BOTH pipeline/pivot.py's load_allowlist() and the server's TypeScript. That is
-- the point: one definition, two runtimes, no chance of the validator's vocabulary drifting
-- between them. No parameters -- the whole allowlist is always loaded.
-- Columns are named, never `SELECT *`. pipeline/pivot.py consumes these rows POSITIONALLY
-- (zip(("key","label",...), r, strict=True)) while app/src/lib/db.ts consumes them BY NAME.
-- Under `SELECT *` those two disagree the moment the view's column order changes: Python
-- would silently mislabel every field while TS stayed correct, and a rename would give TS
-- `String(undefined) === "undefined"` for column_expr -- a query-time SQL error rather than a
-- clear one. Naming them here makes this file the contract both readers actually share.
--
-- `value_type` is INTROSPECTED HERE, not stored on the view, and the distinction is a
-- deployment fact rather than a style choice. A column added to meta_pivot_dimensions exists
-- only in a warehouse asset REBUILT after that change -- but the asset is published only when
-- BTS advances a month (warehouse.yml's guard), and the container copies a prebuilt one
-- (Dockerfile, WAREHOUSE_TAG). So a view-side column makes new app code unrunnable against
-- every already-published asset: measured, `Binder Error: Referenced column "value_type" not
-- found in FROM clause!` from CI against warehouse-2026.05. Computing it in the QUERY makes the
-- schema part of the code, which is what it is. duckdb_columns() reflects whatever fct tables
-- the asset actually carries, so this resolves against any of them.
--
-- Resolved against fct_segment_month, which carries every offered column (the five
-- segment-only dimensions exist nowhere else, and every 'both' dimension is propagated to
-- fct_route_month by 100_fct_route_month.sql, which preserves type). Tests assert both grains
-- agree and that every column of a multi-column column_expr shares one type.
--
-- INNER JOIN on purpose: a renamed fact column drops the dimension row entirely, and the
-- allowlist count tests fail loudly rather than the bound going quietly missing.
--
-- ROW ORDER IS LOAD-BEARING, and guaranteeing it is this query's job rather than the planner's.
-- loadAllowlist() (app/src/lib/db.ts) builds its Map in row order, and two things read that
-- order: every chip row in app/src/components/builder/ renders the vocabulary in it, and
-- groupableDimensions(a, grain)[0] (app/src/lib/pivot/builder.ts) is the dimension a grain switch
-- LANDS ON when nothing in the current selection survives. With no ORDER BY those are whatever
-- the join emits -- measured, this query over a source view whose rows arrive in a different
-- physical order returns year_month, year, route, quarter, ...: neither the curated order nor a
-- reversal of it, so the order was never a property of the query at all.
--
-- The order is CURATED, and sql/02_marts/300_meta_pivot_dimensions.sql's VALUES text order is
-- where it is authored: `year` before `op_airline_id` is a product decision, not an accident, so
-- `ORDER BY d.key` is the wrong fix -- it replaces a product decision with the alphabet. The
-- ordinal below restates that sequence, and pipeline/tests/test_pivot_allowlist.py binds the two
-- file texts against each other so the restatement cannot drift from what it restates.
--
-- The ordinal is computed HERE rather than stored on the view for the same deployment reason
-- `value_type` is: measured, `ORDER BY d.sort_order` against a warehouse asset built before that
-- column existed raises `Binder Error: Values list "d" does not have a column named
-- "sort_order"`. CI restores a prebuilt asset and the container copies one (Dockerfile takes sql/
-- from the code and upgauge.duckdb from the release), so a view-side ordinal is unrunnable
-- against every asset already published.
--
-- INNER JOIN, and the asymmetry against the compact alternative IS the argument: a dimension
-- added to the view and forgotten here DROPS OUT, and the allowlist count tests fail loudly.
-- `list_position` would fit on one line and is the wrong shape -- it returns NULL for a key it
-- cannot find, NULL sorts LAST under DuckDB's default, and the forgotten dimension would ship
-- silently at the end of every chip row instead of failing.
SELECT d.key, d.label, d.column_expr, d.grain, d.join_dim, d.join_key,
       d.filter_only, d.filter_mode, c.data_type AS value_type
FROM meta_pivot_dimensions d
JOIN duckdb_columns() c
  ON c.table_name = 'fct_segment_month'
 AND c.column_name = trim(split_part(d.column_expr, ',', 1))
JOIN (VALUES
    ('year_month',             1),
    ('quarter',                2),
    ('year',                   3),
    ('op_airline_id',          4),
    ('origin_airport_id',      5),
    ('dest_airport_id',        6),
    ('route',                  7),
    ('endpoint_airport_id',    8),
    ('origin_city_market_id',  9),
    ('dest_city_market_id',   10),
    ('origin_state',          11),
    ('dest_state',            12),
    ('aircraft_type',         13),
    ('aircraft_group',        14),
    ('distance_group',        15)
) AS o(key, sort_order) ON o.key = d.key
ORDER BY o.sort_order
