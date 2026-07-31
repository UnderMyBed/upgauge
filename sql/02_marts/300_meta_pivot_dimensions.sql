-- upgauge: view
-- object: meta_pivot_dimensions
--
-- The Explorer's dimension vocabulary, as a catalog object rather than a committed JSON
-- file: the server already opens this database, so there is no extra artifact to ship and
-- `make build` regenerates it. That is what makes it un-driftable.
--
-- CURATED, not introspected. Which dimensions we offer is a product decision, not a schema
-- fact -- fct_segment_month has columns (download_date, quarantine_reason) that are not
-- Explorer dimensions. A test cross-checks every column_expr against duckdb_columns(), so a
-- renamed fact column fails loudly instead of silently dropping a dimension.
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
SELECT * FROM (VALUES
    ('year_month',            'Month',            'year_month',            'both',    NULL,               NULL),
    ('quarter',               'Quarter',          'quarter',               'both',    NULL,               NULL),
    ('year',                  'Year',             'year',                  'both',    NULL,               NULL),
    ('op_airline_id',         'Carrier',          'op_airline_id',         'both',    'dim_carrier',      'airline_id'),
    ('origin_airport_id',     'Origin',           'origin_airport_id',     'both',    'dim_airport',      'airport_id'),
    ('dest_airport_id',       'Destination',      'dest_airport_id',       'both',    'dim_airport',      'airport_id'),
    ('route',                 'Route',            'route_key_low, route_key_high', 'both', 'dim_airport', 'airport_id'),
    ('origin_city_market_id', 'Origin market',    'origin_city_market_id', 'both',    'dim_city_market',  'city_market_id'),
    ('dest_city_market_id',   'Dest market',      'dest_city_market_id',   'both',    'dim_city_market',  'city_market_id'),
    ('origin_state',          'Origin state',     'origin_state',          'segment', NULL,               NULL),
    ('dest_state',            'Dest state',       'dest_state',            'segment', NULL,               NULL),
    ('aircraft_type',         'Aircraft type',    'aircraft_type',         'segment', 'dim_aircraft_type', 'code'),
    ('aircraft_group',        'Aircraft group',   'aircraft_group',        'segment', NULL,               NULL),
    ('distance_group',        'Distance group',   'distance_group',        'segment', NULL,               NULL)
) AS t(key, label, column_expr, grain, join_dim, join_key)
