"""The permalink contract.

Once links are in forum posts, changing the format breaks them and nobody reports it. So the
encoding is frozen, versioned, and decode is TOTAL: an unknown key or an unallowlisted
dimension is a rejection, never a silent drop to a default. A permalink that quietly renders
a different query than it encodes still screenshots as authoritative.
"""

from __future__ import annotations

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.pivot import PivotQuery
from pipeline.tests.test_marts import _warehouse
from pipeline.urlstate import URL_VERSION, UrlStateError, decode, encode


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("urlstate")
    db = tmp_path / "u.duckdb"
    build_database(_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


def q(**kw):
    base = dict(grain="segment", dimensions=("year_month", "op_airline_id"),
                measures=("seats", "load_factor"), time_from="2015-01", time_to="2015-12")
    base.update(kw)
    return PivotQuery(**base)


def test_state_url_state_round_trip(con):
    original = q(sort="seats", sort_desc=True, limit=25)
    assert decode(encode(original), con) == original


def test_url_state_url_round_trip(con):
    url = encode(q())
    assert encode(decode(url, con)) == url


def test_keys_are_short_and_readable(con):
    url = encode(q())
    assert url.startswith(f"v={URL_VERSION}")
    assert "d=year_month,op_airline_id" in url
    assert "base64" not in url


def test_unknown_key_is_rejected_not_ignored(con):
    with pytest.raises(UrlStateError, match="unknown"):
        decode(encode(q()) + "&zz=1", con)


def test_unallowlisted_dimension_is_rejected(con):
    with pytest.raises(UrlStateError):
        decode("v=1&k=seg&d=not_a_dim&m=seats&t=2015-01:2015-12", con)


def test_missing_version_is_rejected(con):
    with pytest.raises(UrlStateError, match="version"):
        decode("k=seg&d=year_month&m=seats&t=2015-01:2015-12", con)


def test_future_version_is_rejected(con):
    with pytest.raises(UrlStateError, match="version"):
        decode("v=99&k=seg&d=year_month&m=seats&t=2015-01:2015-12", con)


def test_filters_round_trip_with_multiple_values(con):
    original = q(filters=(("origin_airport_id", ("14771", "13487")),))
    assert decode(encode(original), con) == original


def test_sort_direction_round_trips(con):
    asc = q(sort="seats", sort_desc=False)
    assert "s=seats" in encode(asc)
    assert decode(encode(asc), con).sort_desc is False
    desc = q(sort="seats", sort_desc=True)
    assert "s=-seats" in encode(desc)


def test_filter_values_with_reserved_characters_round_trip(con):
    """A filter value is user/attacker-controlled free text, not an allowlisted identifier.
    ',' is our own inter-value delimiter, '&' is the inter-pair delimiter, and '%' is the
    escape character itself -- a value containing any of them must not corrupt the delimiter
    structure or silently reparse into the wrong number of values."""
    original = q(filters=(("origin_airport_id", ("14,771", "13&487", "9%5", "13487")),))
    assert decode(encode(original), con) == original


def test_route_grain_round_trips(con):
    original = q(grain="route")
    assert decode(encode(original), con) == original


def test_mainline_grouping_round_trips(con):
    """The whole reason the mainline-group toggle (Task 5) exists: a permalink with
    grouping='mainline' must not silently decode back to the 'operating' default -- that is
    precisely a permalink rendering a different query than the one it encodes."""
    original = q(grouping="mainline")
    assert decode(encode(original), con) == original


def test_duplicate_non_f_key_is_rejected(con):
    """A duplicate non-'f' key is not something `encode` ever produces, so it is as
    illegitimate as an unknown key -- last-wins would silently prefer one of two
    contradictory values instead of rejecting the malformed link."""
    with pytest.raises(UrlStateError, match="duplicate"):
        decode(encode(q()) + "&d=op_airline_id", con)
