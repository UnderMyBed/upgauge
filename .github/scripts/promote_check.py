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

WHAT THE POLL IS ENTITLED TO CONCLUDE WHEN IT RUNS OUT OF ATTEMPTS
    The exhausted path used to emit, unconditionally, "The tag moved; the deploy did not" and
    "ROLL BACK NOW". On 2026-08-1x it emitted both against a healthy, correctly-promoted deploy:
    every one of the 30 attempts had been served a challenge page, so the workflow had never
    read the box at all. Telling an operator to roll back a good deploy is worse than staying
    silent -- a rollback is a real production action.

    So the report is built from what was OBSERVED, and `read_a_build` is the boundary:

      - a build was read and it disagrees -> the box is up and never took the image, `:deploy`
        still points at that image, and re-dispatching the previous known-good tag is the remedy.
        Ordered outright.
      - no build was ever read -> the finding is that the poll is blind, and it is NOT evidence
        the deploy failed. It is not evidence the deploy SUCCEEDED either: `docker compose up -d
        --wait` recreates the container before confirming health, so an image that fails to start
        closes the port and the real emergency arrives looking exactly like an edge that refuses
        this runner. The report says so, gives the one command that separates them, and keeps the
        remedy conditional on it.

    Unreadability is a property of the BODY, never of the status: `/api/health` answers 503 with
    a complete, valid report when the data layer is degraded
    (`app/src/app/api/health/route.ts:27`), and a wrong build read from one of those is an
    ordinary mismatch.

A MATCHING BUILD IS NOT A DEPLOY (#79)
    `build` is baked from the Dockerfile's runtime build args and `health.ts`'s `identity()`
    computes it before every return branch, so a degraded report carries the promoted sha and
    warehouse VERBATIM -- and the route serves that report under a 503 with the body unchanged.
    Comparing build identity alone therefore returned `matched` on the first poll attempt against
    a box answering 503 to every visitor, and the workflow exited 0 on it. The hourly watchdog
    read `status` and this one, holding the rollback decision, did not.

    So `MATCHED` requires `status == "ok"` -- an allow-list, never `!= "degraded"`, because
    `is_health_report` requires `status` to be a string and nothing further. And the BUILD is
    compared first: a box still serving the old image and reporting degraded is telling this poll
    about an image nobody promoted, which is a mismatch and nothing else.

WHAT A DEGRADED BOX EARNS, AND WHY IT IS NOT A MISMATCH'S REMEDY
    The tag moved and the box took the image; what it took cannot answer. Rolling back is
    ORDERED -- unlike the blind branch, the box has reported over the full budget that it is not
    serving, and that is a measurement -- but it is not PROMISED. `deploy/compose.yml` mounts no
    data volume (the dataset is baked into the image) and `image.yml` gates every image with
    `make image-smoke` before it can reach the registry, so the cause is the image's contents,
    the pull, or the box itself; and a rollback lands the previous image on the SAME box. The
    report carries the cause `/api/health` named so the operator can tell which afterwards, and
    says where each answer leads.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass

from gha import (
    code_span,
    health_cause,
    inline,
    is_health_report,
    printable,
    snippet,
    write_multiline_output,
)

#: The shape `image.yml` mints and `warehouse.yml` asserts before ever publishing a release.
#: Anchored at the start only -- the SHA half is deliberately unconstrained, since it is
#: whatever `git describe --always --dirty --abbrev=7` produces today or grows tomorrow.
_WAREHOUSE_PREFIX = re.compile(r"^(warehouse-[0-9]{4}\.[0-9]{2})-(.+)$")

#: `outcome` values. `read_a_build` is derived from these rather than stored twice.
MATCHED = "matched"
MISMATCH = "mismatch"
#: The box is serving the promoted build and says it cannot answer with it (#79). Its own
#: outcome: the identity is RIGHT, so it is neither a mismatch nor an unreadable box, and the
#: remedy differs from both.
DEGRADED = "degraded"
UNREADABLE = "unreadable"
BAD_TAG = "bad-tag"

_HAND_CHECK = "curl -sS -D - https://upgauge.shipman.dev/api/health"


@dataclass(frozen=True)
class Verdict:
    outcome: str
    reason: str
    expected_warehouse: str | None
    expected_sha: str | None
    live_warehouse: str | None
    live_sha: str | None
    #: The `status` the box reported, or None when no report was read. Carried as a field rather
    #: than only inside `reason` because the MISMATCH branch needs it too: "The box answers, so
    #: it is up" is a claim about the build the box IS serving, and it is false of a degraded one.
    live_status: str | None

    @property
    def matched(self) -> bool:
        return self.outcome == MATCHED

    @property
    def read_a_build(self) -> bool:
        """Whether the box's own build was actually read. The ONLY thing that licenses the
        exhausted report to say anything about the deploy.

        DEGRADED belongs here: the build was there and it was right. Reporting it as a blind
        attempt would drop it out of `promote.yml`'s sticky carry, so one flaky challenge page at
        attempt 30 would report a poll that never saw the box -- against a box that had named its
        own failure 29 times."""
        return self.outcome in (MATCHED, MISMATCH, DEGRADED)

    def exhausted_report(self, attempts: int) -> str:
        """The final word after the poll budget elapses, one finding per line. See the module
        docstring for why the branches differ in what they are allowed to claim, and in what they
        order: `read_a_build` is the evidence boundary, and among the outcomes that cleared it,
        a wrong build and a build that cannot serve are different failures with different fixes."""
        if self.outcome == MISMATCH:
            # "so it is up" is a claim about the build the box IS serving, and this branch has
            # that build's status in hand: a box serving an old, degraded image is up and NOT
            # serving. A clause, not a restructure -- what the branch RECOMMENDS is unchanged,
            # because the box never took the new image whatever the old one is doing.
            up = (
                "The box answers, so it is up"
                if self.live_status == "ok"
                else f"The box answers, but reports `{inline(self.live_status)}` on the build it "
                "is serving, so it is up and not serving what it has"
            )
            return "\n".join(
                [
                    f"the box is serving `{inline(self.live_warehouse)}` / "
                    f"`{inline(self.live_sha)}` after "
                    f"{attempts} attempts, not the promoted `{self.expected_warehouse}` / "
                    f"`{self.expected_sha}`. The tag moved; the deploy did not.",
                    f"{up} -- it never took the new image, and `:deploy` "
                    "still points at that image, so the box can land on it at any 30s tick. "
                    "ROLL BACK NOW: re-dispatch this workflow with the previous known-good tag, "
                    "then find out why this one never pulled (`upgauge-deploy.timer` on the box).",
                ]
            )
        if self.outcome == DEGRADED:
            return "\n".join(
                [
                    f"after {attempts} attempts, {self.reason}. The tag moved and the box took "
                    "the image; what it took cannot answer.",
                    "It does not recover on its own: a 503 fails the container's own HEALTHCHECK "
                    "(`deploy/compose.yml`'s probe is `r.ok`), so `docker compose up -d --wait` "
                    "never confirms it and the box's timer retries the same digest every 30s "
                    "forever.",
                    "ROLL BACK NOW: re-dispatch this workflow with the previous known-good tag. "
                    "That is the fastest way back to a serving site and costs nothing if the "
                    "image was not the cause -- but it is not guaranteed to fix this: no data "
                    "volume is mounted (the dataset is baked into the image), every image passes "
                    "`make image-smoke` before it can be published, and a rollback lands the "
                    "previous image on the SAME box. If `/api/health` reports the cause above "
                    "again once the previous image is back, the subject is the box, not the "
                    "image -- replace it (docs/architecture/deploy.md, Provision, or replace the "
                    "box). It holds no state.",
                ]
            )
        if self.outcome == UNREADABLE:
            return "\n".join(
                [
                    f"after {attempts} attempts the poll never read a build from the box: "
                    f"{self.reason}",
                    "THIS IS NOT EVIDENCE EITHER WAY. `docker compose up -d --wait` recreates "
                    "the container before confirming health, so an image that fails to start "
                    "closes the port and takes the site DOWN while the box's timer retries it "
                    "forever -- and an edge that refuses this runner looks identical from here.",
                    f"Check by hand, from a network that reaches the site: `{_HAND_CHECK}`. "
                    "If it is down, or serving a build other than the promoted one, ROLL BACK "
                    "NOW: re-dispatch this workflow with the previous known-good tag. If it "
                    "reports the promoted build, this run was blind and the deploy is fine.",
                ]
            )
        if self.outcome == MATCHED:
            return (
                f"the last attempt MATCHED after {attempts} attempts, yet the poll loop did not "
                f"exit on it -- that is a bug in promote.yml's loop, not in the deploy: "
                f"{self.reason}"
            )
        return (
            f"{self.reason}. Nothing about the box was measured, so this says nothing about the "
            "deploy: fix the dispatch input and re-run."
        )


def parse_promoted_tag(tag: str) -> tuple[str, str] | None:
    """Split `<warehouse-tag>-<sha>` into `(warehouse_tag, sha)`.

    `None` if `tag` does not start with the `warehouse-YYYY.MM-` shape at all -- a typo'd
    dispatch input, not a tag `image.yml` could ever have published.
    """
    m = _WAREHOUSE_PREFIX.match(tag)
    return (m.group(1), m.group(2)) if m else None


def read_health(body: str, http_status: int) -> tuple[dict, str | None]:
    """`(report, None)` when the body is a health report, `({}, why-not)` when it is anything
    else. `http_status` is curl's `%{http_code}`: 0 (`000`) means no response line arrived.
    """
    code = f"{http_status:03d}"
    if http_status == 0:
        partial = f" What did arrive: {code_span(snippet(body))}" if body.strip() else ""
        return {}, (
            f"the fetch did not complete -- curl exited before a full response was read.{partial}"
        )
    if not body.strip():
        return {}, f"the last response was HTTP {code} with an empty body"
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return {}, (
            f"the last response was HTTP {code} and its body is not JSON: "
            f"{code_span(snippet(body))}"
        )
    if not isinstance(parsed, dict):
        return {}, (
            f"the last response was HTTP {code} and its body is JSON that is not an object: "
            f"{code_span(snippet(body))}"
        )
    if not is_health_report(parsed):
        # Not "does it have a build" -- `{"build":{}}` has one, and passing it through made an
        # arbitrary JSON body earn an unconditional ROLL BACK NOW, or a lucky one declare the
        # promote successful. The question is whether this is THIS APP's report.
        return {}, (
            f"the last response was HTTP {code} and is not this app's health report -- no "
            f"`status`/`build`/`data` section, so the box may still be booting, `/api/health` "
            f"may itself be failing, or something else answered: {code_span(snippet(body))}"
        )
    return parsed, None


def assess(tag: str, health_body: str, health_status: int) -> Verdict:
    """`health_body` is exactly the body `/api/health` returned (`app/src/lib/health.ts`'s
    `HealthReport`, serialized) -- or a challenge page, or an HTML 502, or nothing at all. The
    poll runs up to 30 times, so none of those may raise; each must read as "not yet", and each
    must be distinguishable afterwards, which is what `read_a_build` carries.
    """
    parsed_tag = parse_promoted_tag(tag)
    if parsed_tag is None:
        return Verdict(
            outcome=BAD_TAG,
            reason=(
                f"'{inline(tag)}' does not match the warehouse-YYYY.MM-<sha> shape image.yml "
                "publishes -- refusing to compare the live build against a tag that was "
                "never a real image"
            ),
            expected_warehouse=None,
            expected_sha=None,
            live_warehouse=None,
            live_sha=None,
            live_status=None,
        )
    expected_warehouse, expected_sha = parsed_tag

    health, unreadable = read_health(health_body, health_status)
    if unreadable:
        return Verdict(
            outcome=UNREADABLE,
            reason=unreadable,
            expected_warehouse=expected_warehouse,
            expected_sha=expected_sha,
            live_warehouse=None,
            live_sha=None,
            live_status=None,
        )

    # `build` is a dict by construction: `read_health` rejects anything that is not this app's
    # report before we reach here, and `is_health_report` is what guarantees the type. A second
    # `isinstance(build, dict)` guard stood here after that gate went in and was UNREACHABLE --
    # a mutant flipping its outcome changed nothing, which is how it was found.
    build = health["build"]
    live_warehouse = build.get("warehouse")
    live_sha = build.get("sha")
    # A str by construction -- `is_health_report` is what guarantees that, and it has already run.
    live_status = health["status"]

    if live_warehouse == expected_warehouse and live_sha == expected_sha:
        # The BUILD first, the status second, and the order is load-bearing: see the module
        # docstring. Only `ok` confirms -- an allow-list, so a status this app never emits
        # ("starting", an intermediary's own word, a case variant) cannot end the poll either.
        if live_status != "ok":
            return Verdict(
                outcome=DEGRADED,
                reason=(
                    f"the box is serving the promoted build ({expected_warehouse} / "
                    f"{expected_sha}) but /api/health reports `{inline(live_status)}`: "
                    f"{inline(health_cause(health))}"
                ),
                expected_warehouse=expected_warehouse,
                expected_sha=expected_sha,
                live_warehouse=live_warehouse,
                live_sha=live_sha,
                live_status=live_status,
            )
        return Verdict(
            outcome=MATCHED,
            reason=f"live matches the promoted tag ({expected_warehouse} / {expected_sha})",
            expected_warehouse=expected_warehouse,
            expected_sha=expected_sha,
            live_warehouse=live_warehouse,
            live_sha=live_sha,
            live_status=live_status,
        )
    return Verdict(
        outcome=MISMATCH,
        reason=(
            f"live is '{inline(live_warehouse)}' / '{inline(live_sha)}', want "
            f"'{expected_warehouse}' / '{expected_sha}'"
        ),
        expected_warehouse=expected_warehouse,
        expected_sha=expected_sha,
        live_warehouse=live_warehouse,
        live_sha=live_sha,
        live_status=live_status,
    )


def _exhausted(argv: list[str]) -> int:
    """`--exhausted <tag> <http-status> <body> <attempts>`.

    The poll triple sits in the same order as the per-attempt shape below, deliberately: the
    workflow passes the same two variables it has been passing all along, plus the loop counter.

    Each line becomes its own `::error::` annotation (Actions parses those per line) and the
    whole report also goes to the step summary. That summary write is what replaces
    `printf '%s' "$body" | jq .` on this path -- a pipe that wrote NOTHING whenever the body was
    not JSON, which is every case this path exists to report, and printed `jq: parse error` in
    place of it.
    """
    if len(argv) < 6:
        print("usage: promote_check.py --exhausted <tag> <http-status> <body> <attempts>")
        return 64
    verdict = assess(argv[2], argv[4], int(argv[3] or 0))
    report = verdict.exhausted_report(int(argv[5] or 0))
    for line in printable(report).splitlines():
        print(f"::error::{line}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write(
                printable(
                    "\n".join(
                        ["### The promoted build was not confirmed", ""]
                        + [f"- {line}" for line in report.splitlines()]
                    )
                )
                + "\n"
            )
    # Always non-zero: the budget elapsed without the box confirming the build, whatever the
    # reason turned out to be.
    return 1


def main() -> int:
    """Three call shapes. The first is dispatched on an explicit flag because it asks a
    different QUESTION -- not "is it there yet" but "what is this run entitled to conclude from
    having never seen it" -- and the other two stay dispatched on argument count:

      promote_check.py --exhausted <tag> <status> <body> <attempts>  -- the poll budget elapsed
      promote_check.py --validate <tag>                              -- validate-only
      promote_check.py <tag> <http-status> <health-report-json>      -- one poll attempt

    The poll shape's exit code is a three-way answer, not a boolean: 0 matched (the loop ends),
    2 a build was read and it disagreed, 1 nothing readable came back. A usage error is 64, off
    those values deliberately, so a mis-wired call can never be mistaken for a verdict.

    VALIDATE-ONLY carries an explicit flag rather than being inferred from a bare argument
    count: it and a successful poll both exit 0, so a call that lost two argv entries would have
    read as "validated, fine" and declared a promote successful with zero verification. It
    exists so `promote.yml` can fast-fail on a typo'd tag before it ever enters
    the 30-attempt/300s poll loop. Without it, `assess()`'s own shape check already reports the
    same failure -- correctly -- but only after the full budget elapses, because it's called
    once per attempt from inside the loop. This path calls `parse_promoted_tag` directly and
    returns before anything about a live build enters the picture: there is no health report to
    compare against yet, so there is no `Verdict` and nothing is written to `GITHUB_OUTPUT`.

    The poll shape is called once per attempt (`promote.yml`'s "Wait for the box to be serving
    it" loops up to 30 times). Exit code there is what the workflow's `if ...; then break; fi`
    reads: 0 means the loop is done, 1 means keep polling. `GITHUB_OUTPUT` is also written every
    call, mirroring `freshness.py`'s shape, so the final attempt's verdict is available to any
    later step without the workflow having to re-parse this script's stdout.
    """
    if len(sys.argv) >= 2 and sys.argv[1] == "--exhausted":
        return _exhausted(sys.argv)

    if len(sys.argv) == 3 and sys.argv[1] == "--validate":
        tag = sys.argv[2]
        if parse_promoted_tag(tag) is not None:
            return 0
        print(
            printable(
                f"'{inline(tag)}' does not match the warehouse-YYYY.MM-<sha> shape image.yml "
                "publishes (e.g. warehouse-2026.05-6ea164b) -- not entering the health poll for "
                "a tag that was never a real image"
            )
        )
        return 1

    if len(sys.argv) < 4:
        print("usage: promote_check.py <tag> [<http-status> <health-report-json>]")
        return 64
    tag = sys.argv[1]
    verdict = assess(tag, sys.argv[3], int(sys.argv[2] or 0))
    print(printable(verdict.reason))

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            fh.write(f"matched={'1' if verdict.matched else '0'}\n")
            write_multiline_output(fh, "reason", verdict.reason)

    if verdict.matched:
        return 0
    # 2, not 1, when a build WAS read. `code`/`body` are overwritten every iteration, so a
    # verdict built from the last attempt alone is a verdict about one sample: 29 attempts
    # reporting the wrong build (a genuine mismatch, which earns the unconditional rollback)
    # followed by one flaky challenge would report that the poll never read the box, and
    # DOWNGRADE an earned order to the conditional blind path. The loop cannot see that
    # difference from a bare pass/fail, so it rides on the exit code and promote.yml keeps the
    # last attempt that returned 2.
    return 2 if verdict.read_a_build else 1


if __name__ == "__main__":
    raise SystemExit(main())
