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
SELECT d.key, d.label, d.column_expr, d.grain, d.join_dim, d.join_key,
       d.filter_only, d.filter_mode, c.data_type AS value_type
FROM meta_pivot_dimensions d
JOIN duckdb_columns() c
  ON c.table_name = 'fct_segment_month'
 AND c.column_name = trim(split_part(d.column_expr, ',', 1))
