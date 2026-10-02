"""Composition steps of mainline groups, listed from map_mainline_group (#203).

docs/data/carrier-model.md caveat 3: a grouped series must annotate every boundary where a
group's composition changes. This file is the one place those boundaries are derived.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

SQL = Path("sql/03_queries/mainline_steps.sql")
DB = Path("upgauge.duckdb")
real = pytest.mark.skipif(not DB.exists(), reason="no built catalog; run `make build`")

AS, VX, AA, US, UA = 19930, 21171, 19805, 20355, 19977


def _steps(con, time_from, time_to):
    return con.execute(SQL.read_text(), {"time_from": time_from, "time_to": time_to}).fetchall()


@pytest.fixture(scope="module")
def con():
    return duckdb.connect(str(DB), read_only=True)


@real
def test_virgin_america_joining_alaska_steps_both_series(con):
    """Catches: dropping the child-side arms. VX's OWN series stops at 2016-12 too."""
    rows = {(s, m, o, k) for s, m, o, _code, k in _steps(con, "2016-06", "2017-06")}
    assert (AS, "2016-12", VX, "joins") in rows
    assert (VX, "2016-12", AS, "rolls_up") in rows


@real
def test_a_step_at_the_window_start_is_not_crossed(con):
    """Catches: `>=` for `>` on $time_from. A window that starts AT the step is all one side."""
    months = {m for _s, m, *_ in _steps(con, "2016-12", "2017-06")}
    assert "2016-12" not in months


@real
def test_a_step_at_the_window_end_is_crossed(con):
    """Catches: `<` for `<=` on $time_to."""
    rows = {(s, m, k) for s, m, _o, _c, k in _steps(con, "2016-06", "2016-12")}
    assert (AS, "2016-12", "joins") in rows


@real
def test_us_airways_leaving_american_is_a_step(con):
    """Every map boundary is a step, including one that moves no traffic (US filed nothing
    after 2015-06). Catches: dropping the `leaves` arm."""
    rows = {(s, m, o, k) for s, m, o, _c, k in _steps(con, "2015-01", "2026-06")}
    assert (AA, "2016-01", US, "leaves") in rows


@real
def test_united_steps_match_caveat_three(con):
    """carrier-model.md caveat 3 lists United's nine composition months."""
    months = sorted(
        {
            m
            for s, m, _o, _c, k in _steps(con, "2015-01", "2026-06")
            if s == UA and k in ("joins", "leaves")
        }
    )
    assert months == [
        "2018-03",
        "2019-01",
        "2019-02",
        "2020-05",
        "2020-10",
        "2021-01",
        "2023-03",
        "2023-05",
        "2025-12",
    ]


@real
def test_other_code_is_resolved(con):
    rows = {(s, m, code) for s, m, _o, code, _k in _steps(con, "2016-06", "2017-06")}
    assert (AS, "2016-12", "VX") in rows


def _synthetic():
    c = duckdb.connect()
    c.execute("""
        CREATE TABLE map_mainline_group (
            airline_id INTEGER, parent_airline_id INTEGER,
            effective_from VARCHAR, effective_to VARCHAR);
        CREATE TABLE dim_carrier (airline_id INTEGER, carrier_code VARCHAR);
        INSERT INTO map_mainline_group VALUES
            (1, 10, '2016-01', '2017-01'),
            (1, 20, '2017-01', NULL);
        INSERT INTO dim_carrier VALUES (1, 'C1'), (10, 'P1'), (20, 'P2');
    """)
    return c


def test_a_gap_free_handoff_does_not_resume_the_child_series():
    """Catches: dropping the NOT EXISTS on `rolls_out`. Carrier 1 moves straight from parent 10
    to parent 20 at 2017-01, so its own series never resumes there."""
    rows = {(s, m, o, k) for s, m, o, _c, k in _steps(_synthetic(), "2015-01", "2026-06")}
    assert (1, "2017-01", 10, "rolls_out") not in rows
    assert (1, "2017-01", 20, "rolls_up") in rows
    assert (10, "2017-01", 1, "leaves") in rows
    assert (20, "2017-01", 1, "joins") in rows


def test_rows_are_ordered():
    """Catches: dropping ORDER BY (the page lists steps in this order)."""
    got = _steps(_synthetic(), "2015-01", "2026-06")
    assert got == sorted(got, key=lambda r: (r[0], r[1], r[4], r[2]))
