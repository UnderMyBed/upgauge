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


# --------------------------------------------------------------- map_mainline_group
#
# The map ships with the code, like the marts. CI and the image restore `data/parquet` from the
# release asset and then run only `make build`, so a map read from `dims/` is whatever the asset
# was packed with -- warehouse-2026.06 carries the 7 pre-#11 rows and no basis/source columns.
# And the CI cache stores `data/parquet` under a tag-only key, so nothing derived from this
# commit may be written there: the map is a TABLE in `upgauge.duckdb`, read from the CSV.

MAINLINE_CSV = Path(__file__).parents[1] / "reference" / "mainline_group.csv"
MAINLINE_ROWS = 17


def _map_db(tmp_path, stale_parquet: bool = False):
    """A database built over a fixture warehouse whose `dims/` has NO map parquet -- or, with
    `stale_parquet`, the asset's shape: 7 rows and 7 columns, no basis/source."""
    parquet = _warehouse(tmp_path)
    shadow = parquet / "dims" / "map_mainline_group.parquet"
    shadow.unlink(missing_ok=True)
    if stale_parquet:
        from pipeline.normalize import _writer_connection

        w = _writer_connection()
        w.execute(
            f"""COPY (SELECT * FROM (VALUES
                (20363, '9E', 19790, 'DL', '2015-01', NULL, 'stale'),
                (20398, 'MQ', 19805, 'AA', '2015-01', NULL, 'stale'),
                (20397, 'OH', 19805, 'AA', '2015-01', NULL, 'stale'),
                (20427, 'PT', 19805, 'AA', '2015-01', NULL, 'stale'),
                (19687, 'QX', 19930, 'AS', '2015-01', NULL, 'stale'),
                (21171, 'VX', 19930, 'AS', '2016-12', '2018-04', 'stale'),
                (19690, 'HA', 19930, 'AS', '2024-09', NULL, 'stale')
            ) t(airline_id, carrier_code, parent_airline_id, parent_code,
                effective_from, effective_to, note)) TO '{shadow}' (FORMAT PARQUET)"""
        )
        w.close()
    db = tmp_path / "u.duckdb"
    build_database(parquet, db)
    return duckdb.connect(str(db))


def test_map_is_built_from_the_csv_when_the_parquet_tree_has_none(tmp_path):
    """Catches the map still being sourced from the asset's `dims/`: with no parquet copy
    there, a view over it cannot even build."""
    con = _map_db(tmp_path)
    assert con.execute("SELECT count(*) FROM map_mainline_group").fetchone()[0] == MAINLINE_ROWS


def test_a_stale_asset_copy_of_the_map_does_not_win(tmp_path):
    """The CI shape: the restored asset still carries the pre-#11 7-row, 7-column parquet.
    The database must hold the CSV's rows and columns regardless."""
    con = _map_db(tmp_path, stale_parquet=True)
    assert con.execute("SELECT count(*) FROM map_mainline_group").fetchone()[0] == MAINLINE_ROWS
    cols = [r[0] for r in con.execute("DESCRIBE map_mainline_group").fetchall()]
    assert cols[-2:] == ["basis", "source"]
    assert (
        con.execute("SELECT count(*) FROM map_mainline_group WHERE note = 'stale'").fetchone()[0]
        == 0
    )
    kind = con.execute(
        "SELECT table_type FROM information_schema.tables WHERE table_name = 'map_mainline_group'"
    ).fetchone()[0]
    assert kind == "BASE TABLE"


def test_map_columns_are_typed_explicitly_and_open_ranges_are_null(tmp_path):
    """read_csv's sniffer would turn `2015-01` into a DATE and could read a blank
    `effective_to` as ''. The join tests `effective_to IS NULL`, so '' would silently end every
    open range, and a 9999-12 sentinel would leak into the UI."""
    con = _map_db(tmp_path)
    types = {r[0]: r[1] for r in con.execute("DESCRIBE map_mainline_group").fetchall()}
    assert types == {
        "airline_id": "INTEGER",
        "carrier_code": "VARCHAR",
        "parent_airline_id": "INTEGER",
        "parent_code": "VARCHAR",
        "effective_from": "VARCHAR",
        "effective_to": "VARCHAR",
        "note": "VARCHAR",
        "basis": "VARCHAR",
        "source": "VARCHAR",
    }
    c5 = con.execute(
        "SELECT effective_from, effective_to FROM map_mainline_group WHERE airline_id = 20445"
    ).fetchall()
    assert c5 == [("2015-01", None)]
    assert (
        con.execute(
            "SELECT count(*) FROM map_mainline_group WHERE effective_to = '' OR basis = ''"
        ).fetchone()[0]
        == 0
    )
    assert (
        con.execute(
            "SELECT count(*) FROM map_mainline_group WHERE effective_to IS NULL"
        ).fetchone()[0]
        > 0
    )


def test_hawaiian_range_starts_september_2024(tmp_path):
    con = _map_db(tmp_path)
    assert con.execute(
        "SELECT effective_from FROM map_mainline_group WHERE airline_id = 19690"
    ).fetchall() == [("2024-09",)]


def test_shared_regionals_are_absent_from_the_map(tmp_path):
    """SkyWest and Republic. Never rolled up, at any date. (Mesa has a row only for its
    United-only months, 2023-05..2025-11.)"""
    con = _map_db(tmp_path)
    ids = {r[0] for r in con.execute("SELECT airline_id FROM map_mainline_group").fetchall()}
    assert ids.isdisjoint({20304, 20452})


def test_the_table_is_exactly_what_the_loader_validated(tmp_path):
    """Two parsers read one file: `load_mainline_map` validates it, DuckDB's read_csv
    materializes it. Any place they disagree -- read_csv truncates an unquoted field at a `#`
    (comment='#'), the loader strips whitespace -- the table holds a row nobody validated."""
    from pipeline.mainline_map import load_mainline_map

    con = _map_db(tmp_path)
    table = con.execute(
        "SELECT airline_id, carrier_code, parent_airline_id, parent_code, effective_from,"
        " effective_to, note, basis, source FROM map_mainline_group"
    ).fetchall()
    loaded = [
        (
            e.airline_id,
            e.carrier_code,
            e.parent_airline_id,
            e.parent_code,
            e.effective_from,
            e.effective_to,
            e.note or None,
            e.basis,
            e.source or None,
        )
        for e in load_mainline_map().entries
    ]
    assert sorted(table, key=repr) == sorted(loaded, key=repr)


def test_an_invalid_map_fails_the_build(tmp_path):
    """`make build` is the only step CI and the image run after the restore, so it is where the
    map must be validated: an unsourced contract row would otherwise ship uncited."""
    from pipeline.mainline_map import UnsourcedContractError

    ref = tmp_path / "reference"
    ref.mkdir()
    lines = MAINLINE_CSV.read_text().splitlines(keepends=True)
    em = next(i for i, ln in enumerate(lines) if ln.startswith("20263,"))
    lines[em] = lines[em].rsplit(",", 1)[0] + ",\n"
    (ref / "mainline_group.csv").write_text("".join(lines))

    # A real warehouse, so that without the validation this build would SUCCEED -- over a
    # missing parquet tree it fails anyway, and the test could not tell the two apart.
    parquet = _warehouse(tmp_path)
    db = tmp_path / "u.duckdb"
    with pytest.raises(UnsourcedContractError, match="20263"):
        build_database(parquet, db, reference_dir=ref)
    assert not db.exists()


def test_make_build_writes_nothing_under_the_parquet_tree(tmp_path):
    """`data/parquet` is cached under a key naming only the warehouse tag, so a byte in it
    derived from this commit is stored under a name promising the asset's."""
    parquet = _warehouse(tmp_path)

    def snapshot():
        return {
            str(p.relative_to(parquet)): (p.stat().st_mtime_ns, p.stat().st_size)
            for p in parquet.rglob("*")
        }

    before = snapshot()
    build_database(parquet, tmp_path / "u.duckdb")
    assert snapshot() == before
