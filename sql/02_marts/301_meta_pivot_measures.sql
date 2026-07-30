-- upgauge: view
-- object: meta_pivot_measures
--
-- Additive measures are summed. Derived measures are computed from summed numerator and
-- denominator at query time and are NEVER stored -- see docs/data/model.md. `expr` is the
-- exact SQL the pivot template substitutes.
--
-- asm and rpm multiply PER ROW then sum. SUM(seats) * distance is correct only within a
-- single route and is silently wrong across any pivot grouping more than one, which is
-- most of them. The DISTANCE-constancy measurement licenses max(distance) as a route
-- attribute; it does NOT license distance as a multiplier across routes.
SELECT * FROM (VALUES
    ('departures_scheduled', 'Dep. scheduled', TRUE,  'SUM(departures_scheduled)'),
    ('departures_performed', 'Dep. performed', TRUE,  'SUM(departures_performed)'),
    ('seats',                'Seats',          TRUE,  'SUM(seats)'),
    ('passengers',           'Passengers',     TRUE,  'SUM(passengers)'),
    ('freight',              'Freight',        TRUE,  'SUM(freight)'),
    ('mail',                 'Mail',           TRUE,  'SUM(mail)'),
    ('air_time',             'Air time',       TRUE,  'SUM(air_time)'),
    ('load_factor',          'Load factor',    FALSE, 'SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)'),
    ('avg_gauge',            'Avg gauge',      FALSE, 'SUM(seats)::DOUBLE / NULLIF(SUM(departures_performed), 0)'),
    ('completion_factor',    'Completion',     FALSE, 'SUM(departures_performed)::DOUBLE / NULLIF(SUM(departures_scheduled), 0)'),
    ('asm',                  'ASM',            FALSE, 'SUM(seats * distance)'),
    ('rpm',                  'RPM',            FALSE, 'SUM(passengers * distance)')
) AS t(key, label, is_additive, expr)
