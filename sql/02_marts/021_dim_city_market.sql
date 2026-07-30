-- upgauge: view
-- object: dim_city_market
-- Worldwide superset of the domestic facts -- see sql/01_staging/dim_city_market.sql.
SELECT * FROM read_parquet('{{PARQUET_ROOT}}/dims/dim_city_market.parquet')
