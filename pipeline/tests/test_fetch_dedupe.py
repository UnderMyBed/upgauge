"""A forced re-fetch whose CONTENT is unchanged must not append a file.

`data/raw/` is append-only, and `make ingest` force-refetches the current year, the previous
year, and all three support tables on every run — so before this, every publisher run appended
five zips whether or not BTS had changed anything. Measured on the real `data/raw/` after two
consecutive days of publishing: **all five** 2026-08-08 downloads were byte-for-byte identical
in CSV content to their 2026-08-07 counterparts — 20.3 MB of a 162.4 MB tree, accrued in one
day, at roughly 20–28 MB per published month.

The digest is taken over the EXTRACTED DATA CSV, never the zip. Measured on
`aircraft_types_2026080{7,8}.zip`: identical member CRCs (`c78623da`) and identical sizes, but
different entry mtimes (`2026-08-08 01:18:58` vs `22:18:04`) and therefore different zip bytes.
A zip-level hash would report every re-download as new, forever.

This does NOT weaken the append-only rule. Nothing is overwritten and nothing is deleted; a
redundant download is simply never written, so the file that produced published numbers stays
exactly where it was — which is the point of the rule. When content DOES change, the new file
is appended as before and `latest_raw()` picks it up.
"""

from __future__ import annotations

import io
import types
import zipfile

import pytest

from pipeline import fetch, lookups
from pipeline.fetch import T100D_SEGMENT_US, latest_raw


def _zip(csv_body: bytes, *, member: str = "T_T100D_SEGMENT_US_CARRIER_ONLY.csv", mtime) -> bytes:
    """A BTS-shaped zip: one Documentation.csv plus exactly one data CSV."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("Documentation.csv", date_time=mtime), b"docs\n")
        z.writestr(zipfile.ZipInfo(member, date_time=mtime), csv_body)
    return buf.getvalue()


MTIME_A = (2026, 8, 7, 1, 18, 58)
MTIME_B = (2026, 8, 8, 22, 18, 4)


def test_same_content_different_mtime_is_a_different_zip_but_one_digest():
    """The premise. If this ever stops holding, dedupe is solving a problem that moved."""
    a = _zip(b"col\n1\n", mtime=MTIME_A)
    b = _zip(b"col\n1\n", mtime=MTIME_B)
    assert a != b, "zips are identical -- mtime no longer varies, so a byte hash would suffice"
    assert fetch.data_csv_digest(a) == fetch.data_csv_digest(b)


def test_changed_content_changes_the_digest():
    a = _zip(b"col\n1\n", mtime=MTIME_A)
    b = _zip(b"col\n2\n", mtime=MTIME_A)
    assert fetch.data_csv_digest(a) != fetch.data_csv_digest(b)


def test_digest_reads_a_path_and_bytes_identically():
    """`fetch_year` compares a freshly downloaded body against a file already on disk."""
    body = _zip(b"col\n1\n", mtime=MTIME_A)
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "x.zip"
        p.write_bytes(body)
        assert fetch.data_csv_digest(p) == fetch.data_csv_digest(body)


def test_documentation_csv_does_not_affect_the_digest():
    """Every BTS zip ships a Documentation.csv. If it were digested, a docs-only edit would
    look like a data change and defeat the dedupe."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("Documentation.csv", date_time=MTIME_A), b"DIFFERENT\n")
        z.writestr(
            zipfile.ZipInfo("T_T100D_SEGMENT_US_CARRIER_ONLY.csv", date_time=MTIME_A), b"col\n1\n"
        )
    assert fetch.data_csv_digest(buf.getvalue()) == fetch.data_csv_digest(
        _zip(b"col\n1\n", mtime=MTIME_A)
    )


def _stub_fetcher(monkeypatch, bodies):
    """Serve `bodies` in order, one per download_year call. Returns the call log."""
    calls = []

    def _download(self, table, year, retries=3, backoff=5.0):
        calls.append((table.slug, year))
        return bodies[len(calls) - 1], f"{table.slug}.zip"

    monkeypatch.setattr(fetch.BtsFetcher, "download_year", _download)
    return calls


def _on_day(monkeypatch, module, day: int):
    """Pin `module`'s idea of today to 2026-08-`day`.

    Load-bearing, and NOT ceremony. `raw_path` stamps the filename with the download date, so
    two fetches on the same simulated day resolve to the SAME path and the second simply
    overwrites the first. Every dedupe assertion below would then hold against an
    implementation that does no deduplication at all -- verified: before `data_csv_digest`
    existed, four of these tests passed. Distinguishing correct from buggy requires the two
    downloads to land on different days, the way two publisher runs actually do.

    Rebinds only `module.dt`, never `datetime.date` itself, so nothing leaks past this test.
    """
    import datetime

    class _Date(datetime.date):
        @classmethod
        def today(cls):
            return datetime.date(2026, 8, day)

    ns = types.SimpleNamespace(date=_Date, datetime=datetime.datetime, timedelta=datetime.timedelta)
    monkeypatch.setattr(module, "dt", ns)


def test_a_forced_refetch_of_identical_content_writes_no_second_file(monkeypatch, tmp_path):
    same = b"HEADER\nrow\n"
    calls = _stub_fetcher(monkeypatch, [_zip(same, mtime=MTIME_A), _zip(same, mtime=MTIME_B)])
    fetcher = fetch.BtsFetcher()

    _on_day(monkeypatch, fetch, 7)
    first = fetch.fetch_year(fetcher, T100D_SEGMENT_US, 2025, tmp_path)
    _on_day(monkeypatch, fetch, 8)
    second = fetch.fetch_year(fetcher, T100D_SEGMENT_US, 2025, tmp_path, force=True)

    assert len(calls) == 2, "the re-fetch must still HAPPEN -- dedupe is about writing, not asking"
    assert "20260808" not in second.name, (
        "the second day's download was written -- content was identical, nothing to append"
    )
    assert second == first, "a content-identical re-fetch appended a second file"
    zips = sorted(p.name for p in tmp_path.glob("*.zip"))
    assert zips == [first.name], f"expected one retained zip, got {zips}"
    # The sidecar must not be orphaned or duplicated either.
    assert sorted(p.name for p in tmp_path.glob("*.json")) == [first.with_suffix(".json").name]


def test_a_forced_refetch_of_changed_content_still_appends(monkeypatch, tmp_path):
    """The dedupe must not swallow a real BTS revision -- that is the whole reason the last
    two years are force-refetched at all."""
    calls = _stub_fetcher(
        monkeypatch,
        [_zip(b"HEADER\nrow\n", mtime=MTIME_A), _zip(b"HEADER\nrow\nREVISED\n", mtime=MTIME_B)],
    )
    fetcher = fetch.BtsFetcher()

    _on_day(monkeypatch, fetch, 7)
    first = fetch.fetch_year(fetcher, T100D_SEGMENT_US, 2025, tmp_path)
    _on_day(monkeypatch, fetch, 8)
    second = fetch.fetch_year(fetcher, T100D_SEGMENT_US, 2025, tmp_path, force=True)

    assert len(calls) == 2
    assert second != first, "a genuine BTS revision was discarded as a duplicate"
    assert len(list(tmp_path.glob("*.zip"))) == 2
    assert latest_raw(tmp_path, T100D_SEGMENT_US, 2025) == second, (
        "latest_raw must resolve to the revision, not the superseded download"
    )


def test_latest_raw_still_resolves_after_a_deduped_refetch(monkeypatch, tmp_path):
    same = b"HEADER\nrow\n"
    _stub_fetcher(monkeypatch, [_zip(same, mtime=MTIME_A), _zip(same, mtime=MTIME_B)])
    fetcher = fetch.BtsFetcher()
    _on_day(monkeypatch, fetch, 7)
    first = fetch.fetch_year(fetcher, T100D_SEGMENT_US, 2025, tmp_path)
    _on_day(monkeypatch, fetch, 8)
    fetch.fetch_year(fetcher, T100D_SEGMENT_US, 2025, tmp_path, force=True)
    assert latest_raw(tmp_path, T100D_SEGMENT_US, 2025) == first


def test_support_tables_dedupe_too(monkeypatch, tmp_path):
    """`make ingest` forces all three support tables every run -- 0.8 MB a day unchecked."""
    table = lookups.SUPPORT_TABLES[0]
    same = b"CODE,NAME\n1,x\n"
    body_a = _zip(same, member=f"T_{table.slug.upper()}.csv", mtime=MTIME_A)
    body_b = _zip(same, member=f"T_{table.slug.upper()}.csv", mtime=MTIME_B)
    calls = _stub_fetcher(monkeypatch, [body_a, body_b])
    fetcher = fetch.BtsFetcher()

    _on_day(monkeypatch, lookups, 7)
    first = lookups.fetch_support_table(fetcher, table, tmp_path)
    _on_day(monkeypatch, lookups, 8)
    second = lookups.fetch_support_table(fetcher, table, tmp_path, force=True)

    assert len(calls) == 2
    assert "20260808" not in second.name, "the second day's support-table download was written"
    assert second == first, "a content-identical support-table re-fetch appended a second file"
    assert len(list(tmp_path.glob("*.zip"))) == 1


def test_an_unreadable_existing_download_does_not_block_the_new_one(monkeypatch, tmp_path):
    """A truncated file already on disk must not make every future ingest fail. It cannot be
    compared, so the new download is written -- the safe direction."""
    (tmp_path / "t100d_segment_us_2025_20260101.zip").write_bytes(b"PK\x03\x04 truncated")
    _stub_fetcher(monkeypatch, [_zip(b"HEADER\nrow\n", mtime=MTIME_A)])
    _on_day(monkeypatch, fetch, 8)
    written = fetch.fetch_year(fetch.BtsFetcher(), T100D_SEGMENT_US, 2025, tmp_path, force=True)
    assert written.name != "t100d_segment_us_2025_20260101.zip"
    assert written.exists()


def test_a_malformed_new_download_is_an_error_not_a_silent_skip():
    """A body that is not a BTS-shaped zip must raise rather than be treated as 'unchanged'."""
    with pytest.raises(fetch.NotAZipError):
        fetch.data_csv_digest(b"PK\x03\x04 not really a zip")
