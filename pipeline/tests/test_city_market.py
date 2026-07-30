"""dim_city_market -- the dimension that makes city_market_id legible.

The collapse has the same shape of trap as dim_carrier: the source is keyed by a
point-in-time seq id, and picking the wrong row surfaces a dead name.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from pipeline.dims import build_city_market_dim

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def dim(tmp_path):
    path = build_city_market_dim(FIXTURES / "master_coordinate_sample.zip", tmp_path)
    return duckdb.connect(), path


def test_one_row_per_city_market_id(dim):
    con, path = dim
    dupes = con.execute(
        "SELECT count(*) FROM (SELECT city_market_id FROM read_parquet(?) "
        "GROUP BY 1 HAVING count(*) > 1)",
        [str(path)],
    ).fetchone()[0]
    assert dupes == 0


def test_names_are_never_null_or_blank(dim):
    con, path = dim
    bad = con.execute(
        "SELECT count(*) FROM read_parquet(?) WHERE name IS NULL OR trim(name) = ''",
        [str(path)],
    ).fetchone()[0]
    assert bad == 0


def test_city_market_id_is_an_integer(dim):
    """Unlike airport/aircraft codes, city market ids are true integers and are keyed on."""
    con, path = dim
    described = con.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]).fetchall()
    types = {r[0]: r[1] for r in described}
    assert types["city_market_id"] == "INTEGER"


def test_ties_resolve_to_the_highest_seq_id(dim):
    """Market 30973 (CGQ) has two latest-airport rows with different names:
    seq 3097301 'Changchun, China' and seq 3097302 'Changchun\\Jilin City, China'.
    A nondeterministic pick would drift between builds and break the byte-identical gate."""
    con, path = dim
    row = con.execute(
        "SELECT name FROM read_parquet(?) WHERE city_market_id = 30973", [str(path)]
    ).fetchone()
    if row is not None:  # present only if the fixture carries CGQ
        assert row[0] == "Changchun\\Jilin City, China"


def test_build_is_byte_identical_across_runs(tmp_path):
    """Same gate as every other artifact: the collapse must be deterministic."""
    import hashlib

    digests = []
    for name in ("a", "b", "c"):
        out = tmp_path / name
        p = build_city_market_dim(FIXTURES / "master_coordinate_sample.zip", out)
        digests.append(hashlib.sha256(p.read_bytes()).hexdigest())
    assert len(set(digests)) == 1, digests


# `master_coordinate_sample.zip` (82 rows) does not contain market 30973/CGQ, so
# test_ties_resolve_to_the_highest_seq_id above no-ops on it and proves nothing on its own.
# This proves the tiebreak against the real extract instead. Same skip pattern as
# test_invariants_against_real_data.py: green on a fresh clone/CI, load-bearing locally
# after `make fetch-reference`.
RAW_DIR = Path("data/raw")

try:
    from pipeline.fetch import latest_raw
    from pipeline.lookups import MASTER_COORDINATE

    _REAL_MASTER_CORD = latest_raw(RAW_DIR, MASTER_COORDINATE)
except Exception:  # pragma: no cover -- absent raw dir, missing module, etc.
    _REAL_MASTER_CORD = None


@pytest.mark.skipif(
    _REAL_MASTER_CORD is None,
    reason=f"no Master Coordinate download in {RAW_DIR} — run `make fetch-reference`",
)
def test_real_data_ties_resolve_to_the_highest_seq_id(tmp_path):
    """Market 30973 (CGQ) genuinely has two AIRPORT_IS_LATEST='1' rows in the real extract:
    seq 3097301 'Changchun, China' and seq 3097302 'Changchun\\Jilin City, China'. This is
    the one ambiguity the max(seq_id) tiebreak exists for -- unlike the fixture test above,
    this one can actually fail."""
    path = build_city_market_dim(_REAL_MASTER_CORD, tmp_path)
    con = duckdb.connect()
    row = con.execute(
        "SELECT name FROM read_parquet(?) WHERE city_market_id = 30973", [str(path)]
    ).fetchone()
    assert row is not None, "expected market 30973 in the real extract"
    assert row[0] == "Changchun\\Jilin City, China"


def test_real_data_has_the_documented_market_count(tmp_path):
    """6,177 distinct CITY_MARKET_IDs, measured on master_coordinate_20260729 — the number
    the SQL header and docs/data/model.md both cite."""
    if _REAL_MASTER_CORD is None:
        pytest.skip(f"no Master Coordinate download in {RAW_DIR} — run `make fetch-reference`")
    path = build_city_market_dim(_REAL_MASTER_CORD, tmp_path)
    con = duckdb.connect()
    n = con.execute("SELECT count(*) FROM read_parquet(?)", [str(path)]).fetchone()[0]
    assert n == 6_177
