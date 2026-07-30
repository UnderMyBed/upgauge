-- upgauge: view
-- object: fct_segment_month
--
-- The fact table, as a view over the Hive-partitioned Parquet written in M1. A view, not a
-- table: the Parquet files are already covered by make verify's byte-identical gate, and
-- materialising a copy would add a second artifact to keep honest for no gain.
--
-- Quarantined rows are RETAINED and flagged. Aggregates exclude them, but the UI surfaces
-- the count and reason -- showing the dirt is a trust feature, so the data cannot be
-- dropped this far upstream.
--
-- hive_partitioning exposes `year` as a real column, which is what lets DuckDB prune whole
-- year directories without reading them.
SELECT *
FROM read_parquet(
    '{{PARQUET_ROOT}}/t100_segment/**/*.parquet',
    hive_partitioning = true
)
