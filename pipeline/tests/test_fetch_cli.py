"""Tests for the ingest CLI's year planning.

The network path is covered in test_fetch.py; what matters here is that the CLI asks for
the right set of years and doesn't silently skip any.
"""

from __future__ import annotations

import datetime as dt

import pytest

from pipeline.fetch import WINDOW_START, plan_years


def test_plan_years_covers_the_window_through_today():
    years = plan_years(today=dt.date(2026, 7, 29))
    assert years[0] == WINDOW_START == 2015
    assert years[-1] == 2026
    assert years == list(range(2015, 2027)), "no gaps — a missing year is a silent hole"


def test_plan_years_accepts_an_explicit_range():
    assert plan_years(start=2019, end=2021) == [2019, 2020, 2021]


def test_plan_years_includes_covid_years():
    """2020-21 are in-window on purpose — the showcase for Death Watch, not a gap."""
    years = plan_years(today=dt.date(2026, 7, 29))
    assert 2020 in years and 2021 in years


def test_plan_years_rejects_a_start_before_the_window():
    """Widening the window is a product decision, not something a flag does quietly."""
    with pytest.raises(ValueError, match="2015"):
        plan_years(start=2010, end=2016)


def test_plan_years_rejects_an_inverted_range():
    with pytest.raises(ValueError, match="after"):
        plan_years(start=2020, end=2018)
