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
-- `year` already exists as Parquet CONTENT (normalize_t100_segment.sql casts raw.YEAR), so
-- hive_partitioning = true is NOT what makes the column exist -- it still would with the
-- flag off. What it buys is FILE PRUNING: DuckDB can skip whole `year=YYYY` files instead of
-- opening every one and filtering by content.
--
-- Measured against the real 3-year warehouse in data/parquet/ (2015-2017), `WHERE year =
-- 2015` reports (EXPLAIN ANALYZE, JSON profiling, DuckDB 1.5.5):
--   hive_partitioning = true:  Total Files Read: 1 (of 3), File Filters: (year = 2015)
--   hive_partitioning = false: Total Files Read: 3,        Filters: year=2015 (row-level only)
-- Same result both ways (705,332,563 passengers) -- correctness is identical; only the I/O
-- differs. See docs/architecture/pipeline.md's M2 section for the full writeup, including
-- the (separately measured, not applicable to real data today) column-collision behavior:
-- if the content `year` and the `year=YYYY` directory name ever disagreed, DuckDB does not
-- error or duplicate the column -- the partition-derived value silently wins.
SELECT *
FROM read_parquet(
    '{{PARQUET_ROOT}}/t100_segment/**/*.parquet',
    hive_partitioning = true
)
