-- Resolve an aircraft_type -> a readable designation. This resolver INVERTS the usual
-- direction: the fact table already stores the join key ('612'), and what is missing is
-- something a reader can use.
--
-- `code` here is dim_aircraft_type.short_name ('B737-7', 'ERJ-175', 'A321/LR'), NOT the
-- BTS code. Returning the BTS code would render '612' in the cell -- exactly the value this
-- milestone exists to eliminate -- so the short name is what plays the role `carrier_code`
-- plays for carriers. Measured: short_name is non-null and non-empty for all 450 rows, and
-- for all 112 aircraft types that appear in-window, so this cannot silently render blank.
-- `name` stays the full designation ('BOEING 737-700/700LR/MAX 7') for the tooltip; it is
-- too long for a dense table cell.
--
-- The key is a zero-padded STRING -- CLAUDE.md: AIRCRAFT_TYPE '079' becomes 79 if int-parsed
-- and the join breaks silently -- so `id` stays VARCHAR and the binding side must not coerce
-- it to a number.
SELECT
    code       AS id,
    short_name AS code,
    name       AS name
FROM dim_aircraft_type
WHERE code IN {{IDS}}
