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
`promote.yml`. Pure functions (`assess`, `Verdict.exhausted_report`) carry every decision.
Two callers use them: `promote.yml` calls `main()` as `--validate <tag>` to fast-fail a typo'd
dispatch input, and `deploy/promote.py` (`make promote`) polls `/api/health` from the
operator's machine and decides the deploy through `assess` and `exhausted_report`.

WHAT THE CONFIRMATION IS ENTITLED TO CONCLUDE WHEN IT RUNS OUT OF ATTEMPTS
    An exhausted poll once emitted, unconditionally, "The tag moved; the deploy did not" and
    "ROLL BACK NOW". On 2026-08-1x it emitted both against a healthy, correctly-promoted deploy:
    every one of the 30 attempts had been served a challenge page, so the poll had never read
    the box at all. Telling an operator to roll back a good deploy is worse than staying silent
    -- a rollback is a real production action.

    So the report is built from what was OBSERVED, and `UNREADABLE` is the boundary:

      - a build was read and it disagrees -> the box is up and never took the image, `:deploy`
        still points at that image, and promoting a tag that SERVES is the remedy, ordered
        outright. "The previous known-good tag" names one only while the build the box is on is
        serving; this branch has read that build's status, so it says which.
      - no build was ever read -> the finding is that the poll is blind, and it is NOT evidence
        the deploy failed. It is not evidence the deploy SUCCEEDED either: `docker compose up -d
        --wait` recreates the container before confirming health, so an image that fails to start
        closes the port and the real emergency arrives looking exactly like an edge that refuses
        this machine. The report says so, gives the one command that separates them, and keeps
        the remedy conditional on it.

    Unreadability is a property of the BODY, never of the status: `/api/health` answers 503 with
    a complete, valid report when the data layer is degraded
    (`app/src/app/api/health/route.ts:27`), and a wrong build read from one of those is an
    ordinary mismatch.

A MATCHING BUILD IS NOT A DEPLOY (#79)
    `build` is baked from the Dockerfile's runtime build args and `health.ts`'s `identity()`
    computes it before every return branch, so a degraded report carries the promoted sha and
    warehouse VERBATIM -- and the route serves that report under a 503 with the body unchanged.
    Comparing build identity alone therefore returned `matched` on the first poll attempt against
    a box answering 503 to every visitor, and the poll confirmed the deploy on it. The hourly
    watchdog read `status` and this one, holding the rollback decision, did not.

    So `MATCHED` requires `status == "ok"` -- an allow-list, never `!= "degraded"`, because
    `is_health_report` requires `status` to be a string and nothing further. And the BUILD is
    compared first: a box still serving the old image and reporting degraded is telling the poll
    about an image nobody promoted, which is a mismatch and nothing else.

    THE RULE GOVERNS THE HAND CHECK TOO. The blind branch reads no status because it read no
    body, so what it emits is the rule for the operator who will read one -- and a rule that
    clears on the build alone hands out this same false all-clear from a human's terminal
    instead of from this script. Compose the two open realities to see it: the poll is served a
    challenge page for the full budget (#77) WHILE the box serves 503 on the correctly-promoted
    image (#79). So that branch's decision rule carries the status clause the degraded branch
    earned, and only the promoted build under `ok` is an all-clear.

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
)

#: The shape `image.yml` mints and `warehouse.yml` asserts before ever publishing a release.
#: Anchored at the start only -- the SHA half is deliberately unconstrained, since it is
#: whatever `git describe --always --dirty --abbrev=7` produces today or grows tomorrow.
_WAREHOUSE_PREFIX = re.compile(r"^(warehouse-[0-9]{4}\.[0-9]{2})-(.+)$")

#: `outcome` values. Every one but `UNREADABLE` and `BAD_TAG` read the box's own build.
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

    def exhausted_report(self, attempts: int) -> str:
        """The final word after `make promote`'s confirmation budget elapses, one finding per
        line. See the module docstring for why the branches differ in what they are allowed to
        claim, and in what they order: `UNREADABLE` is the evidence boundary, and among the
        outcomes that read a build, a wrong build and a build that cannot serve are different
        failures with different fixes."""
        if self.outcome == MISMATCH:
            # Two clauses, one condition, and what the branch RECOMMENDS is unchanged either
            # way: the box never took the new image whatever the old one is doing.
            #
            # "so it is up" is a claim about the build the box IS serving, and this branch has
            # that build's status in hand -- a box serving an old, degraded image is up and NOT
            # serving. The same status decides what the rollback TARGET may be called: the
            # remedy pins `:deploy` at a tag that SERVES, and only a serving build makes "the
            # previous known-good tag" a name for the one the box is already on.
            if self.live_status == "ok":
                up = "The box answers, so it is up"
                target = "the previous known-good tag"
            else:
                up = (
                    f"The box answers, but reports `{inline(self.live_status)}` on the build it "
                    "is serving, so it is up and not serving what it has"
                )
                # The quadrant where a new image is promoted TO FIX an outage and the box never
                # pulled it. Here "previous known-good" names a build this poll watched fail on
                # every attempt, and would send the operator back into the outage they came from.
                target = (
                    "a tag you know SERVES (not the build the box is on now, which reported "
                    "that status on every attempt)"
                )
            return "\n".join(
                [
                    f"the box is serving `{inline(self.live_warehouse)}` / "
                    f"`{inline(self.live_sha)}` after "
                    f"{attempts} attempts, not the promoted `{self.expected_warehouse}` / "
                    f"`{self.expected_sha}`. The tag moved; the deploy did not.",
                    f"{up} -- it never took the new image, and `:deploy` "
                    "still points at that image, so the box can land on it at any 30s tick. "
                    f"ROLL BACK NOW: `make promote TAG=<tag>` with {target}, "
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
                    "ROLL BACK NOW: `make promote TAG=<tag>` with the previous known-good tag. "
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
                    f"after {attempts} attempts this machine never read a build from the box: "
                    f"{self.reason}",
                    "THIS IS NOT EVIDENCE EITHER WAY. `docker compose up -d --wait` recreates "
                    "the container before confirming health, so an image that fails to start "
                    "closes the port and takes the site DOWN while the box's timer retries it "
                    "forever -- and an edge that refuses this machine looks identical from here.",
                    f"Check by hand, from a network that reaches the site: `{_HAND_CHECK}`. "
                    "If it is down, serving a build other than the promoted one, or reporting "
                    "anything but `ok`, ROLL BACK NOW: `make promote TAG=<tag>` with the "
                    "previous known-good tag. Only the promoted build under `ok` says this poll "
                    "was blind and the deploy is fine -- `/api/health` serves the promoted "
                    "identity verbatim under a 503 when the data layer is degraded, so a "
                    "matching build is not a deploy.",
                ]
            )
        if self.outcome == MATCHED:
            return (
                f"the last attempt MATCHED after {attempts} attempts, yet the confirmation did "
                f"not exit on it -- that is a bug in `deploy/promote.py`, not in the deploy: "
                f"{self.reason}"
            )
        return (
            f"{self.reason}. Nothing about the box was measured, so this says nothing about the "
            "deploy: fix the tag and re-run `make promote`."
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
    else. `http_status` is shaped like curl's `%{http_code}`: 0 (`000`) means no response line
    arrived.
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
    confirmation runs up to 30 times, so none of those may raise; each must read as "not yet",
    and each must be distinguishable afterwards, which is what `outcome` carries.
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


def main() -> int:
    """`promote_check.py --validate <tag>`: exit 0 if the tag has the shape `image.yml`
    publishes, 1 if not, 64 on any other call shape.

    It exists so `promote.yml` fast-fails a typo'd dispatch input in seconds, before a registry
    login and before `imagetools inspect` reports the same thing as a missing image. It calls
    `parse_promoted_tag` and returns: there is no health report here, so there is no `Verdict`.

    The flag is explicit rather than inferred from a bare argument count, so a call that lost
    an argv entry is a usage error, never a silent "validated, fine".
    """
    if len(sys.argv) == 3 and sys.argv[1] == "--validate":
        tag = sys.argv[2]
        if parse_promoted_tag(tag) is not None:
            return 0
        print(
            printable(
                f"'{inline(tag)}' does not match the warehouse-YYYY.MM-<sha> shape image.yml "
                "publishes (e.g. warehouse-2026.05-6ea164b) -- not re-tagging a tag that was "
                "never a real image"
            )
        )
        return 1
    print("usage: promote_check.py --validate <tag>")
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
