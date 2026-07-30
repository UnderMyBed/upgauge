-- The Explorer's dimension allowlist, as catalog rows.
--
-- Read by BOTH pipeline/pivot.py's load_allowlist() and the server's TypeScript. That is
-- the point: one definition, two runtimes, no chance of the validator's vocabulary drifting
-- between them. No parameters -- the whole allowlist is always loaded.
SELECT * FROM meta_pivot_dimensions
