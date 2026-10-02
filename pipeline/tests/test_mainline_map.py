"""The date-ranged rollup: wholly-owned subsidiaries and exclusive contract carriers.

An earlier draft of the spec assumed ownership held for the whole window and a flat
carrier→parent map would do. It does not: Alaska acquired Virgin America in 2016 and
Hawaiian in 2024, both in-window. See docs/data/carrier-model.md.

AIRLINE_IDs below were read out of real 2015 T-100 data, not looked up from memory.
"""

from __future__ import annotations

import pytest

from pipeline.mainline_map import (
    BasisError,
    MapEntry,
    OverlapError,
    ParentChildError,
    UnsourcedContractError,
    check_bases,
    check_contract_sources,
    check_map_is_total,
    check_no_overlaps,
    check_parent_child_disjoint,
    load_mainline_map,
)

# Real DOT AIRLINE_IDs, observed in the 2015 extract.
DL, ENDEAVOR = 19790, 20363
AA, ENVOY, PSA, PIEDMONT = 19805, 20398, 20397, 20427
AS, HORIZON, HAWAIIAN, VIRGIN_AMERICA = 19930, 19687, 19690, 21171
UA = 19977
SKYWEST, REPUBLIC, MESA = 20304, 20452, 20378
COMMUTAIR, AIR_WISCONSIN, GOJET, EXPRESSJET = 20445, 20046, 20500, 20366
TRANS_STATES, EMPIRE, COMPASS = 20237, 20263, 21167


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


def test_virgin_america_rolls_up_through_its_last_month(mapping):
    """effective_to = '2018-04' is EXCLUSIVE: 2018-03 is the last month VX rolls up."""
    assert mapping.parent_for(VIRGIN_AMERICA, "2018-03") == AS


def test_virgin_america_stops_rolling_up_at_its_exclusive_thru_month(mapping):
    """The SQL join (sql/03_queries/pivot_mainline_join.sql) treats effective_to as
    EXCLUSIVE -- this is the Python side of that same rule, on the real shipped VX row.
    Before this fix, parent_for(21171, "2018-04") returned 19930 (Alaska), directly
    contradicting the SQL and the docs this task corrected."""
    assert mapping.parent_for(VIRGIN_AMERICA, "2018-04") is None


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
    """United is a parent, never a child."""
    assert mapping.parent_for(UA, "2020-06") is None


@pytest.mark.parametrize("shared", [SKYWEST, REPUBLIC])
@pytest.mark.parametrize("month", ["2015-01", "2020-06", "2026-01"])
def test_shared_regionals_are_never_rolled_up(mapping, shared, month):
    """They fly for several mainlines on the same day. No date range can fix that."""
    assert mapping.parent_for(shared, month) is None


def test_shared_regionals_are_absent_from_the_map_entirely(mapping):
    """Not merely unmapped — they must not appear, so a stray parent can't be added."""
    mapped = {e.airline_id for e in mapping.entries}
    assert mapped.isdisjoint({SKYWEST, REPUBLIC})


@pytest.mark.parametrize("month", ["2015-01", "2020-06", "2023-04", "2025-12", "2026-01"])
def test_mesa_does_not_roll_up_while_shared_or_unsourced(mapping, month):
    """American Eagle and United Express concurrently until 2023-04; post-merger
    (2025-11-25) flying unsourced."""
    assert mapping.parent_for(MESA, month) is None


# ------------------------------------------------------- exclusive contract carriers


@pytest.mark.parametrize(
    ("carrier", "month", "parent"),
    [
        (COMMUTAIR, "2015-01", UA),
        (COMMUTAIR, "2026-06", UA),
        (AIR_WISCONSIN, "2017-08", AA),
        (AIR_WISCONSIN, "2018-03", UA),
        (AIR_WISCONSIN, "2023-02", UA),
        (AIR_WISCONSIN, "2023-07", AA),
        (AIR_WISCONSIN, "2025-03", AA),
        (MESA, "2023-05", UA),
        (MESA, "2025-11", UA),
        (GOJET, "2021-01", UA),
        (EXPRESSJET, "2019-02", UA),
        (EXPRESSJET, "2020-09", UA),
        (TRANS_STATES, "2019-01", UA),
        (TRANS_STATES, "2020-04", UA),
        (EMPIRE, "2015-01", HAWAIIAN),
        (EMPIRE, "2021-01", HAWAIIAN),
    ],
)
def test_contract_carriers_roll_up_inside_their_exclusive_months(mapping, carrier, month, parent):
    assert mapping.parent_for(carrier, month) == parent


@pytest.mark.parametrize(
    ("carrier", "month"),
    [
        (AIR_WISCONSIN, "2017-09"),  # AA + UA concurrently
        (AIR_WISCONSIN, "2018-02"),
        (AIR_WISCONSIN, "2023-03"),  # UA + second AA contract
        (AIR_WISCONSIN, "2023-06"),
        (AIR_WISCONSIN, "2025-04"),  # 3 days AA, then own brand
        (GOJET, "2020-12"),  # Delta exit dated only by Wikipedia
        (EXPRESSJET, "2019-01"),  # AA flying ended this month
        (EXPRESSJET, "2020-10"),
        (TRANS_STATES, "2018-12"),
        (EMPIRE, "2021-02"),
        (COMPASS, "2015-01"),  # sourced, uncorroborated by hub data; excluded
    ],
)
def test_transition_and_excluded_months_stay_at_the_operating_carrier(mapping, carrier, month):
    assert mapping.parent_for(carrier, month) is None


def test_every_contract_row_cites_a_url(mapping):
    for e in mapping.entries:
        if e.basis == "contract":
            assert e.source.startswith("https://"), e


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


def test_gap_free_handoff_at_the_shared_boundary_month_is_accepted():
    """Under exclusive-effective_to semantics (matching the SQL join), the natural way to
    encode a clean, gap-free handoff is for the earlier range's effective_to to equal the
    later range's effective_from -- the earlier entry covers up to but not including that
    month, and the later entry starts exactly there. This must NOT be flagged as an overlap:
    before this fix, check_no_overlaps used inclusive-effective_to semantics and rejected
    exactly this shape, which would break the build the next time a date-ranged acquisition
    is entered using the convention this task just documented."""
    from pipeline.mainline_map import MapEntry

    entries = [
        MapEntry(
            airline_id=99, parent_airline_id=1, effective_from="2015-01", effective_to="2020-01"
        ),
        MapEntry(airline_id=99, parent_airline_id=2, effective_from="2020-01", effective_to=None),
    ]
    check_no_overlaps(entries)


def test_every_entry_is_keyed_on_airline_id_not_letter_code(mapping):
    """Letter codes get reused; `VX` and `HA` are exactly the kind that do."""
    for entry in mapping.entries:
        assert isinstance(entry.airline_id, int)
        assert isinstance(entry.parent_airline_id, int)


# ------------------------------------------------------- basis and source (#11)


def test_every_shipped_row_declares_a_known_basis(mapping):
    assert {e.basis for e in mapping.entries} <= {"owned", "contract"}


def test_an_unknown_basis_is_refused_by_the_basis_check():
    entries = [MapEntry(99, 1, "2015-01", basis="partnership", source="https://x")]
    with pytest.raises(BasisError, match="99"):
        check_bases(entries)


def test_a_contract_row_without_a_source_is_refused_by_the_source_check():
    entries = [MapEntry(99, 1, "2015-01", basis="contract", source="")]
    with pytest.raises(UnsourcedContractError, match="99"):
        check_contract_sources(entries)


def test_an_owned_row_without_a_source_is_admitted():
    check_contract_sources([MapEntry(99, 1, "2015-01", basis="owned", source="")])


def test_a_parent_that_is_a_child_in_the_same_month_is_refused_by_the_date_aware_check():
    """2 is 1's parent from 2015-01, and 3's child from 2018-01: in 2018-01 the rollup of 1
    would depend on evaluation order."""
    entries = [
        MapEntry(1, 2, "2015-01", None, basis="contract", source="https://x"),
        MapEntry(2, 3, "2018-01", None),
    ]
    with pytest.raises(ParentChildError, match=r"airline_id 2 "):
        check_parent_child_disjoint(entries)


def test_a_parent_that_is_a_child_only_in_other_months_is_admitted():
    """The Empire -> Hawaiian (2015-01..2021-02) and Hawaiian -> Alaska (2024-09..) shape.
    A set-membership check refuses this; only a date-aware one admits it."""
    entries = [
        MapEntry(20263, 19690, "2015-01", "2021-02", basis="contract", source="https://x"),
        MapEntry(19690, 19930, "2024-09", None),
    ]
    check_parent_child_disjoint(entries)


def test_the_parent_child_boundary_is_exclusive_at_effective_to():
    """Child range ends (exclusive) exactly where the parent range starts: no shared month."""
    entries = [
        MapEntry(1, 2, "2015-01", "2018-01", basis="contract", source="https://x"),
        MapEntry(2, 3, "2018-01", None),
    ]
    check_parent_child_disjoint(entries)


def test_the_parent_child_boundary_is_exclusive_at_the_childs_effective_from_too():
    """Mirror of the above: the parent-role range (airline 2 as parent of 1) starts exactly
    where 2's own child range ends (exclusive): no shared month."""
    entries = [
        MapEntry(1, 2, "2018-01", None, basis="contract", source="https://x"),
        MapEntry(2, 3, "2015-01", "2018-01"),
    ]
    check_parent_child_disjoint(entries)


# ------------------------------------------- the loader calls its checks (call sites)

_HEADER = (
    "airline_id,carrier_code,parent_airline_id,parent_code,"
    "effective_from,effective_to,note,basis,source\n"
)


def _load(tmp_path, *rows):
    path = tmp_path / "map.csv"
    path.write_text(_HEADER + "".join(r + "\n" for r in rows), encoding="utf-8")
    return load_mainline_map(path)


def test_the_loader_refuses_an_unknown_basis(tmp_path):
    with pytest.raises(BasisError, match="99"):
        _load(tmp_path, "99,XX,1,PP,2015-01,,n,partnership,https://x")


def test_the_loader_refuses_an_unsourced_contract_row(tmp_path):
    with pytest.raises(UnsourcedContractError, match="99"):
        _load(tmp_path, "99,XX,1,PP,2015-01,,n,contract,")


def test_the_loader_refuses_a_same_month_parent_and_child(tmp_path):
    with pytest.raises(ParentChildError, match=r"airline_id 2 "):
        _load(
            tmp_path,
            "1,AA,2,BB,2015-01,,n,contract,https://x",
            "2,BB,3,CC,2018-01,,n,owned,",
        )
