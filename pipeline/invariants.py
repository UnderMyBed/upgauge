"""The data invariants, as enforceable rules.

Each constant here traces to a measured distribution in real T-100 data, not an assumption.
docs/data/invariants.md carries the numbers; this module carries the enforcement.

Nothing in here knows about DuckDB or Parquet on purpose — the rules are the thing that
must stay obvious and reviewable, independent of how the pipeline happens to apply them.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

#: Scheduled Passenger/Cargo. `G` is scheduled all-cargo; `L`/`P` are non-scheduled.
SCHEDULED_PASSENGER_CLASS = "F"

#: 1 = passenger, 3 = combi, 4 = seaplane. **Not just 1** — configs 3 and 4 carry real
#: passengers (7,326 such rows in 2015 alone).
PASSENGER_CONFIGS = frozenset({1, 3, 4})

#: K = F+G, V = L+N+P+R, Z = K+V. Aggregates of other rows; summing classes double-counts.
ROLLUP_CLASSES = frozenset({"K", "V", "Z"})

#: The T-100 Domestic Segment field count. A change means BTS altered the schema.
EXPECTED_COLUMN_COUNT = 45


class InvariantError(AssertionError):
    """Base class — an invariant the data must satisfy was violated."""


class RollupClassError(InvariantError):
    """A rollup service class was present; summing across classes would double-count."""


class ColumnCountError(InvariantError):
    """The column count changed — every downstream field position is now suspect."""


def is_passenger_service(service_class: str, aircraft_config: int | str) -> bool:
    """True for scheduled passenger service.

    Both halves are required: `CLASS` alone does not isolate passenger operations, and
    config alone does not distinguish scheduled from charter.
    """
    return service_class == SCHEDULED_PASSENGER_CLASS and int(aircraft_config) in PASSENGER_CONFIGS


def check_no_rollup_classes(classes: Iterable[str]) -> None:
    """Raise if any rollup class is present.

    An assertion rather than a filter: silently dropping `K` would hide the fact that BTS
    started emitting aggregates, and silently keeping it would double affected routes.
    """
    found = sorted(set(classes) & ROLLUP_CLASSES)
    if found:
        raise RollupClassError(
            f"rollup service class(es) present: {', '.join(found)} — "
            "summing across classes would double-count"
        )


def quarantine_reason(
    *,
    seats: float,
    passengers: float,
    aircraft_config: int | str,
    departures_performed: float,
    airline_id: str | int | None,
) -> str | None:
    """Why this row should be excluded from aggregates, or None if it is sound.

    Keyword-only on purpose: the rules are subtle enough that positional call sites would
    be a liability.

    Quarantined rows are excluded from aggregates but surfaced in the UI with a count and
    reason, so a reason that fires on ordinary data makes the whole signal worthless. That
    is not hypothetical — an earlier version of this function flagged every "no service
    this month" row and reported a 2.03% quarantine rate against a true rate of 0.001%.
    """
    if not str(airline_id or "").strip():
        # 158 such rows in 2015: every carrier field blank, but real traffic reported.
        # Unattributable to an operating carrier, which is the grain of the whole product.
        return "missing_carrier"

    config = int(aircraft_config)

    if seats == 0:
        if config not in PASSENGER_CONFIGS:
            # Just a freighter. The service filter removes it; flagging would pollute the count.
            return None
        if departures_performed == 0:
            # No service filed this month. Contributes nothing to any aggregate, and is
            # completely ordinary — 5,713 such rows in 2015 against 4 genuine anomalies.
            return None
        # Flew, but reported no seats. A real filing anomaly.
        return "zero_seats"

    if passengers > seats:
        # A filing error. Never clamped — clamping would invent a plausible number.
        return "load_factor_gt_1"

    return None


def undirected_route_key(origin_airport_id: int, dest_airport_id: int) -> tuple[int, int]:
    """A direction-independent route key: the two airport IDs, sorted."""
    return (
        (origin_airport_id, dest_airport_id)
        if origin_airport_id <= dest_airport_id
        else (dest_airport_id, origin_airport_id)
    )


def resolve_amended(
    rows: Iterable[dict[str, Any]],
    key_fields: Sequence[str],
    date_field: str = "download_date",
) -> list[dict[str, Any]]:
    """Collapse amended filings: latest `download_date` wins per grain key.

    BTS accepts amended filings and silently overwrites. Prior partitions are retained as an
    audit trail but must never feed a mart, or rebuilds stop being reproducible.

    Output is sorted by key so the result does not depend on partition iteration order.
    """
    winners: dict[tuple, dict[str, Any]] = {}
    for row in rows:
        key = tuple(row[f] for f in key_fields)
        incumbent = winners.get(key)
        if incumbent is None or row[date_field] > incumbent[date_field]:
            winners[key] = row
    return [winners[k] for k in sorted(winners, key=lambda k: tuple(str(p) for p in k))]


def check_columns(columns: Sequence[str]) -> None:
    """Raise unless the extract has exactly the expected number of columns."""
    if len(columns) != EXPECTED_COLUMN_COUNT:
        raise ColumnCountError(
            f"expected {EXPECTED_COLUMN_COUNT} columns, got {len(columns)} — "
            "BTS changed the schema; field positions downstream are unsafe"
        )
