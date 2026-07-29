-- AircraftTypes -> dim_aircraft_type.
--
-- code stays VARCHAR: '007' and '079' are real type codes and int-parsing them breaks the
-- join to fct_segment_month silently, because codes without a leading zero still match.
--
-- Deliberately no seats_typical column. Seats-per-departure is derived from the facts; a
-- nominal value here would invite averaging it, which is the bug the whole model avoids.
--
-- $csv_path  extracted T_AIRCRAFT_TYPES.csv
SELECT
    AC_TYPEID                                   AS code,
    CAST(nullif(AC_GROUP, '') AS SMALLINT)      AS aircraft_group,
    LONG_NAME                                   AS name,
    SHORT_NAME                                  AS short_name,
    MANUFACTURER                                AS manufacturer,
    SSD_NAME                                    AS ssd_name,
    nullif(BEGIN_DATE, '')                      AS effective_from,
    nullif(END_DATE, '')                        AS effective_to
FROM read_csv($csv_path, all_varchar = true, header = true)
ORDER BY code
