-- Resolve an aircraft_type -> its name. This resolver INVERTS the usual direction: the fact
-- table already stores the join key ('612'), and what is missing is the readable name
-- ('A321'). The key is a zero-padded STRING -- CLAUDE.md: AIRCRAFT_TYPE '079' becomes 79 if
-- int-parsed and the join breaks silently -- so `id` stays VARCHAR here and the binding
-- side must not coerce it to a number.
SELECT
    code AS id,
    code AS code,
    name AS name
FROM dim_aircraft_type
WHERE code IN {{IDS}}
