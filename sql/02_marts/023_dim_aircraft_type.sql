-- upgauge: view
-- object: dim_aircraft_type
-- `code` stays VARCHAR: '007' and '079' are real type codes.
SELECT * FROM read_parquet('{{PARQUET_ROOT}}/dims/dim_aircraft_type.parquet')
