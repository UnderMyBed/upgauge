-- upgauge: view
-- object: dim_airport
-- airport_id is identity; airport_seq_id is the point-in-time key. Both retained.
SELECT * FROM read_parquet('{{PARQUET_ROOT}}/dims/dim_airport.parquet')
