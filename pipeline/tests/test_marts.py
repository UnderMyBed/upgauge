"""The sql/02_marts runner.

The header directive is the whole contract: it is what lets a .sql file declare its own
object name and materialization without a manifest that can drift out of sync with the
directory.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from pipeline.marts import MartError, build_database, mart_files, parse_mart_file


def write_mart(d, name, body):
    p = d / name
    p.write_text(body)
    return p


def test_parses_object_name_and_materialization(tmp_path):
    p = write_mart(
        tmp_path, "010_thing.sql", "-- upgauge: view\n-- object: v_thing\nSELECT 1 AS x\n"
    )
    mart = parse_mart_file(p)
    assert mart.object_name == "v_thing"
    assert mart.materialization == "view"
    assert "SELECT 1 AS x" in mart.body


def test_object_name_comes_from_directive_not_filename(tmp_path):
    """Numeric prefixes order execution; they must never leak into object names."""
    p = write_mart(
        tmp_path,
        "200_mart_route_health.sql",
        "-- upgauge: table\n-- object: mart_route_health\nSELECT 1 AS x\n",
    )
    assert parse_mart_file(p).object_name == "mart_route_health"


def test_missing_directive_is_an_error(tmp_path):
    """A file with no directive must fail loudly, not be silently skipped -- a skipped
    mart produces a database that is missing an object and reports success."""
    p = write_mart(tmp_path, "010_thing.sql", "SELECT 1 AS x\n")
    with pytest.raises(MartError, match="object"):
        parse_mart_file(p)


def test_missing_upgauge_directive_is_an_error(tmp_path):
    """Object present but no materialization directive: still a loud failure, not a
    default materialization guessed on the file's behalf."""
    p = write_mart(tmp_path, "010_thing.sql", "-- object: v\nSELECT 1 AS x\n")
    with pytest.raises(MartError, match="materialization"):
        parse_mart_file(p)


def test_duplicate_directive_in_header_is_an_error(tmp_path):
    """A repeated `-- object:` in the header must fail loudly rather than let the later
    occurrence silently win -- the same class of silent-wrong-answer this module's other
    loud failures exist to prevent."""
    p = write_mart(
        tmp_path,
        "010_thing.sql",
        "-- upgauge: view\n-- object: a\n-- object: b\nSELECT 1 AS x\n",
    )
    with pytest.raises(MartError, match="duplicate"):
        parse_mart_file(p)


def test_blank_line_inside_the_header_is_tolerated(tmp_path):
    """A blank line between directives is natural formatting, not the end of the header --
    the old loop broke on the first non-`--` line, so a blank line raised a spurious
    'no `-- object:` directive' for a file that has one."""
    p = write_mart(
        tmp_path,
        "010_thing.sql",
        "-- upgauge: view\n\n-- object: v_thing\nSELECT 1 AS x\n",
    )
    mart = parse_mart_file(p)
    assert mart.object_name == "v_thing"


def test_directive_on_its_own_line_after_the_body_is_ignored(tmp_path):
    """The case that actually discriminates: a standalone directive line AFTER the SQL body
    would have been matched by the original whole-file regex and silently won.

    The previous version of this test used a trailing same-line comment, which the old regex
    also rejected -- so it passed before the fix and guarded nothing.
    """
    p = write_mart(
        tmp_path,
        "010_thing.sql",
        "-- upgauge: view\n-- object: right\nSELECT 1 AS x\n-- object: wrong\n",
    )
    assert parse_mart_file(p).object_name == "right"


def test_unknown_materialization_is_an_error(tmp_path):
    p = write_mart(
        tmp_path, "010_thing.sql", "-- upgauge: materialized_view\n-- object: v\nSELECT 1\n"
    )
    with pytest.raises(MartError, match="materialization"):
        parse_mart_file(p)


def test_files_run_in_filename_order(tmp_path):
    write_mart(tmp_path, "200_b.sql", "-- upgauge: view\n-- object: b\nSELECT 1\n")
    write_mart(tmp_path, "010_a.sql", "-- upgauge: view\n-- object: a\nSELECT 1\n")
    assert [m.object_name for m in mart_files(tmp_path)] == ["a", "b"]


def test_build_creates_view_and_table(tmp_path):
    marts = tmp_path / "marts"
    marts.mkdir()
    write_mart(marts, "010_v.sql", "-- upgauge: view\n-- object: v_one\nSELECT 1 AS x\n")
    write_mart(marts, "020_t.sql", "-- upgauge: table\n-- object: t_one\nSELECT x FROM v_one\n")

    db = tmp_path / "u.duckdb"
    assert build_database(tmp_path / "parquet", db, marts) == ["v_one", "t_one"]

    con = duckdb.connect(str(db))
    kinds = dict(
        con.execute(
            "SELECT table_name, table_type FROM information_schema.tables ORDER BY table_name"
        ).fetchall()
    )
    assert kinds["v_one"] == "VIEW"
    assert kinds["t_one"] == "BASE TABLE"


def test_parquet_root_token_is_substituted(tmp_path):
    marts = tmp_path / "marts"
    marts.mkdir()
    write_mart(
        marts, "010_v.sql", "-- upgauge: view\n-- object: v\nSELECT '{{PARQUET_ROOT}}' AS root\n"
    )
    db = tmp_path / "u.duckdb"
    build_database("data/parquet", db, marts)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT root FROM v").fetchone()[0] == "data/parquet"


def test_parquet_root_is_not_resolved_to_an_absolute_path(tmp_path):
    """An absolute CI path baked into a shipped view opens fine and fails every read
    inside Docker. Invisible until deploy, so it is asserted here."""
    marts = tmp_path / "marts"
    marts.mkdir()
    write_mart(
        marts, "010_v.sql", "-- upgauge: view\n-- object: v\nSELECT '{{PARQUET_ROOT}}/x' AS p\n"
    )
    db = tmp_path / "u.duckdb"
    build_database("data/parquet", db, marts)
    con = duckdb.connect(str(db))
    sql = con.execute("SELECT sql FROM duckdb_views() WHERE view_name = 'v'").fetchone()[0]
    assert "/home" not in sql and not sql.count("'/")


def test_repeated_build_succeeds_and_does_not_double_rows(tmp_path):
    """make build must be re-runnable; a second run cannot fail on 'already exists' or
    accumulate rows in the materialized table."""
    marts = tmp_path / "marts"
    marts.mkdir()
    write_mart(marts, "010_v.sql", "-- upgauge: view\n-- object: v\nSELECT 1 AS x\n")
    write_mart(marts, "020_t.sql", "-- upgauge: table\n-- object: t\nSELECT 1 AS x\n")
    db = tmp_path / "u.duckdb"
    build_database(tmp_path / "p", db, marts)
    build_database(tmp_path / "p", db, marts)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM t").fetchone()[0] == 1


def test_a_failed_build_leaves_the_original_database_intact(tmp_path):
    """DuckDB DDL auto-commits, so building in place would mean a failure partway through
    leaves a database that opens fine and silently contains only the marts built before the
    failure -- after having already deleted the previously-good one. A build must instead
    leave the working database untouched, and clean up after itself."""
    good_marts = tmp_path / "good"
    good_marts.mkdir()
    write_mart(good_marts, "010_v.sql", "-- upgauge: view\n-- object: v\nSELECT 1 AS x\n")
    write_mart(good_marts, "020_t.sql", "-- upgauge: table\n-- object: t\nSELECT 2 AS x\n")

    db = tmp_path / "u.duckdb"
    assert build_database(tmp_path / "p", db, good_marts) == ["v", "t"]

    broken_marts = tmp_path / "broken"
    broken_marts.mkdir()
    write_mart(broken_marts, "010_v.sql", "-- upgauge: view\n-- object: v\nSELECT 1 AS x\n")
    write_mart(
        broken_marts, "020_bad.sql", "-- upgauge: view\n-- object: bad\nSELECT * FROM nope\n"
    )

    with pytest.raises(MartError):
        build_database(tmp_path / "p", db, broken_marts)

    con = duckdb.connect(str(db))
    names = {
        r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()
    }
    assert names == {"v", "t"}
    con.close()

    assert not db.with_name(db.name + ".incoming").exists()
    assert not Path(str(db) + ".incoming.wal").exists()


def test_a_failing_mart_names_the_file(tmp_path):
    marts = tmp_path / "marts"
    marts.mkdir()
    write_mart(
        marts, "010_bad.sql", "-- upgauge: view\n-- object: bad\nSELECT * FROM does_not_exist\n"
    )
    with pytest.raises(MartError, match="010_bad.sql"):
        build_database(tmp_path / "p", tmp_path / "u.duckdb", marts)


def _warehouse(tmp_path):
    """A real Parquet warehouse built from the committed fixtures."""
    import shutil

    from pipeline.build import build_all
    from pipeline.fetch import T100D_SEGMENT_US, raw_path
    from pipeline.lookups import AIRCRAFT_TYPES, CARRIER_DECODE, MASTER_COORDINATE

    fixtures = Path(__file__).parent / "fixtures"
    raw = tmp_path / "raw"
    raw.mkdir()
    fact = raw_path(raw, T100D_SEGMENT_US, 2015, "2026-07-29")
    shutil.copy(fixtures / "t100d_segment_sample_2015.zip", fact)
    shutil.copy(fixtures / "t100d_segment_sample_2015.json", fact.with_suffix(".json"))
    for table, stem in (
        (MASTER_COORDINATE, "master_coordinate_sample"),
        (CARRIER_DECODE, "carrier_decode_sample"),
        (AIRCRAFT_TYPES, "aircraft_types_sample"),
    ):
        dest = raw_path(raw, table, None, "2026-07-29")
        shutil.copy(fixtures / f"{stem}.zip", dest)
        shutil.copy(fixtures / f"{stem}.json", dest.with_suffix(".json"))

    parquet = tmp_path / "parquet"
    build_all(raw, parquet)
    return parquet


def test_real_catalog_exposes_every_expected_object(tmp_path):
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    names = build_database(parquet, db)
    for expected in (
        "fct_segment_month",
        "dim_airport",
        "dim_city_market",
        "dim_carrier",
        "dim_aircraft_type",
        "map_mainline_group",
    ):
        assert expected in names


def test_fct_segment_month_view_returns_rows(tmp_path):
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM fct_segment_month").fetchone()[0] > 0


def test_fct_segment_month_has_no_derived_measure_columns(tmp_path):
    """The structural rule: you cannot AVG() what does not exist."""
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    con = duckdb.connect(str(db))
    cols = {r[0].lower() for r in con.execute("DESCRIBE fct_segment_month").fetchall()}
    assert not cols & {"load_factor", "asm", "rpm", "avg_gauge", "completion_factor"}


def test_aircraft_type_stays_a_string_through_the_view(tmp_path):
    """'079' becoming 79 breaks the dim join silently."""
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    con = duckdb.connect(str(db))
    types = {r[0]: r[1] for r in con.execute("DESCRIBE fct_segment_month").fetchall()}
    assert types["aircraft_type"] == "VARCHAR"


def test_year_partition_matches_the_directory_it_was_read_from(tmp_path):
    """`year` is a genuine content column (`normalize_t100_segment.sql` casts `raw.YEAR`),
    written independently of the `year=YYYY` directory it lands in. This test guards that
    the two never silently drift apart -- e.g. a normalize bug that wrote a row to the wrong
    partition, or wrote the wrong integer into the column.

    CORRECTED (fix round 1): this does NOT guard `hive_partitioning = true` specifically.
    Measured empirically: flipping that flag to `false` in the view still leaves `year`
    present with the same values, because the column already exists in the Parquet content,
    not only in the directory name. What `hive_partitioning = true` actually buys is file
    pruning -- see `test_fct_segment_month_view_sets_hive_partitioning_for_pruning` below,
    and the measured pruning numbers in the .sql header comment and
    docs/architecture/pipeline.md.
    """
    parquet = _warehouse(tmp_path)
    partition_years = {
        int(p.name.split("=", 1)[1])
        for p in (parquet / "t100_segment").iterdir()
        if p.is_dir() and p.name.startswith("year=")
    }
    assert partition_years, "fixture warehouse produced no year= partitions to compare against"

    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    con = duckdb.connect(str(db))

    cols = {r[0].lower() for r in con.execute("DESCRIBE fct_segment_month").fetchall()}
    assert "year" in cols

    view_years = {
        r[0] for r in con.execute("SELECT DISTINCT year FROM fct_segment_month").fetchall()
    }
    assert view_years == partition_years


def test_fct_segment_month_view_sets_hive_partitioning_for_pruning(tmp_path):
    """`hive_partitioning = true` is not what makes `year` exist -- see the test above --
    it is what lets DuckDB skip whole `year=YYYY` files instead of opening every one and
    filtering by content. Measured against the real 3-year warehouse in data/parquet/: a
    `WHERE year = 2015` query reports `Total Files Read: 1` (of 3) with the flag on, versus
    `Total Files Read: 3` with it off -- same result, 3x the I/O.

    Asserting that measurement itself via EXPLAIN ANALYZE would be brittle: DuckDB's
    profiling `extra_info` keys ('Total Files Read', 'Scanning Files', ...) are a debug
    rendering, not a stable public API, and are free to change format across versions. So
    this pins the config instead of the runtime effect: the compiled view's own SQL text
    (the artifact this repo controls) must still request hive partitioning. That is
    everything standing between "prunes 2 of 3 files" and "silently scans all of them."
    """
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    con = duckdb.connect(str(db))
    sql = con.execute(
        "SELECT sql FROM duckdb_views() WHERE view_name = 'fct_segment_month'"
    ).fetchone()[0]
    # DuckDB re-serializes the boolean literal as CAST('t' AS BOOLEAN) / CAST('f' AS
    # BOOLEAN) rather than echoing `true`/`false` back verbatim -- verified directly
    # against this DuckDB version before writing this assertion.
    assert "hive_partitioning" in sql
    assert "CAST('t' AS BOOLEAN)" in sql
