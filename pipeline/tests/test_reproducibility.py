"""The M1 reproducibility gate.

Two guarantees, and they depend on each other:

1. **`data/raw/` is append-only.** Re-fetching a year must not overwrite the previous
   download — that is the audit trail, and BTS silently amends filings.
2. **Rebuilds are deterministic.** The same raw inputs must produce the same Parquet, and
   when several downloads exist for one year the *latest* must win, reproducibly.

Without (1), (2) is untestable: there is nothing to resolve between.
"""

from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path

import duckdb
import httpx
import pytest

from pipeline.fetch import T100D_SEGMENT_US, BtsFetcher, fetch_year, find_raw, latest_raw, raw_path
from pipeline.normalize import discover_raw_years, normalize_year

FIXTURE = Path(__file__).parent / "fixtures" / "t100d_segment_sample_2015.zip"


def _fetcher(payload: bytes):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200,
                text=(Path(__file__).parent / "fixtures" / "dl_selectfields_form.html").read_text(),
            )
        return httpx.Response(200, content=payload, headers={"Content-Type": "application/zip"})

    return BtsFetcher(client=httpx.Client(transport=httpx.MockTransport(handler)))


def _zip_with(seats: str) -> bytes:
    """The fixture, with every SEATS value replaced — stands in for an amended filing."""
    with zipfile.ZipFile(FIXTURE) as z:
        name = next(n for n in z.namelist() if "Documentation" not in n)
        reader = csv.DictReader(io.StringIO(z.read(name).decode()))
        fields = reader.fieldnames
        rows = list(reader)
    for row in rows:
        if float(row["SEATS"] or 0) > 0:
            row["SEATS"] = seats
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields)
    w.writeheader()
    w.writerows(rows)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        z.writestr(name, buf.getvalue())
    return out.getvalue()


# ------------------------------------------------------- data/raw is append-only


def test_raw_filename_carries_the_download_date(tmp_path):
    """Without a date in the name there is nowhere to keep the previous download."""
    path = raw_path(tmp_path, T100D_SEGMENT_US, 2015, "2026-07-29")
    assert path.name == "t100d_segment_us_2015_20260729.zip"


def test_a_cached_year_is_not_refetched(tmp_path):
    """Cache detection must work across dates, not require an exact filename match."""
    fetch_year(_fetcher(_zip_with("100")), T100D_SEGMENT_US, 2015, tmp_path)
    before = sorted(p.name for p in tmp_path.glob("*.zip"))
    fetch_year(_fetcher(_zip_with("999")), T100D_SEGMENT_US, 2015, tmp_path)
    assert sorted(p.name for p in tmp_path.glob("*.zip")) == before


def test_forcing_a_refetch_retains_the_previous_download(tmp_path, monkeypatch):
    """The audit-trail invariant: re-fetching must never overwrite `data/raw/`."""
    import datetime as dt

    class Day1(dt.date):
        @classmethod
        def today(cls):
            return dt.date(2026, 7, 29)

    class Day2(dt.date):
        @classmethod
        def today(cls):
            return dt.date(2026, 9, 1)

    monkeypatch.setattr("pipeline.fetch.dt.date", Day1)
    fetch_year(_fetcher(_zip_with("100")), T100D_SEGMENT_US, 2015, tmp_path)
    monkeypatch.setattr("pipeline.fetch.dt.date", Day2)
    fetch_year(_fetcher(_zip_with("999")), T100D_SEGMENT_US, 2015, tmp_path, force=True)

    kept = sorted(p.name for p in tmp_path.glob("*.zip"))
    assert len(kept) == 2, f"prior download was destroyed: {kept}"
    assert "t100d_segment_us_2015_20260729.zip" in kept
    assert "t100d_segment_us_2015_20260901.zip" in kept


def test_find_raw_returns_every_download_oldest_first(tmp_path):
    for date in ("2026-07-29", "2026-09-01", "2026-08-15"):
        raw_path(tmp_path, T100D_SEGMENT_US, 2015, date).write_bytes(b"PK")
    found = [p.name for p in find_raw(tmp_path, T100D_SEGMENT_US, 2015)]
    assert found == [
        "t100d_segment_us_2015_20260729.zip",
        "t100d_segment_us_2015_20260815.zip",
        "t100d_segment_us_2015_20260901.zip",
    ]


def test_latest_raw_picks_the_newest_download(tmp_path):
    for date in ("2026-07-29", "2026-09-01", "2026-08-15"):
        raw_path(tmp_path, T100D_SEGMENT_US, 2015, date).write_bytes(b"PK")
    assert latest_raw(tmp_path, T100D_SEGMENT_US, 2015).name.endswith("20260901.zip")


def test_latest_raw_is_none_when_nothing_is_cached(tmp_path):
    assert latest_raw(tmp_path, T100D_SEGMENT_US, 2015) is None


def test_discovery_still_finds_years_with_dated_filenames(tmp_path):
    for year in (2015, 2016):
        raw_path(tmp_path, T100D_SEGMENT_US, year, "2026-07-29").write_bytes(b"PK")
    raw_path(tmp_path, T100D_SEGMENT_US, 2016, "2026-09-01").write_bytes(b"PK")
    assert discover_raw_years(tmp_path) == [2015, 2016], "a year must be listed once"


# ------------------------------------------------------- amended filings


def test_the_latest_download_wins(tmp_path):
    """The documented resolution rule, exercised through the real pipeline."""
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    raw.mkdir()
    for date, seats in (("2026-07-29", "100"), ("2026-09-01", "222")):
        p = raw_path(raw, T100D_SEGMENT_US, 2015, date)
        p.write_bytes(_zip_with(seats))
        p.with_suffix(".json").write_text(f'{{"download_date": "{date}"}}')

    normalize_year(latest_raw(raw, T100D_SEGMENT_US, 2015), out, 2015)
    con = duckdb.connect()
    seats = con.execute(
        f"SELECT DISTINCT seats FROM read_parquet('{out}/**/*.parquet') WHERE seats > 0"
    ).fetchall()
    assert seats == [(222.0,)], "the older download won"


def test_the_superseded_download_is_still_on_disk(tmp_path):
    """Audit-only, never feeding a mart — but never deleted either."""
    raw = tmp_path / "raw"
    raw.mkdir()
    for date in ("2026-07-29", "2026-09-01"):
        raw_path(raw, T100D_SEGMENT_US, 2015, date).write_bytes(_zip_with("100"))
    assert len(find_raw(raw, T100D_SEGMENT_US, 2015)) == 2


def test_stamped_download_date_matches_the_winning_file(tmp_path):
    """So a reader can tell which download produced the numbers they are looking at."""
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    raw.mkdir()
    for date, seats in (("2026-07-29", "100"), ("2026-09-01", "222")):
        p = raw_path(raw, T100D_SEGMENT_US, 2015, date)
        p.write_bytes(_zip_with(seats))
        p.with_suffix(".json").write_text(f'{{"download_date": "{date}"}}')

    normalize_year(latest_raw(raw, T100D_SEGMENT_US, 2015), out, 2015)
    con = duckdb.connect()
    stamped = con.execute(
        f"SELECT DISTINCT download_date FROM read_parquet('{out}/**/*.parquet')"
    ).fetchall()
    assert [str(r[0]) for r in stamped] == ["2026-09-01"]


# ------------------------------------------------------- determinism


def test_two_builds_from_the_same_raw_are_identical(tmp_path):
    """M2 requires a from-scratch rebuild to be reproducible."""
    raw = tmp_path / "raw"
    raw.mkdir()
    p = raw_path(raw, T100D_SEGMENT_US, 2015, "2026-07-29")
    p.write_bytes(FIXTURE.read_bytes())
    p.with_suffix(".json").write_text('{"download_date": "2026-07-29"}')

    a, b = tmp_path / "a", tmp_path / "b"
    normalize_year(p, a, 2015)
    normalize_year(p, b, 2015)

    con = duckdb.connect()
    diff = con.execute(
        f"""SELECT count(*) FROM (
                SELECT * FROM read_parquet('{a}/**/*.parquet')
                EXCEPT ALL
                SELECT * FROM read_parquet('{b}/**/*.parquet'))"""
    ).fetchone()[0]
    assert diff == 0


def test_rebuilt_parquet_is_byte_identical(tmp_path):
    """Stronger than set equality: the bytes must match, so artifacts are cacheable and a
    rebuild is verifiably a no-op."""
    raw = tmp_path / "raw"
    raw.mkdir()
    p = raw_path(raw, T100D_SEGMENT_US, 2015, "2026-07-29")
    p.write_bytes(FIXTURE.read_bytes())
    p.with_suffix(".json").write_text('{"download_date": "2026-07-29"}')

    first = tmp_path / "a"
    second = tmp_path / "b"
    normalize_year(p, first, 2015)
    normalize_year(p, second, 2015)
    a = (first / "year=2015" / "part.parquet").read_bytes()
    b = (second / "year=2015" / "part.parquet").read_bytes()
    assert a == b, "Parquet output is not byte-stable across runs"


def test_a_rebuild_over_an_existing_partition_is_byte_identical(tmp_path):
    """Re-running ingest in place must converge, not drift."""
    raw, out = tmp_path / "raw", tmp_path / "parquet"
    raw.mkdir()
    p = raw_path(raw, T100D_SEGMENT_US, 2015, "2026-07-29")
    p.write_bytes(FIXTURE.read_bytes())
    p.with_suffix(".json").write_text('{"download_date": "2026-07-29"}')

    normalize_year(p, out, 2015)
    before = (out / "year=2015" / "part.parquet").read_bytes()
    normalize_year(p, out, 2015)
    after = (out / "year=2015" / "part.parquet").read_bytes()
    assert before == after


# ------------------------------------------------------- parallel-writer drift


REAL_EXTRACT = next(iter(sorted(Path("data/raw").glob("t100d_segment_us_*_*.zip"))), None)


@pytest.mark.skipif(
    REAL_EXTRACT is None, reason="no real extract in data/raw — run `make fetch --end 2015`"
)
def test_parquet_is_byte_identical_on_a_real_extract(tmp_path):
    """The real reproducibility guarantee, on data with realistic cardinality.

    A synthetic fixture cannot detect this: repeating a handful of rows keeps cardinality low
    enough that the encoder stays deterministic regardless of threading. Only real data with
    ~280k distinct-ish rows across several row groups exposes thread-dependent output — which
    is why the small-fixture byte test passed while `make verify` failed.
    """
    con = duckdb.connect()

    # Repeated on purpose: the drift is intermittent (observed SAME, DIFFER, DIFFER across
    # three runs of the identical operation), so a single comparison passes by luck.
    for attempt in range(4):
        a, b = tmp_path / f"a{attempt}", tmp_path / f"b{attempt}"
        normalize_year(REAL_EXTRACT, a, 2015)
        normalize_year(REAL_EXTRACT, b, 2015)

        if attempt == 0:
            groups = con.execute(
                f"SELECT max(row_group_id) + 1 FROM parquet_metadata('{a}/year=2015/part.parquet')"
            ).fetchone()[0]
            assert groups > 1, f"only {groups} row group — cannot detect writer drift"

        first = (a / "year=2015" / "part.parquet").read_bytes()
        second = (b / "year=2015" / "part.parquet").read_bytes()
        assert first == second, f"Parquet output is thread-dependent (attempt {attempt})"
