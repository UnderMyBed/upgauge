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
--
-- Every SUM() carries its own FILTER (WHERE NOT is_quarantined). This is what
-- pipeline/tests/test_pivot_real_data.py caught: without it, a pivot's aggregate silently
-- included quarantined rows (a bare WHERE in the template would remove them before
-- count(*) FILTER (WHERE is_quarantined) could see them, making quarantined_rows always 0 --
-- see 100_fct_route_month.sql's identical reasoning). One expr, shared by both grains'
-- templates -- fct_route_month exposes a structural `FALSE AS is_quarantined` (its sums are
-- already clean) purely so this FILTER is a no-op there instead of a missing column.
SELECT * FROM (VALUES
    ('departures_scheduled', 'Dep. scheduled', TRUE,  'SUM(departures_scheduled) FILTER (WHERE NOT is_quarantined)'),
    ('departures_performed', 'Dep. performed', TRUE,  'SUM(departures_performed) FILTER (WHERE NOT is_quarantined)'),
    ('seats',                'Seats',          TRUE,  'SUM(seats) FILTER (WHERE NOT is_quarantined)'),
    ('passengers',           'Passengers',     TRUE,  'SUM(passengers) FILTER (WHERE NOT is_quarantined)'),
    ('freight',              'Freight',        TRUE,  'SUM(freight) FILTER (WHERE NOT is_quarantined)'),
    ('mail',                 'Mail',           TRUE,  'SUM(mail) FILTER (WHERE NOT is_quarantined)'),
    ('air_time',             'Air time',       TRUE,  'SUM(air_time) FILTER (WHERE NOT is_quarantined)'),
    ('load_factor',          'Load factor',    FALSE, 'SUM(passengers) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(seats) FILTER (WHERE NOT is_quarantined), 0)'),
    ('avg_gauge',            'Avg gauge',      FALSE, 'SUM(seats) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(departures_performed) FILTER (WHERE NOT is_quarantined), 0)'),
    ('completion_factor',    'Completion',     FALSE, 'SUM(departures_performed) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(departures_scheduled) FILTER (WHERE NOT is_quarantined), 0)'),
    ('asm',                  'ASM',            FALSE, 'SUM(seats * distance) FILTER (WHERE NOT is_quarantined)'),
    ('rpm',                  'RPM',            FALSE, 'SUM(passengers * distance) FILTER (WHERE NOT is_quarantined)')
) AS t(key, label, is_additive, expr)
