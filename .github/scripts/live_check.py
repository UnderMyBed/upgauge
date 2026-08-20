"""Check the SERVED site, which is the only place several of these claims are checkable.

WHY THIS EXISTS ALONGSIDE freshness.py
    That alert reads the release history -- `publishedAt` and the data's own max(year_month)
    -- both of which sit UPSTREAM of the box. A warehouse that published correctly and was
    never promoted leaves it green forever while `DATA AS OF` on the served page stops
    advancing. Nothing upstream of the box can see a box that did not get the image.

WHY THE WORKFLOW FETCHES AND THIS DECIDES
    Same split as freshness.py: the verdict is a pure function of values, so it is unit
    testable without a network. The workflow curls; this judges.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass

from gha import write_multiline_output

_TAG = re.compile(r"^warehouse-[0-9]{4}\.[0-9]{2}$")

#: First `<loc>`'s scheme+host, for naming what the sitemap actually carries instead of only
#: what it should have. A message that says "does not carry the right host" without saying
#: which host it DID find makes an operator go read the sitemap by hand to learn the one fact
#: this check already has -- CLAUDE.md's "a 404 names which way it failed" rule, applied to
#: this alert instead of a page.
_LOC_HOST = re.compile(r"<loc>(https?://[^/]+)")

#: The origin sets a cache header on HTML. Cloudflare does not cache text/html by default, so
#: a MISS on a SECOND fetch of the same URL means the Cache Rule is absent and every repeat
#: visit is reaching the box -- the cost model's central assumption, unasserted until now.
_CACHED = {"HIT", "STALE", "UPDATING", "REVALIDATED"}


@dataclass(frozen=True)
class LiveVerdict:
    failures: list[str]

    @property
    def failed(self) -> bool:
        return bool(self.failures)

    def issue_body(self) -> str:
        """Built FROM `failures`, never from a template with holes: an operator must be able to
        act on the body alone, and a fixed template silently drops whatever check a later edit
        adds."""
        return "\n".join(
            ["The served site failed a post-deploy check.", ""]
            + [f"- {f}" for f in self.failures]
            + [
                "",
                "## What to check",
                "",
                "1. `/api/health` on the live site -- it names its own cause.",
                "2. `upgauge-deploy.timer` on the box (Hetzner browser console).",
                "3. The most recent `Promote` run: a tag can move without the box following.",
                "",
                "Runbook: `docs/architecture/deploy.md`.",
            ]
        )


def assess(
    health: dict,
    releases: list[dict],
    sitemap: str,
    cf_cache_status: str,
    ratelimit_status: int,
    base_url: str = "https://upgauge.shipman.dev",
) -> LiveVerdict:
    """Every argument is a measured value, so this stays a pure function of them."""
    failures: list[str] = []

    status = health.get("status")
    if status != "ok":
        data = health.get("data") or {}
        cause = ", ".join(data.get("missing") or []) or data.get("error") or "no cause reported"
        failures.append(f"/api/health reports `{status}`: {cause}")

    live_warehouse = (health.get("build") or {}).get("warehouse") or ""
    published = [r["tagName"] for r in releases if _TAG.match(r.get("tagName") or "")]
    newest = max(published) if published else ""
    if newest and live_warehouse != newest:
        failures.append(
            f"the site is serving `{live_warehouse}` but `{newest}` is published -- a promote "
            "was forgotten, and the release-based freshness alert cannot see this"
        )

    if base_url not in sitemap:
        m = _LOC_HOST.search(sitemap)
        found = m.group(1) if m else "no <loc> at all"
        failures.append(
            f"/sitemap.xml does not carry `{base_url}` -- found `{found}` instead, so "
            "UPGAUGE_BASE_URL is wrong and every <loc> and every canonical points somewhere a "
            "crawler cannot resolve"
        )

    if cf_cache_status.upper() not in _CACHED:
        failures.append(
            f"a second fetch reported `cf-cache-status: {cf_cache_status}` -- the edge is not "
            "caching HTML, so every repeat visit reaches the origin"
        )

    if ratelimit_status != 429:
        failures.append(
            f"a burst on /api/ returned {ratelimit_status}, not 429 -- the rate limit is not in "
            "force"
        )

    return LiveVerdict(failures=failures)


def main() -> int:
    if len(sys.argv) < 6:
        print("usage: live_check.py <health> <releases> <sitemap> <cf-cache-status> <rl-status>")
        return 0
    verdict = assess(
        json.loads(sys.argv[1] or "{}"),
        json.loads(sys.argv[2] or "[]"),
        sys.argv[3],
        sys.argv[4],
        int(sys.argv[5] or 0),
    )

    report = ["## Live check - " + ("FAILED" if verdict.failed else "ok"), ""] + [
        f"- {f}" for f in verdict.failures
    ]
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write("\n".join(report) + "\n")
    print("\n".join(report))

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as fh:
            # Always written, both branches: a key that exists only on failure is a key whose
            # absence has two meanings.
            fh.write(f"failed={'1' if verdict.failed else '0'}\n")
            if verdict.failed:
                fh.write("file_issue=1\n")
                write_multiline_output(fh, "issue_body", verdict.issue_body())
    # Exit 0 either way: the ISSUE is the alert. A non-zero exit would ALSO trip
    # scheduled-failure.yml, filing two issues for one condition.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
