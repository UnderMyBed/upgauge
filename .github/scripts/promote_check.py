"""Decide whether the live `/api/health` report matches a promoted image tag.

CLAUDE.md's "the workflow fetches, a stdlib-only script decides" split (see `freshness.py`)
applies here for the reason `promote.yml`'s own first draft got wrong:

    expected_warehouse="${TAG%-*}"
    expected_sha="${TAG##*-}"

`UPGAUGE_BUILD_SHA` (baked from `image.yml`'s `IMAGE_SHA`) is `git describe --always --dirty
--abbrev=7`, so a dirty tree publishes a tag like `warehouse-2026.05-a2020f0-dirty`
(`docs/architecture/hosting.md`'s env table has the measured example). Bash's `%` and `##`
parameter expansions split on the LAST `-` in the string, which lands inside `-dirty`, not at
the warehouse/sha boundary:

    ${TAG%-*}   -> warehouse-2026.05-a2020f0   (wrong: still carries the sha)
    ${TAG##*-}  -> dirty                       (wrong: not a sha at all)

Neither half can ever match what `/api/health` reports (`build.sha` is `a2020f0-dirty`,
whole -- `app/src/lib/health.ts`'s `identity()` reads `UPGAUGE_BUILD_SHA` verbatim), so a
perfectly good deploy fails the poll every time, and the failure message compares "dirty"
against a live sha that will never contain that word -- confusing rather than diagnostic.

THE FIX: parse on the known WAREHOUSE shape instead of splitting on the sha's shape, which is
unconstrained (`-dirty` is the only wrinkle today, but nothing promises `git describe` will
never grow another `-something` suffix). The warehouse half is always `warehouse-YYYY.MM`
(`image.yml`'s `image-tag` step mints `${WAREHOUSE_TAG}-${IMAGE_SHA}` from a tag
`warehouse.yml`'s `stamp` step already asserted `^[0-9]{4}-[0-9]{2}$` before ever publishing
it). Everything after that prefix and its separating dash is the sha, WHATEVER shape it takes.

Because the bug lived entirely in string parsing, it is unit-testable with no network call, no
box, and no Actions runtime -- which is the whole reason this file exists apart from
`promote.yml`. Mirrors `freshness.py`'s split exactly: a pure function (`assess`) the tests
exercise directly, and a `main()` that reads argv/env, which is what the workflow calls.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass

from gha import write_multiline_output

#: The shape `image.yml` mints and `warehouse.yml` asserts before ever publishing a release.
#: Anchored at the start only -- the SHA half is deliberately unconstrained, since it is
#: whatever `git describe --always --dirty --abbrev=7` produces today or grows tomorrow.
_WAREHOUSE_PREFIX = re.compile(r"^(warehouse-[0-9]{4}\.[0-9]{2})-(.+)$")


@dataclass(frozen=True)
class Verdict:
    matched: bool
    reason: str
    expected_warehouse: str | None
    expected_sha: str | None
    live_warehouse: str | None
    live_sha: str | None


def parse_promoted_tag(tag: str) -> tuple[str, str] | None:
    """Split `<warehouse-tag>-<sha>` into `(warehouse_tag, sha)`.

    `None` if `tag` does not start with the `warehouse-YYYY.MM-` shape at all -- a typo'd
    dispatch input, not a tag `image.yml` could ever have published.
    """
    m = _WAREHOUSE_PREFIX.match(tag)
    return (m.group(1), m.group(2)) if m else None


def assess(tag: str, health: dict) -> Verdict:
    """`health` is exactly the JSON `/api/health` returns (`app/src/lib/health.ts`'s
    `HealthReport`) -- or `{}`, which is what the workflow substitutes when `curl` itself fails
    (dropped connection, box still booting, DNS not yet resolving) or when the endpoint answers
    with a body that doesn't even parse. `{}`, a genuine 503 body, and a malformed body all lack
    a usable `build`, and all three must read as "not yet", never as a crash -- the poll runs up
    to 30 times and a raised exception would take the whole workflow down on the first flaky
    fetch instead of retrying it.
    """
    parsed = parse_promoted_tag(tag)
    if parsed is None:
        return Verdict(
            matched=False,
            reason=(
                f"'{tag}' does not match the warehouse-YYYY.MM-<sha> shape image.yml "
                "publishes -- refusing to compare the live build against a tag that was "
                "never a real image"
            ),
            expected_warehouse=None,
            expected_sha=None,
            live_warehouse=None,
            live_sha=None,
        )
    expected_warehouse, expected_sha = parsed

    build = health.get("build")
    if not isinstance(build, dict):
        return Verdict(
            matched=False,
            reason=(
                "the health report has no `build` section -- the box may still be booting, "
                "`/api/health` may itself be failing, or the curl to it did not succeed"
            ),
            expected_warehouse=expected_warehouse,
            expected_sha=expected_sha,
            live_warehouse=None,
            live_sha=None,
        )
    live_warehouse = build.get("warehouse")
    live_sha = build.get("sha")

    if live_warehouse == expected_warehouse and live_sha == expected_sha:
        return Verdict(
            matched=True,
            reason=f"live matches the promoted tag ({expected_warehouse} / {expected_sha})",
            expected_warehouse=expected_warehouse,
            expected_sha=expected_sha,
            live_warehouse=live_warehouse,
            live_sha=live_sha,
        )
    return Verdict(
        matched=False,
        reason=(
            f"live is '{live_warehouse}' / '{live_sha}', want "
            f"'{expected_warehouse}' / '{expected_sha}'"
        ),
        expected_warehouse=expected_warehouse,
        expected_sha=expected_sha,
        live_warehouse=live_warehouse,
        live_sha=live_sha,
    )


def main() -> int:
    """Called once per poll attempt (`promote.yml`'s "Wait for the box to be serving it" loops
    up to 30 times). Exit code is what the workflow's `if ...; then break; fi` reads: 0 means
    the loop is done, 1 means keep polling. `GITHUB_OUTPUT` is also written every call, mirroring
    `freshness.py`'s shape, so the final attempt's verdict is available to any later step without
    the workflow having to re-parse this script's stdout.
    """
    if len(sys.argv) < 3:
        print("usage: promote_check.py <tag> <health-report-json>")
        return 2
    tag = sys.argv[1]
    try:
        health = json.loads(sys.argv[2])
    except json.JSONDecodeError:
        health = {}
    if not isinstance(health, dict):
        health = {}

    verdict = assess(tag, health)
    print(verdict.reason)

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"matched={'1' if verdict.matched else '0'}\n")
            write_multiline_output(fh, "reason", verdict.reason)

    return 0 if verdict.matched else 1


if __name__ == "__main__":
    raise SystemExit(main())
