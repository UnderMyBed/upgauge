"""The data invariants, as executable rules.

These are written before the pipeline that satisfies them — see docs/data/invariants.md,
where each rule carries the measurement that justifies it. Every constant here traces to an
observed distribution in real T-100 data, not to an assumption.
"""

from __future__ import annotations

import pytest

from pipeline.invariants import (
    EXPECTED_COLUMN_COUNT,
    PASSENGER_CONFIGS,
    ROLLUP_CLASSES,
    SCHEDULED_PASSENGER_CLASS,
    ColumnCountError,
    RollupClassError,
    check_columns,
    check_no_rollup_classes,
    is_passenger_service,
    quarantine_reason,
    resolve_amended,
    undirected_route_key,
)

# --------------------------------------------------------------- passenger filter


@pytest.mark.parametrize("config", [1, 3, 4])
def test_scheduled_passenger_configs_are_included(config):
    """Config 1 (passenger), 3 (combi), and 4 (seaplane) all carry real passengers.

    Measured full-year 2015: filtering to config 1 alone drops 7,326 passenger-carrying
    rows — disproportionately Alaska seaplane service, which is in scope.
    """
    assert is_passenger_service(SCHEDULED_PASSENGER_CLASS, config) is True


@pytest.mark.parametrize("config", [0, 2, 9])
def test_non_passenger_configs_are_excluded(config):
    """0 = not relevant, 2 = freight, 9 = expense capture (not real operations)."""
    assert is_passenger_service(SCHEDULED_PASSENGER_CLASS, config) is False


def test_config_alone_is_not_enough_class_must_be_scheduled():
    """`G` is scheduled all-cargo, `L`/`P` are non-scheduled. v0 is scheduled passenger."""
    assert is_passenger_service("G", 1) is False
    assert is_passenger_service("L", 1) is False  # charter carries passengers, still not v0
    assert is_passenger_service("P", 1) is False


def test_passenger_configs_constant_is_one_three_four():
    """Pinned so a later 'simplification' to {1} fails loudly rather than silently."""
    assert frozenset({1, 3, 4}) == PASSENGER_CONFIGS


# --------------------------------------------------------------- rollup classes


@pytest.mark.parametrize("rollup", ["K", "V", "Z"])
def test_rollup_service_classes_are_rejected(rollup):
    """K = F+G, V = L+N+P+R, Z = K+V. Summing across classes double-counts if present.

    Absent from both sampled years — which is why this is an assertion, not a filter. A
    rollup row appearing in an unsampled year would silently double a route's capacity.
    """
    with pytest.raises(RollupClassError, match=rollup):
        check_no_rollup_classes(["F", "G", rollup])


def test_observed_classes_pass():
    """2015 and 2024-01 both contain exactly these four."""
    check_no_rollup_classes(["F", "G", "L", "P"])


def test_rollup_classes_constant():
    assert frozenset({"K", "V", "Z"}) == ROLLUP_CLASSES


# --------------------------------------------------------------- quarantine


def _reason(**overrides):
    """A sound row by default; override one thing per test."""
    row = dict(
        seats=150, passengers=120, aircraft_config=1, departures_performed=10, airline_id="19790"
    )
    return quarantine_reason(**{**row, **overrides})


def test_an_ordinary_row_is_not_quarantined():
    assert _reason() is None


def test_a_flown_leg_reporting_zero_seats_is_quarantined():
    """Departures were performed but no seats reported — a genuine filing anomaly.

    Only 4 such rows in all of 2015.
    """
    assert _reason(seats=0, passengers=0, departures_performed=1) == "zero_seats"


def test_zero_seats_with_zero_departures_is_no_service_not_an_anomaly():
    """5,713 of 2015's 5,717 zero-seat passenger-config rows never flew.

    They are "no service filed this month", and they contribute nothing to any aggregate.
    Flagging them reported a 2.03% quarantine rate against a true anomaly rate of 0.001% —
    a 1,400x overstatement of a number the UI presents as a trust signal.
    """
    assert _reason(seats=0, passengers=0, departures_performed=0) is None


def test_zero_seats_in_a_freight_config_is_not_quarantined():
    """3,576 of 3,833 zero-seat rows in 2024-01 are genuine freighters."""
    assert _reason(seats=0, passengers=0, aircraft_config=2, departures_performed=5) is None


def test_a_row_with_no_carrier_identity_is_quarantined():
    """158 rows in 2015 have every carrier field blank yet report real traffic.

    They cannot be keyed on the operating carrier, which is the grain of the whole product,
    so they must not reach an aggregate.
    """
    assert _reason(airline_id="") == "missing_carrier"


def test_missing_carrier_outranks_other_defects():
    """An unattributable row is unattributable regardless of what else is wrong with it."""
    assert _reason(airline_id="", seats=0, departures_performed=1) == "missing_carrier"


def test_whitespace_only_carrier_id_counts_as_missing():
    assert _reason(airline_id="   ") == "missing_carrier"


def test_load_factor_above_one_is_quarantined_not_clamped():
    """Only 5 rows of 32,103 in 2024-01 — quarantining is nearly free, so there is no
    efficiency argument for clamping."""
    assert _reason(seats=100, passengers=101) == "load_factor_gt_1"


def test_load_factor_of_exactly_one_is_fine():
    assert _reason(seats=100, passengers=100) is None


# --------------------------------------------------------------- route identity


def test_undirected_route_key_is_order_independent():
    assert undirected_route_key(14057, 11298) == undirected_route_key(11298, 14057)


def test_undirected_route_key_is_sorted():
    """Sorted airport IDs, so the key is stable regardless of filing order."""
    assert undirected_route_key(14057, 11298) == (11298, 14057)


# --------------------------------------------------------------- amended filings


def test_latest_download_date_wins():
    rows = [
        {"key": "a", "download_date": "2026-01-15", "seats": 100},
        {"key": "a", "download_date": "2026-06-01", "seats": 120},
    ]
    resolved = resolve_amended(rows, key_fields=("key",))
    assert len(resolved) == 1
    assert resolved[0]["seats"] == 120


def test_latest_wins_regardless_of_input_order():
    """Partition iteration order must not change the result, or rebuilds aren't reproducible."""
    newer = {"key": "a", "download_date": "2026-06-01", "seats": 120}
    older = {"key": "a", "download_date": "2026-01-15", "seats": 100}
    assert resolve_amended([older, newer], key_fields=("key",)) == resolve_amended(
        [newer, older], key_fields=("key",)
    )


def test_distinct_keys_are_all_kept():
    rows = [
        {"key": "a", "download_date": "2026-01-15", "seats": 100},
        {"key": "b", "download_date": "2026-01-15", "seats": 200},
    ]
    assert len(resolve_amended(rows, key_fields=("key",))) == 2


def test_resolution_uses_the_full_composite_key():
    rows = [
        {"ym": "2015-01", "carrier": 19790, "download_date": "2026-01-01", "seats": 1},
        {"ym": "2015-01", "carrier": 19805, "download_date": "2026-01-01", "seats": 2},
        {"ym": "2015-02", "carrier": 19790, "download_date": "2026-01-01", "seats": 3},
    ]
    assert len(resolve_amended(rows, key_fields=("ym", "carrier"))) == 3


def test_resolution_is_deterministic_across_repeated_runs():
    rows = [
        {"key": "a", "download_date": "2026-01-15", "seats": 100},
        {"key": "a", "download_date": "2026-06-01", "seats": 120},
        {"key": "b", "download_date": "2026-03-01", "seats": 50},
    ]
    assert resolve_amended(rows, key_fields=("key",)) == resolve_amended(rows, key_fields=("key",))


# --------------------------------------------------------------- column count


def test_expected_column_count_is_45():
    assert EXPECTED_COLUMN_COUNT == 45


def test_check_columns_accepts_45():
    check_columns(["c"] * 45)


def test_check_columns_rejects_a_different_count():
    """Guards the reappearance of the trailing-comma phantom column, and any BTS field
    change that would silently shift every downstream position."""
    with pytest.raises(ColumnCountError):
        check_columns(["c"] * 46)
    with pytest.raises(ColumnCountError):
        check_columns(["c"] * 44)
