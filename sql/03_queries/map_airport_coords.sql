-- Resolve airport_ids -> current code, name and COORDINATES, for geographic views.
--
-- `WHERE is_latest` is load-bearing for the same reason resolve_airport.sql documents:
-- dim_airport is keyed on airport_seq_id and 5,033 airport_ids carry more than one seq
-- row, so an unfiltered join fans out and multiplies result rows.
--
-- lat/lon are NOT NULL for all 1,047 fact-present airports (measured 2026-08-01,
-- docs/data/invariants.md § Entity resolution), so a caller needs no missing-coordinate
-- branch -- but six airports carry a POSITIVE longitude and every consumer must normalize
-- across the antimeridian before assigning a map panel. SYA (Shemya) is Alaskan at +174.11.
SELECT
    airport_id AS id,
    code       AS code,
    name       AS name,
    lat        AS lat,
    lon        AS lon
FROM dim_airport
WHERE is_latest
  AND airport_id IN {{IDS}}
