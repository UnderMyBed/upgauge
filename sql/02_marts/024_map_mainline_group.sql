-- upgauge: view
-- object: map_mainline_group
-- DATE-RANGED, wholly-owned only. Never roll up shared regionals (OO, YX, YV).
SELECT * FROM read_parquet('{{PARQUET_ROOT}}/dims/map_mainline_group.parquet')
