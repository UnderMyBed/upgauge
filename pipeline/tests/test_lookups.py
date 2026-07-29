"""Tests for the reference-table fetchers.

Two different BTS mechanisms, which is why there are two code paths:

- **Support tables** (Master Coordinate, Carrier Decode, AircraftTypes) live in DB 595 and
  come through the same `DL_SelectFields` form as T-100, but with no year/period selects and
  a *different subject param*. Getting that param wrong silently redirects to the BTS
  homepage rather than erroring.
- **Code lookups** (`L_SERVICE_CLASS`, ...) come from `Download_Lookup.asp` as plain
  two-column CSVs, using the other cipher.
"""

from __future__ import annotations

import httpx
import pytest

from pipeline.lookups import (
    AIRCRAFT_TYPES,
    AVIATION_SUPPORT_SUBJECT,
    CARRIER_DECODE,
    CODE_LOOKUPS,
    MASTER_COORDINATE,
    lookup_url,
    parse_code_lookup,
)

# ------------------------------------------------------- table identity


def test_support_tables_have_the_discovered_table_ids():
    """Discovered by decoding the DB 595 table list; not guessable."""
    assert MASTER_COORDINATE.table_id == 288
    assert CARRIER_DECODE.table_id == 304
    assert AIRCRAFT_TYPES.table_id == 300


def test_support_tables_use_the_aviation_support_subject():
    """A wrong subject param redirects to the homepage — a 200 with no form, not an error."""
    for table in (MASTER_COORDINATE, CARRIER_DECODE, AIRCRAFT_TYPES):
        assert table.subject == AVIATION_SUPPORT_SUBJECT


def test_the_subject_param_is_built_by_the_codec_not_hardcoded():
    """So a typo in a magic string can't silently break the fetch."""
    from pipeline.btscodec import encode_param

    assert encode_param("Aviation Support Tables") == AVIATION_SUPPORT_SUBJECT


def test_support_table_params_are_built_by_the_codec():
    from pipeline.btscodec import encode_param

    assert MASTER_COORDINATE.param == encode_param("288")
    assert CARRIER_DECODE.param == encode_param("304")
    assert AIRCRAFT_TYPES.param == encode_param("300")


def test_support_table_urls_carry_both_params():
    url = MASTER_COORDINATE.url
    assert f"gnoyr_VQ={MASTER_COORDINATE.param}" in url
    assert "QO_fu146_anzr=" in url


def test_t100_and_support_tables_use_different_subjects():
    """The bug this guards: reusing the Air Carriers subject for a DB 595 table."""
    from pipeline.fetch import T100D_SEGMENT_US

    assert T100D_SEGMENT_US.subject != AVIATION_SUPPORT_SUBJECT


# ------------------------------------------------------- code lookups


def test_code_lookup_urls_use_the_rot13_cipher():
    """Lookup names use plain ROT13, not the 36-char param cipher."""
    assert lookup_url("L_SERVICE_CLASS").endswith("Y11x72=Y_FREIVPR_PYNFF")


def test_the_lookups_we_depend_on_are_registered():
    assert {"L_SERVICE_CLASS", "L_AIRCRAFT_CONFIG", "L_AIRCRAFT_TYPE"} <= CODE_LOOKUPS


def test_parse_code_lookup_reads_a_two_column_csv():
    csv = (
        'Code,Description\n"F","Scheduled Passenger/ Cargo Service F"\n"G","Scheduled All Cargo"\n'
    )
    assert parse_code_lookup(csv) == {
        "F": "Scheduled Passenger/ Cargo Service F",
        "G": "Scheduled All Cargo",
    }


def test_parse_code_lookup_preserves_zero_padded_codes():
    """`079` is an aircraft type. Int-parsing it breaks the join to the fact table."""
    parsed = parse_code_lookup('Code,Description\n"079","Boeing 737-700"\n')
    assert "079" in parsed


def test_parse_code_lookup_rejects_an_html_error_page():
    """BTS answers 200 with HTML when a lookup name is wrong."""
    with pytest.raises(ValueError, match="not a lookup CSV"):
        parse_code_lookup("<html><head><title>Object moved</title></head></html>")


def test_parse_code_lookup_rejects_an_empty_body():
    with pytest.raises(ValueError, match="not a lookup CSV"):
        parse_code_lookup("")


# ------------------------------------------------------- fetching


def test_fetch_code_lookup_returns_parsed_codes():
    from pipeline.lookups import fetch_code_lookup

    body = 'Code,Description\n"1","Passenger Configuration"\n"2","Freight Configuration"\n'

    def handler(request: httpx.Request) -> httpx.Response:
        assert "Download_Lookup" in str(request.url)
        return httpx.Response(200, text=body)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert fetch_code_lookup("L_AIRCRAFT_CONFIG", client=client)["1"] == "Passenger Configuration"


def test_fetch_code_lookup_fails_loudly_on_a_redirect_to_the_homepage():
    """The failure mode a wrong cipher produces: 200, HTML, no error."""
    from pipeline.lookups import fetch_code_lookup

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html><h1>Object Moved</h1></html>")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError, match="not a lookup CSV"):
        fetch_code_lookup("L_AIRCRAFT_CONFIG", client=client)
