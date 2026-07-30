-- upgauge: view
-- object: dim_carrier
-- carrier_code is the CURRENT code, one row per airline_id. Display only; never join on it.
SELECT * FROM read_parquet('{{PARQUET_ROOT}}/dims/dim_carrier.parquet')
