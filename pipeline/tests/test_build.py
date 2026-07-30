"""Tests for the full-warehouse build and its reproducibility gate.

`make verify` is the M1 exit criterion: build everything twice from the same raw inputs and
prove every artifact is byte-identical. If that ever fails, M2's "reproducible from scratch"
guarantee is already broken.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from pipeline.build import build_all, main, verify_reproducible
from pipeline.fetch import T100D_SEGMENT_US, raw_path
from pipeline.lookups import AIRCRAFT_TYPES, CARRIER_DECODE, MASTER_COORDINATE

FIXTURES = Path(__file__).parent / "fixtures"
DATE = "2026-07-29"


@pytest.fixture
def raw(tmp_path):
    """A raw dir staged with one fact year and all three reference tables."""
    d = tmp_path / "raw"
    d.mkdir()
    fact = raw_path(d, T100D_SEGMENT_US, 2015, DATE)
    shutil.copy(FIXTURES / "t100d_segment_sample_2015.zip", fact)
    shutil.copy(FIXTURES / "t100d_segment_sample_2015.json", fact.with_suffix(".json"))
    for table, stem in (
        (MASTER_COORDINATE, "master_coordinate_sample"),
        (CARRIER_DECODE, "carrier_decode_sample"),
        (AIRCRAFT_TYPES, "aircraft_types_sample"),
    ):
        dest = raw_path(d, table, None, DATE)
        shutil.copy(FIXTURES / f"{stem}.zip", dest)
        shutil.copy(FIXTURES / f"{stem}.json", dest.with_suffix(".json"))
    return d


def test_build_all_produces_facts_and_every_dim(raw, tmp_path):
    out = tmp_path / "parquet"
    written = build_all(raw, out)
    names = {p.name for p in written}
    assert "dim_airport.parquet" in names
    assert "dim_city_market.parquet" in names
    assert "dim_carrier.parquet" in names
    assert "dim_aircraft_type.parquet" in names
    assert "map_mainline_group.parquet" in names
    assert (out / "t100_segment" / "year=2015").exists()


def test_build_all_fails_when_a_reference_table_is_missing(raw, tmp_path):
    """A warehouse missing dim_carrier would silently orphan every carrier join."""
    next(raw.glob("carrier_decode_*.zip")).unlink()
    with pytest.raises(Exception, match="carrier_decode"):
        build_all(raw, tmp_path / "parquet")


def test_build_all_fails_when_there_are_no_fact_years(raw, tmp_path):
    for p in raw.glob("t100d_segment_us_*"):
        p.unlink()
    with pytest.raises(Exception, match="no fact years"):
        build_all(raw, tmp_path / "parquet")


def test_verify_reproducible_passes_on_a_clean_build(raw, tmp_path):
    """The M1 gate."""
    report = verify_reproducible(raw, tmp_path / "work")
    assert report.reproducible, report.differing
    assert report.artifacts > 0
    assert report.differing == []


def test_verify_reproducible_checks_every_artifact(raw, tmp_path):
    """Facts plus five dims — a gate that only checked one file would prove little."""
    report = verify_reproducible(raw, tmp_path / "work")
    assert report.artifacts >= 6


def test_verify_reproducible_reports_a_mismatch_rather_than_raising(raw, tmp_path, monkeypatch):
    """A drifting build must be reported with the offending artifact named."""
    import pipeline.build as build

    calls = {"n": 0}
    real = build.build_mainline_map

    def drifting(out_dir, csv_path=None):
        calls["n"] += 1
        path = real(out_dir, csv_path)
        if calls["n"] == 2:  # second build differs
            path.write_bytes(path.read_bytes() + b"\x00")
        return path

    monkeypatch.setattr(build, "build_mainline_map", drifting)
    report = verify_reproducible(raw, tmp_path / "work")
    assert not report.reproducible
    assert any("map_mainline_group" in name for name in report.differing)


def test_verify_command_fails_when_out_dir_disagrees_with_a_fresh_build_from_raw(
    raw, tmp_path, caplog
):
    """The two `make verify` gates must be linked: the Parquet gate proves two THROWAWAY
    builds from raw agree with each other, but that says nothing about whether the
    Parquet actually sitting at `--out-dir` (what `make build` and the database gate
    read) matches raw at all. A stale or fabricated `--out-dir` -- e.g. `make fetch`
    added a year and `make warehouse` was never re-run -- must fail the command, not
    report green.

    Demonstrated here with a fabricated extra partition that exists in no raw download:
    the two throwaway builds still agree with each other (they're both built fresh from
    the same raw), so without a link to `--out-dir` this would report green.
    """
    out_dir = tmp_path / "out"
    build_all(raw, out_dir)

    # Fabricate a partition present in out_dir but backed by no raw download. Schema must
    # stay compatible with the real fact partitions, or the database gate errors on the
    # read rather than silently passing -- copying a real partition's bytes under a new
    # partition directory is the cleanest way to get that, and mirrors how the reviewer
    # demonstrated the hole.
    real_partition = out_dir / "t100_segment" / "year=2015" / "part.parquet"
    fake_dir = out_dir / "t100_segment" / "year=2099"
    fake_dir.mkdir(parents=True)
    shutil.copy(real_partition, fake_dir / "part.parquet")

    with caplog.at_level("INFO"):
        rc = main(["--raw-dir", str(raw), "--out-dir", str(out_dir), "--verify"])

    assert rc != 0, "a fabricated out_dir partition must fail the gate, not pass it"
    assert "year=2099" in caplog.text
