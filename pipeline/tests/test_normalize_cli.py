"""Tests for the normalize CLI.

The single-year path is covered in test_normalize.py; what matters here is that the CLI
discovers the right raw years and refuses to look successful when a year fails.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from pipeline.normalize import discover_raw_years, main

FIXTURE = Path(__file__).parent / "fixtures" / "t100d_segment_sample_2015.zip"


def _stage(raw_dir: Path, *years: int) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    for year in years:
        shutil.copy(FIXTURE, raw_dir / f"t100d_segment_us_{year}.zip")
        shutil.copy(FIXTURE.with_suffix(".json"), raw_dir / f"t100d_segment_us_{year}.json")


def test_discovers_years_from_cached_zips(tmp_path):
    _stage(tmp_path, 2019, 2015, 2021)
    assert discover_raw_years(tmp_path) == [2015, 2019, 2021], "must be sorted"


def test_discovery_ignores_sidecars_and_other_files(tmp_path):
    _stage(tmp_path, 2015)
    (tmp_path / "notes.txt").write_text("x")
    (tmp_path / "t100d_segment_us_bogus.zip").write_bytes(b"PK")
    assert discover_raw_years(tmp_path) == [2015]


def test_discovery_on_an_empty_dir_is_empty_not_an_error(tmp_path):
    assert discover_raw_years(tmp_path) == []


def test_main_normalizes_every_discovered_year(tmp_path):
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    _stage(raw, 2015, 2016)
    assert main(["--raw-dir", str(raw), "--out-dir", str(out)]) == 0
    assert (out / "year=2015").exists()
    assert (out / "year=2016").exists()


def test_main_fails_when_there_is_nothing_to_normalize(tmp_path):
    """An empty data/raw means the fetch never ran. Silence would look like success."""
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    raw.mkdir(parents=True)
    assert main(["--raw-dir", str(raw), "--out-dir", str(out)]) == 1


def test_main_reports_failure_and_still_processes_other_years(tmp_path):
    """One bad year must not abort the rest, and must not exit 0."""
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    _stage(raw, 2015)
    (raw / "t100d_segment_us_2016.zip").write_bytes(b"PK\x03\x04 not a real zip")
    (raw / "t100d_segment_us_2016.json").write_text('{"download_date": "2026-07-29"}')

    assert main(["--raw-dir", str(raw), "--out-dir", str(out)]) == 1
    assert (out / "year=2015").exists(), "the good year should still have been written"
    assert not (out / "year=2016").exists()


def test_main_names_the_failed_years_in_its_output(tmp_path, caplog):
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    _stage(raw, 2015)
    (raw / "t100d_segment_us_2016.zip").write_bytes(b"not a zip")
    (raw / "t100d_segment_us_2016.json").write_text('{"download_date": "2026-07-29"}')

    with caplog.at_level("ERROR"):
        main(["--raw-dir", str(raw), "--out-dir", str(out)])
    assert "2016" in caplog.text


@pytest.mark.parametrize("year", [2015, 2016])
def test_main_accepts_an_explicit_year_filter(tmp_path, year):
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    _stage(raw, 2015, 2016)
    assert main(["--raw-dir", str(raw), "--out-dir", str(out), "--year", str(year)]) == 0
    assert (out / f"year={year}").exists()
    other = 2016 if year == 2015 else 2015
    assert not (out / f"year={other}").exists()


def test_discovery_agrees_with_the_fetchers_naming(tmp_path):
    """Discovery and the fetcher must not drift — a rename in one would silently orphan
    every cached year for the other."""
    from pipeline.fetch import T100D_SEGMENT_US, cache_path

    written = cache_path(tmp_path, T100D_SEGMENT_US, 2015)
    written.write_bytes(b"PK")
    assert discover_raw_years(tmp_path) == [2015]
