"""Move `Makefile`'s `WAREHOUSE_TAG` pin to a newly published release.

`WAREHOUSE_TAG` and `app/smoke.sh`'s dataset-pinned needles are ONE fixture: the pin says which
release asset `make image` builds from, and the needles assert month-specific values measured
against that same asset. Measured (#74): the pin sat on `warehouse-2026.04` for four days after
the needles had been re-pinned to `2026.05`, with every gate green -- because the one form that
can see the coupling, `make image-smoke` with the pin and the needles both at their defaults,
ran nowhere.

WHY A SCRIPT AND NOT SIX LINES OF `sed` IN THE WORKFLOW
    The rewrite has one non-obvious hazard, and it is invisible in a one-line fixture: a
    substitution over the tag SHAPE rewrites every `warehouse-YYYY.MM` in the file, not the pin.
    Prose in this Makefile has quoted concrete tags before and will again, and nothing reads
    those, so the corruption is silent. Anchoring on the ASSIGNMENT is what makes it impossible,
    and it is unit-testable here with no Actions runtime at all.

    The test for it must carry its own decoy. It used to rely on a second tag that happened to
    sit in the `IMAGE_SHA` comment -- and when that stale claim was corrected, the fixture went
    with it and the test passed against the very bug it names. CLAUDE.md's rule, on this file:
    "when a renamed value was the fixture for a transform, MOVE the fixture".

    Same split as `freshness.py` and `promote_check.py`: pure functions the tests exercise, and
    a `main()` the workflow calls.

WHAT THIS DELIBERATELY DOES NOT DO
    It does not touch the needles. Four of them (the partial-year sentence, the chart window,
    the current-year asterisk, the covered range) are derivable from `max(year_month)` alone;
    the rest -- a passenger total, `303 of the 606`, a polyline count, a leading route, a
    crossover annotation -- are not derivable without querying the warehouse through the
    rendered pages. A rewriter that fixed the first four would emit a PR that LOOKS re-measured
    and is not, which is worse than one that plainly says it moved the pin only. The bot does
    the mechanical half; `image-contract.yml` does the measurement; a human resolves a red.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import quote

from gha import write_multiline_output

#: The pin's assignment line, anchored. Never a bare search for the tag shape -- see the module
#: docstring for the second `warehouse-YYYY.MM` in this file that a shape search corrupts.
_PIN = re.compile(r"^WAREHOUSE_TAG \?= (.+)$", re.MULTILINE)

#: Full shape, anchored both ends -- NOT `startswith("warehouse-")`. warehouse.yml's resolver
#: comment measured why: git ref names permit backticks, `$`, `;`, `&`, `|`, quotes and parens,
#: and a prefix check constrains the prefix and nothing after it. This value reaches a branch
#: name, a commit message and a `gh pr create` argument.
#:
#: `\\Z`, never `$`: Python's `$` also matches immediately BEFORE a single trailing newline, so
#: the `$` form ACCEPTED "warehouse-2026.06\\n" and spliced a blank line in after the pin. No
#: wired caller can deliver that today (`stamp` builds the tag from a regex-checked `ym`), but a
#: human piping `cat` output into this script is one keystroke from it, and the comment above
#: claims both ends are anchored.
_TAG = re.compile(r"\Awarehouse-([0-9]{4})\.([0-9]{2})\Z")

#: The gate that measures what this script does not. Named here because the PR body links it.
GATE_WORKFLOW = "image-contract.yml"


class PinError(Exception):
    """Refusing to rewrite. Every raise here is a state where guessing would be worse than
    stopping: the pin is gone, duplicated, handed a tag that was never a release, or asked to
    move to an older dataset than the one the committed needles were measured against."""


def current_pin(makefile: str) -> str:
    """The tag `WAREHOUSE_TAG ?=` currently names, or `PinError` if that is not a single line."""
    found = _PIN.findall(makefile)
    if not found:
        raise PinError(
            "no `WAREHOUSE_TAG ?=` assignment in the Makefile -- the pin was renamed or "
            "removed. Refusing to open a PR that changes nothing, which is exactly the silent "
            "drift this job exists to end."
        )
    if len(found) > 1:
        raise PinError(
            f"`WAREHOUSE_TAG ?=` appears {len(found)} times, twice or more. make takes the "
            "LAST assignment, so rewriting one of them would report a bump that does not "
            "change what `make image` builds."
        )
    return found[0].strip()


def _ordinal(tag: str) -> tuple[int, int]:
    m = _TAG.match(tag)
    if not m:
        raise PinError(
            f"'{tag}' is not the warehouse-YYYY.MM shape warehouse.yml publishes "
            "(e.g. warehouse-2026.05) -- refusing to pin the image to a tag that was never "
            "a release."
        )
    return int(m.group(1)), int(m.group(2))


def branch_for(tag: str) -> str:
    """One source for the branch name: the workflow pushes it, `gh pr create` names it as the
    head, and the PR body links the gate's runs filtered by it."""
    return f"bot/warehouse-pin-{tag}"


def bump(makefile: str, new_tag: str) -> tuple[str, str]:
    """Return `(rewritten_makefile, previous_tag)`.

    An already-current pin returns the text unchanged rather than raising: `workflow_dispatch`
    can re-run the publisher, and "Warehouse" is watched by scheduled-failure.yml, so a raise
    would file a critical issue and page the owner for a run in which nothing is wrong.
    """
    new_ordinal = _ordinal(new_tag)
    previous = current_pin(makefile)
    if previous == new_tag:
        return makefile, previous
    if new_ordinal < _ordinal(previous):
        raise PinError(
            f"'{new_tag}' is OLDER than the committed pin '{previous}' -- refusing to move the "
            "pin backwards. The committed needles were measured against the newer dataset, so "
            "this would turn the container gate red with no defect present. If BTS has WITHDRAWN "
            "a month, that is a data anomaly and this refusal is the correct outcome: it fails "
            "the Warehouse run, which pages through scheduled-failure.yml. Read it as 'the "
            "upstream month went backwards', not as a broken bot."
        )
    return _PIN.sub(f"WAREHOUSE_TAG ?= {new_tag}", makefile, count=1), previous


def pr_body(previous: str, new_tag: str, owner: str, repo: str, server: str) -> str:
    """The PR body. States what moved, what was NOT measured, and which checks did not run.

    The mention is the alert. freshness.yml measured the alternative on 2026-08-17: an issue
    opened by github-actions[bot], in a repo the owner was not watching, with no assignee and
    no `@` anywhere in its body, notified nobody.
    """
    branch = branch_for(new_tag)
    runs = f"{server}/{repo}/actions/workflows/{GATE_WORKFLOW}?query={quote(f'branch:{branch}')}"
    return "\n".join(
        [
            f"@{owner}",
            "",
            f"`WAREHOUSE_TAG` moves `{previous}` -> `{new_tag}`.",
            "",
            "## The needles are not re-measured",
            "",
            "This PR moves the pin ONLY. `app/smoke.sh`'s dataset-pinned needles are the other",
            "half of the same fixture and are **not re-measured** here -- a passenger total, a",
            "count of qualifying routes, a polyline count, a leading route and a crossover",
            "annotation cannot be derived without querying the warehouse through the rendered",
            "pages, and rewriting only the four that can be would read as a verification this",
            "made no claim to.",
            "",
            "`make image-smoke` against the new pin, needles on, is what measures them. It is",
            "dispatched onto this branch when the PR opens, and the run appears here:",
            "",
            f"- {runs}",
            "",
            "**Check that link before merging.** If it is empty the dispatch did not land, and",
            "nothing has measured this pin -- the job says so in its own log and comments here.",
            "A green run means merge. A red one names, per FAIL line, the needle that moved and",
            "the value it still expects: re-measure those on this branch, in this PR, so the pin",
            "and the needles land in one commit.",
            "",
            "## Which checks ran",
            "",
            "This PR was opened with `GITHUB_TOKEN`, and GitHub starts no `pull_request` runs",
            "from events that token creates. **`ci.yml` has not run on this PR** and its checks",
            "will not appear below. The gate above is dispatched by `workflow_dispatch`, which",
            "is the one documented exception. To get the full suite, push a commit to this",
            "branch or close and reopen the PR.",
            "",
            "Setting a `BUMP_PIN_TOKEN` secret removes this caveat entirely; the bump job reads",
            "it already (`secrets.BUMP_PIN_TOKEN || github.token`).",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: bump_pin.py <warehouse-YYYY.MM>")
        return 2

    repo = os.environ.get("GITHUB_REPOSITORY")
    owner = os.environ.get("GITHUB_REPOSITORY_OWNER")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    if not repo or not owner:
        # Fail loud rather than emit a body with an empty mention: the mention IS the alert,
        # and a PR that notifies nobody is the failure freshness.yml already measured once.
        print("::error::GITHUB_REPOSITORY and GITHUB_REPOSITORY_OWNER must both be set")
        return 1

    path = Path("Makefile")
    try:
        after, previous = bump(path.read_text(), args[0])
    except PinError as exc:
        print(f"::error::{exc}")
        return 1

    changed = after != path.read_text()
    if changed:
        path.write_text(after)

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            # Always written, both branches: the workflow's step conditions read it, and a key
            # that exists only on one outcome is a key whose absence has two meanings.
            fh.write(f"changed={'1' if changed else '0'}\n")
            fh.write(f"previous={previous}\n")
            fh.write(f"branch={branch_for(args[0])}\n")
            if changed:
                write_multiline_output(
                    fh, "pr_body", pr_body(previous, args[0], owner, repo, server)
                )
    print(
        f"pin {previous} -> {args[0]}" if changed else f"pin already at {previous}; nothing to open"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
