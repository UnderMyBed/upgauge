-- The Explorer's measure allowlist, as catalog rows. Companion to catalog_dimensions.sql;
-- see that file's header for why this is a file and not a string literal.
-- Named, not `SELECT *` -- see catalog_dimensions.sql for why the column order is a
-- contract between a positional reader (Python) and a named one (TypeScript).
SELECT key, label, is_additive, expr FROM meta_pivot_measures
