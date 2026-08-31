-- upgauge: view
-- object: meta_pivot_dimensions
--
-- The Explorer's dimension vocabulary, as a catalog object rather than a committed JSON
-- file: the server already opens this database, so there is no extra artifact to ship and
-- `make build` regenerates it. That is what makes it un-driftable.
--
-- The VOCABULARY is curated, not introspected. Which dimensions we offer is a product
-- decision, not a schema fact -- fct_segment_month has columns (download_date,
-- quarantine_reason) that are not Explorer dimensions. A test cross-checks every column_expr
-- against duckdb_columns(), so a renamed fact column fails loudly instead of silently
-- dropping a dimension. The filter-value bound that reads these rows needs each
-- column's TYPE too; that is a schema fact rather than a product decision, so it is
-- introspected -- and it is introspected in sql/03_queries/catalog_dimensions.sql rather than
-- here, because a column added to THIS view only exists in a warehouse asset rebuilt after the
-- change, while a column computed in the QUERY ships with the code. See that file.
--
-- `grain`: 'both' | 'segment' | 'route'. aircraft_type and aircraft_group are segment-only
-- because fct_route_month drops that grain.
-- `join_dim` / `join_key`: the dimension table and key that resolve an id to a display name.
-- NULL where the value is already human-readable. `route` is the one dimension whose
-- column_expr names TWO keys -- route_key_low and route_key_high -- and both resolve through
-- the same dim_airport.airport_id, which is why one join_dim/join_key pair still describes
-- it. A test asserts every _id column_expr carries this metadata.
--
-- Consequence accepted knowingly: make verify now covers a product decision, not only data.
-- That is the price of the vocabulary being impossible to drift.
--
-- THE VALUES ROW ORDER BELOW IS THE CURATED ORDER, and it is a product decision: `year` before
-- `op_airline_id` is what the Explorer's dimension chip row renders and what a grain switch lands
-- on when nothing in the current selection survives. A view cannot promise a reader its own row
-- order -- a scan or a join is free to emit them in any -- so the sequence is carried as an
-- explicit ordinal by sql/03_queries/catalog_dimensions.sql, which orders by it, and
-- pipeline/tests/test_pivot_allowlist.py binds that ordinal to the text below. Add a row here
-- without adding it there and the row is DROPPED, loudly, rather than landing somewhere arbitrary.
--
-- `filter_only`: the dimension is accepted in a FILTER and REJECTED as a grouping
-- dimension. Exactly one row uses it, and it is not a style choice. `endpoint_airport_id`
-- means "this airport at EITHER end", so grouping by it puts one segment row (ORD->LAX)
-- into BOTH the ORD group and the LAX group, and summing the column double-counts every
-- row in the table -- structurally the same failure as T-100's CLASS rollup codes K/V/Z,
-- whose absence docs/data/invariants.md makes the pipeline assert.
--
-- `filter_mode`: how a filter on this dimension compiles. NULL is the ordinary
-- single-column `col IN (...)`. 'pair' is `route`, whose two columns are ONE route and
-- compile to least()/greatest() equality -- see render.ts's own comment for the 18,895-seat
-- reason. 'either' is `endpoint_airport_id`, whose two columns are ALTERNATIVES and compile
-- to an OR. A pair filter and an either filter over the same two columns are different
-- queries; the mode is what keeps them from being confused.
SELECT * FROM (VALUES
    ('year_month',            'Month',            'year_month',            'both',    NULL,               NULL,             FALSE, NULL),
    ('quarter',               'Quarter',          'quarter',               'both',    NULL,               NULL,             FALSE, NULL),
    ('year',                  'Year',             'year',                  'both',    NULL,               NULL,             FALSE, NULL),
    ('op_airline_id',         'Carrier',          'op_airline_id',         'both',    'dim_carrier',      'airline_id',     FALSE, NULL),
    ('origin_airport_id',     'Origin',           'origin_airport_id',     'both',    'dim_airport',      'airport_id',     FALSE, NULL),
    ('dest_airport_id',       'Destination',      'dest_airport_id',       'both',    'dim_airport',      'airport_id',     FALSE, NULL),
    ('route',                 'Route',            'route_key_low, route_key_high', 'both', 'dim_airport', 'airport_id',    FALSE, 'pair'),
    ('endpoint_airport_id',   'Airport (either end)', 'origin_airport_id, dest_airport_id', 'both', 'dim_airport', 'airport_id', TRUE, 'either'),
    ('origin_city_market_id', 'Origin market',    'origin_city_market_id', 'both',    'dim_city_market',  'city_market_id', FALSE, NULL),
    ('dest_city_market_id',   'Dest market',      'dest_city_market_id',   'both',    'dim_city_market',  'city_market_id', FALSE, NULL),
    ('origin_state',          'Origin state',     'origin_state',          'segment', NULL,               NULL,             FALSE, NULL),
    ('dest_state',            'Dest state',       'dest_state',            'segment', NULL,               NULL,             FALSE, NULL),
    ('aircraft_type',         'Aircraft type',    'aircraft_type',         'segment', 'dim_aircraft_type', 'code',          FALSE, NULL),
    ('aircraft_group',        'Aircraft group',   'aircraft_group',        'segment', NULL,               NULL,             FALSE, NULL),
    ('distance_group',        'Distance group',   'distance_group',        'segment', NULL,               NULL,             FALSE, NULL)
) AS t(key, label, column_expr, grain, join_dim, join_key, filter_only, filter_mode)
