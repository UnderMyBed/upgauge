-- The healthcheck's manifest AND its query, in one file because they are one fact.
--
-- Columns are in scope, not just objects. `isDataLayerHealthy()` (proxy.ts) probes
-- loadAllowlist() alone and therefore cannot see two of the three data-layer failures this
-- project has actually shipped: mart_route_health missing entirely (M6 Task 8), and
-- dim_airport present but without lat/lon (M7 Task 10). An object-existence check catches the
-- first of those and misses the second, which is why the manifest is (object, column) pairs.
--
-- `object_columns` distinguishes "the object is gone" from "the object is there and one column
-- is missing" -- 0 means the object has no columns at all in the catalog, i.e. it does not
-- exist. health.ts collapses the rows on that.
--
-- The OBJECT half of this list is not left to memory: health.test.ts's drift test strips comments
-- from every sql/03_queries/*.sql, extracts FROM/JOIN identifiers, subtracts CTE names, and
-- fails if any referenced object is absent below.
--
-- THE COLUMN HALF IS LEFT TO MEMORY, and that is a known limitation of this gate, not a property
-- of it. Proven by mutant: a query added with `SELECT elevation_ft_not_declared FROM dim_airport`
-- leaves all 18 of health.test.ts's tests GREEN (measured 2026-08-09), while the same file with an
-- undeclared OBJECT (`FROM dim_airport_not_declared`) correctly reddens the drift test.
-- So a served query can read a column this manifest never checks, and the healthcheck will report
-- ok against a database missing it -- exactly the M7 Task 10 break (dim_airport without lat/lon)
-- that the column half exists to catch, one column over. Adding a column here when a query starts
-- reading it is a manual step; nothing enforces it.
-- Why the parser was not extended: referencedObjects() classifies a FROM/JOIN identifier, and
-- refuses anything it cannot classify. Collecting `alias.column` would additionally require
-- resolving aliases to relations, then reading columns out of SELECT lists, CASE arms, window
-- clauses and function arguments across this corpus -- with bare (unqualified) column references
-- unattributable to a relation at all without a real binder. A parser that half-does that would
-- under-collect silently, which is the failure shape referencedObjects() throws to avoid.
--
-- COUPLED TO A GATE ASSERTION, and the gate is not `make check`. duckdb_columns() answers out of
-- the catalog and never opens a Parquet file, so this manifest is BLIND to a present catalog whose
-- data is gone: it returns zero rows, and /api/health degrades on `asOf` alone. `make portability`
-- negative 1 asserts that blindness verbatim (`"missing":[]`) to pin which clause is load-bearing.
-- Strengthening this query to probe an actual row is an IMPROVEMENT -- and it will turn that
-- assertion red. Update sql, docs/architecture/hosting.md § "The test itself" and the Makefile
-- assertion in the SAME commit, and run `make portability`; neither `make check` nor
-- `make app-check` will tell you.
WITH required(object_name, column_name) AS (
    VALUES
        ('dim_aircraft_type',      'code'),
        ('dim_aircraft_type',      'name'),
        ('dim_airport',            'airport_id'),
        ('dim_airport',            'code'),
        -- lat/lon are the M7 Task 10 fixture: present object, absent columns.
        ('dim_airport',            'lat'),
        ('dim_airport',            'lon'),
        -- is_latest is what makes an airport_id join 1:1. 5,033 airport_ids carry more than one
        -- airport_seq_id row, so a join that loses this column does not fail -- it FANS OUT, and
        -- map_carrier_diff.sql's per-category count(*) OVER would silently multiply with it.
        ('dim_airport',            'is_latest'),
        ('dim_carrier',            'airline_id'),
        ('dim_carrier',            'carrier_code'),
        ('dim_city_market',        'city_market_id'),
        ('fct_route_month',        'year_month'),
        ('fct_segment_month',      'year_month'),
        ('map_mainline_group',     'airline_id'),
        ('map_mainline_group',     'effective_from'),
        ('mart_route_health',      'op_airline_id'),
        ('mart_route_health',      'health_score'),
        ('meta_pivot_dimensions',  'key'),
        ('meta_pivot_dimensions',  'column_expr'),
        ('meta_pivot_measures',    'key'),
        ('meta_pivot_measures',    'expr')
)
SELECT
    r.object_name,
    r.column_name,
    (SELECT count(*) FROM duckdb_columns() dc WHERE dc.table_name = r.object_name)
        AS object_columns
FROM required r
LEFT JOIN duckdb_columns() c
    ON c.table_name  = r.object_name
   AND c.column_name = r.column_name
WHERE c.column_name IS NULL
ORDER BY r.object_name, r.column_name;
