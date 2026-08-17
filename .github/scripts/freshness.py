"""Alert when `max(year_month)` has not advanced in ~45 days.

CLAUDE.md states this as a hard rule, and it names the failure it exists to catch: a broken
ingest does not error. The site keeps serving, every page renders, and `DATA AS OF` -- the
element this product's credibility rests on -- simply stops moving. Nothing goes red.

WHY THIS READS RELEASES AND NOT THE JOB'S EXIT CODE
    A run that exits 0 while the data does not advance is the actual failure mode, and an
    exit-code check cannot see it. So this measures the DATA's movement.

WHY THERE IS NO STATE FILE
    `warehouse.yml` publishes a release ONLY when the month advances -- its "Stop if this month
    is already published" guard skips the publish otherwise. So `publishedAt` of the newest
    well-formed `warehouse-YYYY.MM` release IS the timestamp of the last advance, and the
    release history is already the durable record of it. Nothing here needs to remember
    anything between runs.

    That is a COUPLING, not a coincidence: change that guard so it publishes on an unchanged
    month and this derivation silently becomes "when did we last run", which would report
    healthy forever. warehouse.yml carries a comment pointing here.

WHY IT IS A SEPARATE WORKFLOW
    A check inside `warehouse.yml` cannot see `warehouse.yml` failing before it, being disabled,
    or being deleted. An alert that shares a fate with the thing it watches is not an alert.

WHY THE THRESHOLD IS ABOUT MOVEMENT, NOT RECENCY
    BTS publishes with a 2-6 month lag by nature. `max(year_month)` is SUPPOSED to trail today
    by months, so an absolute-recency check would fire constantly and be ignored inside a week.
    45 days is ~30 days of healthy monthly cadence plus two weeks of slack.

Tag selection reuses `warehouse.yml`'s resolver rules verbatim, for the reasons measured there:
the full-shape regex (a prefix check constrains the prefix only, and git ref names permit
backticks, `$`, `;` and quotes), `publishedAt` never `createdAt` (GitHub stamps `created_at`
from the tag's COMMIT, so two releases a month apart can carry identical values), and ascending
order taking the LAST element -- never `reverse` then first, which turns a tie into the older tag.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime

from gha import write_multiline_output

#: Days without `max(year_month)` advancing before a human is told. See the module docstring for
#: why this is a movement threshold and not a recency one. Quoted in the issue body, so an
#: operator reading the alert never has to come here to learn what it was measured against.
THRESHOLD_DAYS = 45

#: Full shape, anchored both ends -- NOT `startswith("warehouse-")`.
_TAG = re.compile(r"^warehouse-[0-9]{4}\.[0-9]{2}$")

_NO_RELEASE = "no well-formed `warehouse-YYYY.MM` release exists in this repository at all"


@dataclass(frozen=True)
class Verdict:
    stale: bool
    cause: str
    latest_tag: str | None
    days: int | None

    def issue_body(self) -> str:
        """Every fact the alert already holds, so the operator never reads the Actions log to
        learn what the alert measured. The two cases build separate bodies rather than sharing a
        template with holes in it: the no-release case has no tag and no lag, and a shared
        template would render "None days" -- a fabricated measurement."""
        if self.latest_tag is None:
            lines = [
                f"`max(year_month)` cannot be checked for movement: {_NO_RELEASE}.",
                "",
                "This is either a repository that has never completed a `Warehouse` run, or one "
                "whose releases have been deleted. Both need a human.",
            ]
        else:
            lines = [
                f"`max(year_month)` has not advanced in **{self.days} days**, against a "
                f"threshold of {THRESHOLD_DAYS}.",
                "",
                f"The newest warehouse release is **`{self.latest_tag}`**, published "
                f"{self.days} days ago. `warehouse.yml` publishes only when the month advances, "
                "so that timestamp is when the dataset last moved.",
                "",
                "BTS runs a 2-6 month lag by design, so a trailing `DATA AS OF` is normal and "
                "is not what this alert is about. What is being reported is that it stopped "
                "MOVING.",
            ]
        return "\n".join(
            lines
            + [
                "",
                "## What to check",
                "",
                "1. The `Warehouse` workflow's recent runs. A failing run is the easy case.",
                "2. A run that went GREEN without publishing is the case this alert exists for "
                "-- read its `classify` step summary.",
                "3. BTS itself: `transtats.bts.gov` releaseinfo, in case upstream genuinely has "
                "not published.",
                "",
                "If upstream is simply late, close this. It will re-file if the stall continues.",
            ]
        )


def assess(
    releases: list[dict],
    now: datetime,
    threshold_days: int = THRESHOLD_DAYS,
) -> Verdict:
    """`releases` is exactly what `gh release list --json tagName,publishedAt` emits."""
    candidates = [
        (datetime.fromisoformat(r["publishedAt"]), r["tagName"])
        for r in releases
        if r.get("publishedAt") and _TAG.match(r.get("tagName") or "")
    ]
    if not candidates:
        return Verdict(stale=True, cause=_NO_RELEASE, latest_tag=None, days=None)
    # max() over (datetime, tag) is ascending-order-take-last: newest wins, and an exact
    # timestamp tie falls to the greater TAG rather than to input order.
    published, tag = max(candidates)
    days = (now - published).days
    return Verdict(
        stale=days > threshold_days,
        cause=f"`{tag}` was published {days} days ago (threshold {threshold_days})",
        latest_tag=tag,
        days=days,
    )


def _now() -> datetime:
    """`FRESHNESS_NOW` overrides the clock so the alert can be demonstrated firing against the
    REAL release history and the REAL comparison, varying only the clock.

    It arrives as an empty STRING when the workflow's `as_of` input is left blank -- Actions
    sets every declared env key -- so emptiness is the normal case, not an error.
    """
    injected = os.environ.get("FRESHNESS_NOW", "").strip()
    return datetime.fromisoformat(injected) if injected else datetime.now(UTC)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: freshness.py <releases-json>")
        return 0
    verdict = assess(json.loads(sys.argv[1]), _now())

    report = [
        f"## Freshness — {'STALE' if verdict.stale else 'ok'}",
        "",
        f"- {verdict.cause}",
    ]
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write("\n".join(report) + "\n")
    print("\n".join(report))

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            # Always written, both branches: the workflow's own step conditions read it, and a
            # key that exists only on failure is a key whose absence has two meanings.
            fh.write(f"stale={'1' if verdict.stale else '0'}\n")
            if verdict.stale:
                fh.write("file_issue=1\n")
                write_multiline_output(fh, "issue_body", verdict.issue_body())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
