-- upgauge: view
-- object: map_mainline_group
-- DATE-RANGED. Wholly-owned subsidiaries and exclusive contract carriers, each row labelled by basis. Never shared regionals (OO, YX).
SELECT * FROM read_parquet('{{PARQUET_ROOT}}/dims/map_mainline_group.parquet')
