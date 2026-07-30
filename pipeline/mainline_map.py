"""The date-ranged wholly-owned rollup.

The rollup is a *display grouping layered on the operating-carrier grain*, never a
replacement for it. Aircraft type stays at the grain, so downgauge stories remain visible.

The mapping is date-ranged rather than static because Alaska acquired Virgin America (2016)
and Hawaiian (2024), both inside the window. A flat map is wrong before each acquisition and
omission is wrong after. See docs/data/carrier-model.md.
"""

from __future__ import annotations

import csv
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from pipeline.invariants import InvariantError

DEFAULT_MAP_PATH = Path(__file__).parent / "reference" / "mainline_group.csv"

#: Sorts after any real YYYY-MM, so an open-ended range compares correctly.
_OPEN_ENDED = "9999-12"


class OverlapError(InvariantError):
    """A carrier had two parents for the same month — unresolvable, so it's a failure."""


@dataclass(frozen=True)
class MapEntry:
    airline_id: int
    parent_airline_id: int
    effective_from: str
    effective_to: str | None = None
    carrier_code: str = ""
    parent_code: str = ""
    note: str = ""

    def covers(self, year_month: str) -> bool:
        """Inclusive at `effective_from`, EXCLUSIVE at `effective_to` -- matching the SQL
        join in sql/03_queries/pivot_mainline_join.sql (`>= effective_from AND <
        effective_to`), which is the actual query-time rollup this validates against. A
        carrier whose `effective_to` is '2018-04' has already stopped rolling up BY 2018-04,
        not after it. See docs/data/carrier-model.md."""
        return self.effective_from <= year_month < (self.effective_to or _OPEN_ENDED)


@dataclass(frozen=True)
class MainlineMap:
    entries: tuple[MapEntry, ...]

    def parent_for(self, airline_id: int, year_month: str) -> int | None:
        """The parent this carrier rolled up to in that month, or None.

        None means "not a wholly-owned subsidiary then" — which covers independents, shared
        regionals, and subsidiaries before their acquisition. All of them stay at the
        operating-carrier grain, which is the default view anyway.
        """
        for entry in self.entries:
            if entry.airline_id == airline_id and entry.covers(year_month):
                return entry.parent_airline_id
        return None


def load_mainline_map(path: Path | None = None) -> MainlineMap:
    """Load and validate the checked-in map. Raises if it is internally inconsistent."""
    path = path or DEFAULT_MAP_PATH
    entries: list[MapEntry] = []
    with open(path, newline="", encoding="utf-8") as fh:
        rows = csv.DictReader(line for line in fh if not line.startswith("#"))
        for row in rows:
            entries.append(
                MapEntry(
                    airline_id=int(row["airline_id"]),
                    parent_airline_id=int(row["parent_airline_id"]),
                    effective_from=row["effective_from"].strip(),
                    effective_to=row["effective_to"].strip() or None,
                    carrier_code=row["carrier_code"].strip(),
                    parent_code=row["parent_code"].strip(),
                    note=row.get("note", "").strip(),
                )
            )
    check_no_overlaps(entries)
    check_map_is_total(entries)
    return MainlineMap(entries=tuple(entries))


def check_no_overlaps(entries: Iterable[MapEntry]) -> None:
    """Raise if any carrier has two parents covering the same month.

    `effective_to` is EXCLUSIVE (matches `covers()` and the SQL join), so a clean,
    gap-free handoff is encoded as the earlier range's `effective_to` equalling the later
    range's `effective_from` -- the earlier entry covers up to but not including that month,
    the later entry starts exactly there. That shape must be ACCEPTED, not flagged as an
    overlap, which is why this compares with `<`, not `<=`.
    """
    by_carrier: dict[int, list[MapEntry]] = {}
    for entry in entries:
        by_carrier.setdefault(entry.airline_id, []).append(entry)

    for airline_id, group in by_carrier.items():
        ordered = sorted(group, key=lambda e: e.effective_from)
        for earlier, later in zip(ordered, ordered[1:], strict=False):
            earlier_end = earlier.effective_to or _OPEN_ENDED
            if later.effective_from < earlier_end:
                raise OverlapError(
                    f"airline_id {airline_id}: range starting {later.effective_from} overlaps "
                    f"the one ending {earlier_end} — two parents for one month is unresolvable"
                )


def check_map_is_total(entries: Sequence[MapEntry]) -> None:
    """Raise if the map is internally incoherent.

    Totality here means: every (airline_id, month) resolves to exactly one parent or to
    itself. Overlaps are the way that breaks, plus a parent appearing as somebody's child,
    which would make the rollup depend on evaluation order.
    """
    check_no_overlaps(entries)
    parents = {e.parent_airline_id for e in entries}
    children = {e.airline_id for e in entries}
    both = parents & children
    if both:
        raise OverlapError(
            f"airline_id(s) {sorted(both)} appear as both parent and child — "
            "the rollup would depend on evaluation order"
        )
