"""The date-ranged wholly-owned rollup.

An earlier draft of the spec assumed ownership held for the whole window and a flat
carrier→parent map would do. It does not: Alaska acquired Virgin America in 2016 and
Hawaiian in 2024, both in-window. See docs/data/carrier-model.md.

AIRLINE_IDs below were read out of real 2015 T-100 data, not looked up from memory.
"""

from __future__ import annotations

import pytest

from pipeline.mainline_map import (
    OverlapError,
    check_map_is_total,
    check_no_overlaps,
    load_mainline_map,
)

# Real DOT AIRLINE_IDs, observed in the 2015 extract.
DL, ENDEAVOR = 19790, 20363
AA, ENVOY, PSA, PIEDMONT = 19805, 20398, 20397, 20427
AS, HORIZON, HAWAIIAN, VIRGIN_AMERICA = 19930, 19687, 19690, 21171
UA = 19977
SKYWEST, REPUBLIC, MESA = 20304, 20452, 20378


@pytest.fixture
def mapping():
    return load_mainline_map()


# ------------------------------------------------------- the headline assertion


def test_hawaiian_does_not_roll_up_before_the_acquisition(mapping):
    """AAG acquired Hawaiian Holdings in Sept 2024. Aug 2024 is still independent."""
    assert mapping.parent_for(HAWAIIAN, "2024-08") is None


def test_hawaiian_rolls_up_from_the_acquisition_month(mapping):
    assert mapping.parent_for(HAWAIIAN, "2024-09") == AS


def test_hawaiian_still_rolls_up_later(mapping):
    assert mapping.parent_for(HAWAIIAN, "2026-01") == AS


def test_hawaiian_is_independent_at_the_window_start(mapping):
    """9 of the window's 11 years. A static map would get every one of them wrong."""
    assert mapping.parent_for(HAWAIIAN, "2015-01") is None


# ------------------------------------------------------- Virgin America, same shape


def test_virgin_america_does_not_roll_up_before_december_2016(mapping):
    assert mapping.parent_for(VIRGIN_AMERICA, "2016-11") is None


def test_virgin_america_rolls_up_from_december_2016(mapping):
    assert mapping.parent_for(VIRGIN_AMERICA, "2016-12") == AS


# ------------------------------------------------------- steady-state subsidiaries


@pytest.mark.parametrize(
    ("subsidiary", "parent"),
    [
        (ENDEAVOR, DL),
        (ENVOY, AA),
        (PSA, AA),
        (PIEDMONT, AA),
        (HORIZON, AS),
    ],
)
@pytest.mark.parametrize("month", ["2015-01", "2020-06", "2026-01"])
def test_wholly_owned_subsidiaries_roll_up_for_the_whole_window(mapping, subsidiary, parent, month):
    assert mapping.parent_for(subsidiary, month) == parent


# ------------------------------------------------------- exclusions


def test_united_gets_no_rollup(mapping):
    """United owns no subsidiary operators. This is why group-vs-group is apples-to-oranges."""
    assert mapping.parent_for(UA, "2020-06") is None


@pytest.mark.parametrize("shared", [SKYWEST, REPUBLIC, MESA])
@pytest.mark.parametrize("month", ["2015-01", "2020-06", "2026-01"])
def test_shared_regionals_are_never_rolled_up(mapping, shared, month):
    """They fly for several mainlines on the same day. No date range can fix that."""
    assert mapping.parent_for(shared, month) is None


def test_shared_regionals_are_absent_from_the_map_entirely(mapping):
    """Not merely unmapped — they must not appear, so a stray parent can't be added."""
    mapped = {e.airline_id for e in mapping.entries}
    assert mapped.isdisjoint({SKYWEST, REPUBLIC, MESA})


def test_a_mainline_is_never_its_own_subsidiary(mapping):
    parents = {e.parent_airline_id for e in mapping.entries}
    assert not any(e.airline_id in parents for e in mapping.entries), (
        "a parent is mapped as a child"
    )


# ------------------------------------------------------- structural checks


def test_the_shipped_map_has_no_overlapping_ranges(mapping):
    check_no_overlaps(mapping.entries)


def test_the_shipped_map_is_total(mapping):
    """Every (airline_id, month) resolves to exactly one parent, or to itself."""
    check_map_is_total(mapping.entries)


def test_overlapping_ranges_are_rejected():
    """Two parents for one month is unresolvable — a test failure, not a runtime tiebreak."""
    from pipeline.mainline_map import MapEntry

    entries = [
        MapEntry(
            airline_id=99, parent_airline_id=1, effective_from="2015-01", effective_to="2020-12"
        ),
        MapEntry(airline_id=99, parent_airline_id=2, effective_from="2018-01", effective_to=None),
    ]
    with pytest.raises(OverlapError, match="99"):
        check_no_overlaps(entries)


def test_adjacent_non_overlapping_ranges_are_fine():
    """A carrier legitimately changing parents at a clean boundary must pass."""
    from pipeline.mainline_map import MapEntry

    entries = [
        MapEntry(
            airline_id=99, parent_airline_id=1, effective_from="2015-01", effective_to="2017-12"
        ),
        MapEntry(airline_id=99, parent_airline_id=2, effective_from="2018-01", effective_to=None),
    ]
    check_no_overlaps(entries)


def test_every_entry_is_keyed_on_airline_id_not_letter_code(mapping):
    """Letter codes get reused; `VX` and `HA` are exactly the kind that do."""
    for entry in mapping.entries:
        assert isinstance(entry.airline_id, int)
        assert isinstance(entry.parent_airline_id, int)
