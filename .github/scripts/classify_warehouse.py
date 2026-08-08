"""Classify what changed between two warehouse builds.

The publisher is the only place that holds both the old and new warehouse, so it is the only
place a data change can be named precisely rather than inferred later from a stranger's red
PR. Three classes, ordered by how much human attention they deserve:

  1  a month was appended            -- routine
  2  a closed year's numbers moved   -- amended filings; expected, must be surfaced
  3  the SHAPE or VOCABULARY moved   -- dangerous; files a critical issue

Class 3 exists because BTS reference tables carry CURRENT identity with no name history: a
rename lands silently in a rebuild with no superseded row to fall back on.

INVARIANT: `previous["measures"]` and `current["measures"]` carry the SAME key set. Both come
from the same commit's `pipeline.stats.collect()` -- the schema does not change between the two
sides of a single comparison, only the values do. `classify()` asserts this loudly at the top
rather than defending each lookup with `.get()`: a tolerant fallback would let a `stats.py`
schema drift silently degrade into "nothing moved" instead of surfacing it, which is exactly
the failure mode this whole module exists to refuse.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from dataclasses import dataclass, field

# Scalars whose movement is a shape change, not a data change. A dim gaining rows means the
# upstream vocabulary moved, which is what breaks slug fixtures and join assumptions.
_SHAPE_SCALARS = ("city_markets", "dim_aircraft_type_rows", "fact_present_aircraft_codes")


@dataclass
class Classification:
    new_months: list[str] = field(default_factory=list)
    moved_years: list[str] = field(default_factory=list)
    shape_changes: list[str] = field(default_factory=list)

    @property
    def worst_class(self) -> int:
        if self.shape_changes:
            return 3
        if self.moved_years:
            return 2
        if self.new_months:
            return 1
        return 0


def _assert_same_measure_keys(prev: dict, cur: dict) -> None:
    """Enforce the module-level invariant: both sides come from the same `collect()` shape.

    Every check below subscripts `prev[...]`/`cur[...]` directly rather than `.get(...)` --
    that is only safe because this runs first and fails loudly on the one precondition that
    makes direct subscripting safe.
    """
    only_prev = prev.keys() - cur.keys()
    only_cur = cur.keys() - prev.keys()
    if only_prev or only_cur:
        raise KeyError(
            "previous and current measures have different key sets -- classify() cannot "
            f"compare them: only in previous: {sorted(only_prev)}, only in current: "
            f"{sorted(only_cur)}"
        )


def classify(previous: dict, current: dict) -> Classification:
    prev, cur = previous["measures"], current["measures"]
    _assert_same_measure_keys(prev, cur)
    c = Classification()

    if prev["max_year_month"] != cur["max_year_month"]:
        c.new_months.append(cur["max_year_month"])

    prev_years = {str(r["year"]): r for r in prev["rows_by_year"]}
    for row in cur["rows_by_year"]:
        year = str(row["year"])
        was = prev_years.get(year)
        if was and (was["rows"], was["quarantined"]) != (row["rows"], row["quarantined"]):
            c.moved_years.append(year)

    # The forward loop above can only see years that SURVIVED into the current build. A year
    # that was in `prev` and vanished entirely -- a pipeline regression dropping an early
    # partition -- is invisible to it by construction; this is the reverse direction.
    cur_year_set = {str(r["year"]) for r in cur["rows_by_year"]}
    for year in sorted(set(prev_years) - cur_year_set):
        c.shape_changes.append(
            f"year {year} vanished from rows_by_year -- present in the previous build, "
            "absent from the current one"
        )

    for key in _SHAPE_SCALARS:
        if prev[key] != cur[key]:
            c.shape_changes.append(f"{key}: {prev[key]} -> {cur[key]}")

    prev_names = {r["code"]: r["short_name"] for r in prev["aircraft_short_names"]}
    cur_names = {r["code"]: r["short_name"] for r in cur["aircraft_short_names"]}
    for code, name in cur_names.items():
        if code in prev_names and prev_names[code] != name:
            c.shape_changes.append(
                f"aircraft {code} RENAMED: {prev_names[code]!r} -> {name!r} "
                "(no number moves; slug fixtures and /aircraft routes do)"
            )
    if prev["aircraft_slug_separators"] != cur["aircraft_slug_separators"]:
        c.shape_changes.append(
            f"aircraft slug separator distribution: "
            f"{prev['aircraft_slug_separators']} -> {cur['aircraft_slug_separators']}"
        )
    return c


def _issue_body(c: Classification) -> str:
    lines = ["The upstream BTS dataset changed shape. This is the class of change that breaks", ""]
    lines.append("fixtures and slug routes while moving no underlying number.")
    lines.append("")
    for s in c.shape_changes:
        lines.append(f"- **{s}**")
    if c.new_months:
        lines.append(f"\nAlso appended: {', '.join(c.new_months)}")
    if c.moved_years:
        lines.append(f"\nAlso revised (amended filings): {', '.join(c.moved_years)}")
    lines += [
        "",
        "## What to do",
        "",
        "1. `make stats` and read the diff.",
        "2. Re-pin whatever depended on the old value **in the same commit**.",
        "3. Where a renamed value was the FIXTURE for a transform, move the fixture rather than",
        "   renaming it -- a replacement that no longer exercises the path would pass against",
        "   the very bug it exists to catch.",
    ]
    return "\n".join(lines)


def _write_multiline_output(fh, name: str, value: str) -> None:
    """Append a `name<<DELIM ... DELIM` block to an open $GITHUB_OUTPUT handle.

    The delimiter is randomized, per GitHub's own guidance for output values built from
    unpredictable upstream text: a static delimiter (e.g. a fixed `EOF`) that happens to
    appear verbatim on its own line inside `value` would truncate the value silently instead
    of failing loudly. Not reachable today -- the only free-text fields in `_issue_body()` are
    rendered through `!r` -- but the cost of generating one is a function call, and the
    alternative is a delimiter collision nobody would notice until an issue body went missing
    its tail.
    """
    delim = secrets.token_hex(16)
    while delim in value:
        delim = secrets.token_hex(16)
    fh.write(f"{name}<<{delim}\n{value}\n{delim}\n")


def main() -> int:
    # The only caller (warehouse.yml's `classify` step) invokes this with exactly two
    # positional args, and only when a previous warehouse exists to compare against -- a run
    # with fewer args means something upstream is wrong, not that there's nothing to compare.
    if len(sys.argv) < 3:
        print("usage: classify_warehouse.py <previous-json> <current-json>")
        return 0
    previous = json.loads(sys.argv[1])
    current = json.loads(sys.argv[2])
    c = classify(previous, current)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    report = [f"## Warehouse delta — class {c.worst_class}", ""]
    report += [f"- appended: {c.new_months or 'none'}"]
    report += [f"- revised years: {c.moved_years or 'none'}"]
    report += [f"- shape changes: {c.shape_changes or 'none'}"]
    if summary:
        with open(summary, "a") as fh:
            fh.write("\n".join(report) + "\n")
    print("\n".join(report))
    if c.worst_class == 3:
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            with open(out, "a") as fh:
                fh.write("file_issue=1\n")
                _write_multiline_output(fh, "issue_body", _issue_body(c))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
