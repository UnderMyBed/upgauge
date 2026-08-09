"""The generated reference-values artifact. This exists so an upstream BTS refresh produces
ONE readable diff instead of scattered assertion failures -- see
docs/superpowers/specs/2026-08-08-ci-and-tooling-foundation-design.md."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest

from pipeline.stats import STATS_PATH, collect

DB = Path("upgauge.duckdb")
pytestmark = pytest.mark.skipif(not DB.exists(), reason="no built catalog; run `make build`")

# This skip is legitimate (the catalog is a build artifact) but M1 shipped 12 real-data tests
# that skipped for FOUR MILESTONES because their guard was permanently false. After running,
# confirm from pytest's output that these PASSED, not SKIPPED.


@pytest.fixture(scope="module")
def con():
    return duckdb.connect(str(DB), read_only=True)


def test_generated_artifact_matches_the_live_warehouse(con):
    """The gate itself: if this fails, either the warehouse moved or someone hand-edited the
    artifact. Both must be loud."""
    assert STATS_PATH.exists(), "run `make stats`"
    committed = json.loads(STATS_PATH.read_text())
    assert committed["measures"] == collect(con)["measures"]


def test_collect_reports_the_shape_that_broke_on_the_2026_08_07_refresh(con):
    """Every key here names something a real BTS refresh moved. aircraft 699 was renamed
    'A321/LR' -> 'A321nXLR', which reddened 17 assertions while moving NO number; city markets
    went 6,177 -> 6,181. Absence of any of these keys means the artifact cannot see the drift
    class it exists to catch."""
    m = collect(con)["measures"]
    for key in (
        "max_year_month",
        "fact_rows",
        "quarantined_rows",
        "dim_airport_current",
        "dim_carrier_rows",
        "dim_aircraft_type_rows",
        "city_markets",
        "fact_present_aircraft_codes",
        "aircraft_short_names",
        "aircraft_slug_separators",
    ):
        assert key in m, f"missing measure: {key}"


def test_aircraft_short_names_are_sorted_and_carry_their_code(con):
    """A set rendered in nondeterministic order would diff spuriously on every run, which
    would train a reader to ignore the diff -- the exact failure this artifact prevents."""
    names = collect(con)["measures"]["aircraft_short_names"]
    codes = [row["code"] for row in names]
    assert codes == sorted(codes)
    assert {"code": "699", "short_name": "A321nXLR"} in names
