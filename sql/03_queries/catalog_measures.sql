-- The Explorer's measure allowlist, as catalog rows. Companion to catalog_dimensions.sql;
-- see that file's header for why this is a file and not a string literal.
-- Named, not `SELECT *` -- see catalog_dimensions.sql for why the column order is a
-- contract between a positional reader (Python) and a named one (TypeScript).
--
-- ROW ORDER IS LOAD-BEARING for the same reason and by the same route: MeasureChips
-- (app/src/components/builder/MeasureChips.tsx) renders `[...allowlist.meas.values()]`, so the
-- measure chip row IS this query's row order. A bare scan of a VALUES-backed view does not
-- guarantee one -- measured, this query over a source view whose rows arrive in a different
-- physical order returns seats, rpm, passengers, mail, ...
--
-- The order is curated in sql/02_marts/301_meta_pivot_measures.sql's VALUES text -- additive
-- measures first, derived after, each group in reading order -- so `ORDER BY key` is wrong here
-- too. The ordinal below restates that sequence and pipeline/tests/test_pivot_allowlist.py binds
-- the two file texts. INNER JOIN and a query-side ordinal, both for the reasons
-- catalog_dimensions.sql states in full: a measure added to the view and forgotten here drops out
-- loudly, and an ordinal stored on the view would not bind against an already-published warehouse
-- asset.
SELECT m.key, m.label, m.is_additive, m.expr
FROM meta_pivot_measures m
JOIN (VALUES
    ('departures_scheduled',  1),
    ('departures_performed',  2),
    ('seats',                 3),
    ('passengers',            4),
    ('freight',               5),
    ('mail',                  6),
    ('air_time',              7),
    ('load_factor',           8),
    ('avg_gauge',             9),
    ('completion_factor',    10),
    ('asm',                  11),
    ('rpm',                  12)
) AS o(key, sort_order) ON o.key = m.key
ORDER BY o.sort_order
