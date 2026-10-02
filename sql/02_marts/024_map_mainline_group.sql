-- upgauge: table
-- object: map_mainline_group
-- DATE-RANGED. Wholly-owned subsidiaries and exclusive contract carriers, each row labelled by basis. Never shared regionals (OO, YX).
-- Read from the checked-in CSV at `make build`, never from data/parquet: the map ships with the
-- code, and the tag-keyed data/parquet cache may hold nothing this commit derived.
-- Every column typed explicitly: the sniffer would make `2015-01` a DATE. A blank field is NULL,
-- so an open-ended range is `effective_to IS NULL`, never '' and never a sentinel.
-- comment='#' truncates an UNQUOTED field at a `#`, so a URL with a fragment must be quoted;
-- pipeline/tests/test_marts.py holds this table equal to what load_mainline_map() validated.
SELECT *
FROM read_csv(
    '{{REFERENCE_ROOT}}/mainline_group.csv',
    header = true,
    comment = '#',
    auto_detect = false,
    delim = ',',
    quote = '"',
    escape = '"',
    columns = {
        'airline_id': 'INTEGER',
        'carrier_code': 'VARCHAR',
        'parent_airline_id': 'INTEGER',
        'parent_code': 'VARCHAR',
        'effective_from': 'VARCHAR',
        'effective_to': 'VARCHAR',
        'note': 'VARCHAR',
        'basis': 'VARCHAR',
        'source': 'VARCHAR'
    }
)
ORDER BY airline_id, effective_from
