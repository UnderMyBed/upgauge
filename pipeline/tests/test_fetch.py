"""Tests for the BTS fetcher.

The HTML fixture is the *real* DL_SelectFields form captured from transtats.bts.gov
(2026-07-29), not a synthetic stand-in — a hand-written fixture would only prove the parser
handles HTML I invented.

Network is exercised through httpx.MockTransport so the request BTS would actually receive
is asserted on, rather than asserting on a mock's call log.
"""

from __future__ import annotations

import datetime as dt
import json
import zipfile
from io import BytesIO
from pathlib import Path

import httpx
import pytest

from pipeline.fetch import (
    CONTROL_CHECKBOXES,
    T100D_SEGMENT_US,
    BtsFetcher,
    NotAZipError,
    ShortResponseError,
    ViewStateError,
    build_download_payload,
    fetch_year,
    parse_data_fields,
    parse_hidden_fields,
)

FIXTURE = Path(__file__).parent / "fixtures" / "dl_selectfields_form.html"

#: BTS regenerates this per request — it is deliberately NOT the cache key.
SERVED_NAME = "T_T100D_SEGMENT_US_CARRIER_ONLY_20260729_135257.zip"


@pytest.fixture
def form_html() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def _zip_bytes(name: str = "T_T100D_SEGMENT_US_CARRIER_ONLY.csv", body: bytes = b"x" * 5000):
    """A plausible-sized zip. Stored, not deflated — 5000 identical bytes would compress to
    ~30, landing under the truncation threshold and passing that test for the wrong reason.
    """
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr(name, body)
    return buf.getvalue()


# --------------------------------------------------------------------------- parsing


def test_parse_hidden_fields_extracts_the_aspnet_triple(form_html):
    hidden = parse_hidden_fields(form_html)
    assert set(hidden) >= {"__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"}
    assert len(hidden["__VIEWSTATE"]) > 1000  # real viewstate is ~5KB
    assert len(hidden["__EVENTVALIDATION"]) > 1000


def test_parse_hidden_fields_raises_when_viewstate_missing():
    """A page without viewstate means BTS changed the form — fail loudly, don't POST junk."""
    with pytest.raises(ViewStateError, match="__VIEWSTATE"):
        parse_hidden_fields("<form id='form1'><input name='cboYear'></form>")


def test_parse_data_fields_returns_the_45_data_columns(form_html):
    fields = parse_data_fields(form_html)
    assert len(fields) == 45, "BTS changed the field list — invariants depend on this count"


def test_parse_data_fields_excludes_control_checkboxes(form_html):
    fields = parse_data_fields(form_html)
    assert CONTROL_CHECKBOXES.isdisjoint(fields)


def test_parse_data_fields_includes_the_columns_the_invariants_depend_on(form_html):
    """These are the ones not in BTS's default selection — see docs/data/invariants.md."""
    fields = set(parse_data_fields(form_html))
    assert {
        "AIRLINE_ID",
        "ORIGIN_AIRPORT_ID",
        "ORIGIN_AIRPORT_SEQ_ID",
        "DEST_AIRPORT_SEQ_ID",
        "ORIGIN_CITY_MARKET_ID",
        "DEST_CITY_MARKET_ID",
        "AIRCRAFT_CONFIG",
        "CLASS",
    } <= fields


# --------------------------------------------------------------------------- payload


def test_build_download_payload_requests_a_whole_year(form_html):
    payload = dict(
        build_download_payload(parse_hidden_fields(form_html), ["SEATS", "CLASS"], year=2015)
    )
    assert payload["cboYear"] == "2015"
    assert payload["cboPeriod"] == "All", "per-year pull is 12 requests, not 144"
    assert payload["cboGeography"] == "All"


def test_build_download_payload_asks_for_a_zip_and_submits(form_html):
    payload = dict(build_download_payload(parse_hidden_fields(form_html), ["SEATS"], year=2015))
    assert payload["chkDownloadZip"] == "on"
    assert payload["btnDownload"] == "Download"


def test_build_download_payload_turns_on_every_requested_field(form_html):
    fields = parse_data_fields(form_html)
    payload = dict(build_download_payload(parse_hidden_fields(form_html), fields, year=2015))
    for field in fields:
        assert payload[field] == "on", f"{field} not requested"


# --------------------------------------------------------------------------- download


def _fetcher(handler) -> BtsFetcher:
    return BtsFetcher(client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_download_year_returns_zip_bytes(form_html):
    payload = _zip_bytes()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(
            200,
            content=payload,
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": f"attachment; filename={SERVED_NAME}",
            },
        )

    body, filename = _fetcher(handler).download_year(T100D_SEGMENT_US, 2015)
    assert body == payload
    assert filename == SERVED_NAME


def test_download_year_posts_the_viewstate_it_was_given(form_html):
    """The POST must echo back the viewstate from the GET, or BTS rejects it."""
    seen = {}
    expected = parse_hidden_fields(form_html)["__VIEWSTATE"]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        seen["body"] = request.content.decode()
        return httpx.Response(
            200, content=_zip_bytes(), headers={"Content-Type": "application/zip"}
        )

    _fetcher(handler).download_year(T100D_SEGMENT_US, 2015)
    from urllib.parse import parse_qs

    assert parse_qs(seen["body"])["__VIEWSTATE"] == [expected]


def test_download_year_rejects_an_html_error_page(form_html):
    """BTS returns 200 + HTML when the form is unhappy. That must not become a .zip."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(200, text="<html>Server Error</html>")

    with pytest.raises(NotAZipError):
        _fetcher(handler).download_year(T100D_SEGMENT_US, 2015)


def test_download_year_rejects_a_truncated_response(form_html):
    """A short zip means a partial write. Fail loudly rather than caching a bad year."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(
            200, content=b"PK\x03\x04tiny", headers={"Content-Type": "application/zip"}
        )

    with pytest.raises(ShortResponseError):
        _fetcher(handler).download_year(T100D_SEGMENT_US, 2015)


def test_download_year_retries_then_succeeds(form_html):
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(503)
        return httpx.Response(
            200, content=_zip_bytes(), headers={"Content-Type": "application/zip"}
        )

    body, _ = _fetcher(handler).download_year(T100D_SEGMENT_US, 2015, retries=3, backoff=0)
    assert body[:2] == b"PK"
    assert attempts["n"] == 3


def test_download_year_gives_up_after_retries(form_html):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(503)

    with pytest.raises(httpx.HTTPStatusError):
        _fetcher(handler).download_year(T100D_SEGMENT_US, 2015, retries=2, backoff=0)


# --------------------------------------------------------------------------- caching


def test_fetch_year_writes_zip_and_sidecar(tmp_path, form_html):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(
            200,
            content=_zip_bytes(),
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": f"attachment; filename={SERVED_NAME}",
            },
        )

    path = fetch_year(_fetcher(handler), T100D_SEGMENT_US, 2015, tmp_path)
    assert path.exists() and path.suffix == ".zip"
    meta = json.loads(path.with_suffix(".json").read_text())
    assert meta["year"] == 2015
    assert meta["served_filename"] == SERVED_NAME
    # download_date drives amended-filing resolution — see docs/data/invariants.md
    dt.date.fromisoformat(meta["download_date"])


def test_fetch_year_is_a_no_op_when_cached(tmp_path, form_html):
    """Re-running ingest must not re-hit BTS. Cache key is (table, year), not the
    served filename, which BTS regenerates per request."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(
            200, content=_zip_bytes(), headers={"Content-Type": "application/zip"}
        )

    first = fetch_year(_fetcher(handler), T100D_SEGMENT_US, 2015, tmp_path)
    after_first = calls["n"]
    second = fetch_year(_fetcher(handler), T100D_SEGMENT_US, 2015, tmp_path)

    assert first == second
    assert calls["n"] == after_first, "cached year still hit the network"


def test_fetch_year_refetches_when_forced(tmp_path, form_html):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(
            200, content=_zip_bytes(), headers={"Content-Type": "application/zip"}
        )

    fetch_year(_fetcher(handler), T100D_SEGMENT_US, 2015, tmp_path)
    baseline = calls["n"]
    fetch_year(_fetcher(handler), T100D_SEGMENT_US, 2015, tmp_path, force=True)
    assert calls["n"] > baseline


def test_fetch_year_does_not_leave_a_partial_file_on_failure(tmp_path, form_html):
    """A failed download must not poison the cache — next run has to retry it."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=form_html)
        return httpx.Response(200, text="<html>Server Error</html>")

    with pytest.raises(NotAZipError):
        fetch_year(_fetcher(handler), T100D_SEGMENT_US, 2015, tmp_path)
    assert list(tmp_path.glob("*.zip")) == []
