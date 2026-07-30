"""The sql/02_marts runner.

The header directive is the whole contract: it is what lets a .sql file declare its own
object name and materialization without a manifest that can drift out of sync with the
directory.
"""

from __future__ import annotations

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


def test_build_is_idempotent(tmp_path):
    """make build must be re-runnable; a second run cannot fail on 'already exists'."""
    marts = tmp_path / "marts"
    marts.mkdir()
    write_mart(marts, "010_v.sql", "-- upgauge: view\n-- object: v\nSELECT 1 AS x\n")
    write_mart(marts, "020_t.sql", "-- upgauge: table\n-- object: t\nSELECT 1 AS x\n")
    db = tmp_path / "u.duckdb"
    build_database(tmp_path / "p", db, marts)
    build_database(tmp_path / "p", db, marts)
    con = duckdb.connect(str(db))
    assert con.execute("SELECT count(*) FROM t").fetchone()[0] == 1


def test_a_failing_mart_names_the_file(tmp_path):
    marts = tmp_path / "marts"
    marts.mkdir()
    write_mart(
        marts, "010_bad.sql", "-- upgauge: view\n-- object: bad\nSELECT * FROM does_not_exist\n"
    )
    with pytest.raises(MartError, match="010_bad.sql"):
        build_database(tmp_path / "p", tmp_path / "u.duckdb", marts)
