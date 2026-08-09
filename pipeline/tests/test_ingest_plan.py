"""`make ingest`'s four steps, checked against the Makefile itself.

Two defects motivated this, both introduced by the fix for the publisher that could never
detect a new BTS month:

1. `ARGS` was half-honored -- the plain `fetch` and `warehouse` saw a caller's `ARGS` while
   the two forced steps overrode it, so `make ingest ARGS="--raw-dir /alt"` wrote some files
   to `/alt` and some to `data/raw`. A partially-applied override is worse than a rejected
   one, because it half-works.
2. A fresh clone made 14 TranStats POSTs, not 12: the unbounded first pass fetched all 12
   years and the forced pass immediately re-fetched the newest 2, same day, same filename.

These assertions PARSE THE RECIPE rather than restate it. A test carrying its own copy of the
year arithmetic would keep passing after someone edited the Makefile, which is the failure
mode this repo keeps paying for.

Nothing here touches the network: `BtsFetcher.download_year` is stubbed and counted.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

from pipeline import fetch
from pipeline.fetch import WINDOW_START

REPO = Path(__file__).parents[2]
MAKEFILE = REPO / "Makefile"

# The year the arithmetic is evaluated at. Fixed, so this test cannot drift with the clock.
YEAR = 2026


def _ingest_recipe() -> list[str]:
    """The recipe lines of the `ingest:` target, tabs stripped."""
    lines = MAKEFILE.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("ingest:"))
    body: list[str] = []
    for line in lines[start + 1 :]:
        if not line.startswith("\t"):
            break
        body.append(line[1:])
    return body


def _fetch_arg_strings() -> list[str]:
    """Every `$(MAKE) fetch` step's ARGS payload in the ingest recipe, in order.

    A BARE `$(MAKE) fetch` matches too, yielding "". That is deliberate and it is the whole
    point: the 14-POST defect WAS a bare, unbounded first pass. A pattern that only matched
    `fetch ARGS="..."` would drop that step from the simulation entirely and let the POST
    count come out at 2 -- passing the assertion by not measuring the defect.

    `fetch-reference` is excluded by the word boundary: it is a different target and takes
    no years.
    """
    out = []
    for line in _ingest_recipe():
        m = re.match(r'\$\(MAKE\) fetch(?!-)(?:\s+ARGS="([^"]*)")?\s*$', line.strip())
        if m:
            out.append(m.group(1) or "")
    return out


def _argv(arg_string: str, year: int) -> list[str]:
    """Resolve the Makefile's `$$(( $$(date -u +%Y) - N ))` arithmetic at a fixed year."""
    resolved = re.sub(
        r"\$\$\(\(\s*\$\$\(date -u \+%Y\)\s*-\s*(\d+)\s*\)\)",
        lambda m: str(year - int(m.group(1))),
        arg_string,
    )
    assert "$" not in resolved, f"unresolved shell expansion in {arg_string!r}"
    return resolved.split()


def test_the_recipe_is_still_shaped_the_way_this_test_reads_it():
    """Anti-vacuity. If the recipe stops matching, every count below is measuring nothing."""
    recipe = _ingest_recipe()
    assert recipe, "no ingest recipe found -- the Makefile target was renamed or removed"
    arg_strings = _fetch_arg_strings()
    assert len(arg_strings) == 2, f"expected exactly two `fetch` steps; got {arg_strings}"
    assert any("--force" in a for a in arg_strings), "no forced fetch step found"
    assert any("fetch-reference" in line for line in recipe), "no fetch-reference step"
    assert any("warehouse" in line for line in recipe), "no warehouse step"


def test_a_fresh_clone_makes_one_post_per_window_year(monkeypatch, tmp_path):
    """12 POSTs, not 14. The two passes must PARTITION the window, never overlap."""
    calls: list[int] = []

    def _stub(self, table, year, retries=3, backoff=5.0):
        calls.append(year)
        return b"PK\x03\x04stub", f"{table.slug}_{year}.zip"

    monkeypatch.setattr(fetch.BtsFetcher, "download_year", _stub)

    for arg_string in _fetch_arg_strings():
        argv = _argv(arg_string, YEAR) + ["--raw-dir", str(tmp_path)]
        assert fetch.main(argv) == 0, f"step failed: {argv}"

    window = list(range(WINDOW_START, YEAR + 1))
    assert sorted(calls) == window, (
        f"expected exactly one POST per window year {window[0]}..{window[-1]}; "
        f"got {len(calls)} POSTs: {sorted(calls)}"
    )
    assert len(calls) == len(set(calls)), (
        f"a year was fetched twice -- the two passes overlap: {sorted(calls)}"
    )


def test_the_forced_pass_covers_exactly_the_two_mutable_years():
    """BTS revises closed months, so the current year alone is not the mutable set."""
    forced = next(a for a in _fetch_arg_strings() if "--force" in a)
    argv = _argv(forced, YEAR)
    years = fetch.plan_years(
        start=int(argv[argv.index("--start") + 1]),
        end=int(argv[argv.index("--end") + 1]) if "--end" in argv else None,
        today=__import__("datetime").date(YEAR, 6, 1),
    )
    assert years == [YEAR - 1, YEAR], f"forced pass covers {years}, expected the newest two"


def test_ingest_rejects_ARGS_instead_of_half_applying_it():
    """Runs the real target. The guard is the first recipe line, so this never reaches BTS."""
    result = subprocess.run(
        ["make", "ingest", "ARGS=--raw-dir /tmp/should-never-be-used"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, (
        "make ingest accepted ARGS -- it would apply to two of four steps.\n"
        f"stdout:\n{result.stdout}"
    )
    assert "does not accept ARGS" in result.stdout, (
        f"rejected, but without saying why:\n{result.stdout}"
    )
    # The error must name the way out, or it is just a wall.
    assert "make fetch ARGS=" in result.stdout, f"no alternative offered:\n{result.stdout}"


@pytest.mark.skipif(sys.platform == "win32", reason="make is not available")
def test_ingest_with_no_ARGS_does_not_trip_the_guard():
    """The publisher calls `make ingest` bare, so the guard must not fire on an empty ARGS.

    Asserted on the guard's CONDITION as `--just-print` expands it, not on the message: the
    printed recipe necessarily CONTAINS the rejection text (it is the un-run `echo` body), so
    grepping stdout for that text reports a rejection on every single run. That is exactly the
    `check_not`-shaped vacuous assertion this repo has been bitten by before.
    """
    result = subprocess.run(
        ["make", "--just-print", "ingest"], cwd=REPO, capture_output=True, text=True
    )
    assert result.returncode == 0, f"make ingest is broken with no ARGS:\n{result.stderr}"
    assert 'if [ -n "" ]' in result.stdout, (
        "the guard's test did not expand to the empty string with no ARGS, so it would "
        f"reject the publisher's own bare call:\n{result.stdout[:400]}"
    )
