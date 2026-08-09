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
-- Keeping this list current is not left to memory: health.test.ts's drift test strips comments
-- from every sql/03_queries/*.sql, extracts FROM/JOIN identifiers, subtracts CTE names, and
-- fails if any referenced object is absent below.
WITH required(object_name, column_name) AS (
    VALUES
        ('dim_aircraft_type',      'code'),
        ('dim_aircraft_type',      'name'),
        ('dim_airport',            'airport_id'),
        ('dim_airport',            'code'),
        -- lat/lon are the M7 Task 10 fixture: present object, absent columns.
        ('dim_airport',            'lat'),
        ('dim_airport',            'lon'),
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
