"""Check the SERVED site, which is the only place several of these claims are checkable.

WHY THIS EXISTS ALONGSIDE freshness.py
    That alert reads the release history -- `publishedAt` and the data's own max(year_month)
    -- both of which sit UPSTREAM of the box. A warehouse that published correctly and was
    never promoted leaves it green forever while `DATA AS OF` on the served page stops
    advancing. Nothing upstream of the box can see a box that did not get the image.

WHY THE WORKFLOW FETCHES AND THIS DECIDES
    Same split as freshness.py: the verdict is a pure function of values, so it is unit
    testable without a network. The workflow curls; this judges.

WHY AN UNREADABLE BODY IS A VERDICT AND NOT AN EXCEPTION
    `json.loads` on the health body raised out of `main()`, so the verdict, the `file_issue`
    output, the dedupe step and `gh issue create` never ran: the script whose entire purpose is
    to file an issue when the site is wrong filed nothing, precisely when it could not see the
    site. `main()` returns 0 in both branches for exactly this reason -- the ISSUE is the alert,
    not the red run -- and a raised decode error defeated that design.

    A body that is non-empty and not JSON is a legitimate OBSERVATION about the site: it is what
    a challenge page, a 5xx HTML error page and a proxy failure all look like. So it is reported,
    with its HTTP status and its first bytes, exactly as `_LOC_HOST` names the host the sitemap
    DID carry -- CLAUDE.md's "a 404 names which way it failed", applied to an alert.

    Two things follow, and both are load-bearing:

      - The parse happens inside `assess()`, not in `main()`. A body that did not parse must
        SUPPRESS the two health-derived checks: `{}` has no `build`, so carrying on would report
        a forgotten promote that was never observed -- a second failure asserting a cause, in
        the same alert that just said it could not read the site.
      - Unreadability is a property of the BODY, never of the status. `/api/health` answers 503
        with a complete, valid report when the data layer is degraded
        (`app/src/app/api/health/route.ts:27`), and that is a real reading of the box.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass

from gha import code_span, snippet, write_multiline_output

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

#: What every "I could not read it" finding ends with. The two readings are equally consistent
#: with the evidence and the alert is not entitled to pick one.
_BLIND = (
    "an edge challenge page, an HTML error page and an origin that is down all look like this "
    "from here, and none of them says anything about the build the box is serving"
)


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


def read_health(body: str, http_status: int) -> tuple[dict, str | None]:
    """`(report, None)` when the body is a health report, `({}, why-not)` when it is anything
    else. See the module docstring for why the status never decides this.

    `http_status` is curl's `%{http_code}`: 0 (`000`) means no response line arrived at all,
    which is a different finding from a server that answered with something unusable.
    """
    code = f"{http_status:03d}"
    if http_status == 0:
        return {}, (
            "/api/health could not be fetched at all -- curl reported no HTTP status, so "
            "nothing was read from the box and nothing here is a claim about its health"
        )
    if not body.strip():
        return {}, (
            f"/api/health answered HTTP {code} with an empty body, which is not a health "
            f"report -- {_BLIND}"
        )
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return {}, (
            f"/api/health answered HTTP {code} with a body that is not JSON: "
            f"{code_span(snippet(body))} -- {_BLIND}"
        )
    if not isinstance(parsed, dict):
        return {}, (
            f"/api/health answered HTTP {code} with JSON that is not an object: "
            f"{code_span(snippet(body))} -- {_BLIND}"
        )
    return parsed, None


def assess(
    health_body: str,
    health_status: int,
    releases: list[dict],
    sitemap: str,
    cf_cache_status: str,
    ratelimit_status: int,
    base_url: str = "https://upgauge.shipman.dev",
) -> LiveVerdict:
    """Every argument is a measured value, so this stays a pure function of them -- and the
    health BODY is the measured value, the parsed report a derivation of it."""
    failures: list[str] = []

    health, unreadable = read_health(health_body, health_status)
    if unreadable:
        # Both checks below read the report. Neither was observed, so neither is reported.
        failures.append(unreadable)
    else:
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
                f"the site is serving `{live_warehouse}` but `{newest}` is published -- a "
                "promote was forgotten, and the release-based freshness alert cannot see this"
            )

    if base_url not in sitemap:
        m = _LOC_HOST.search(sitemap)
        if m:
            failures.append(
                f"/sitemap.xml does not carry `{base_url}` -- found `{m.group(1)}` instead, so "
                "UPGAUGE_BASE_URL is wrong and every <loc> and every canonical points somewhere "
                "a crawler cannot resolve"
            )
        else:
            # The UPGAUGE_BASE_URL diagnosis is licensed by a <loc> that WAS found carrying
            # another host. With no <loc> at all there is no such evidence, and the run that
            # cannot read /api/health cannot read this either -- naming a config variable here
            # sends an operator after a setting that is probably correct.
            failures.append(
                f"/sitemap.xml did not answer with a sitemap -- no <loc> carrying a scheme and "
                f"host at all, so nothing here says where the site's canonicals point: "
                f"{code_span(snippet(sitemap))}"
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
    if len(sys.argv) < 7:
        print(
            "usage: live_check.py <health> <health-status> <releases> <sitemap> "
            "<cf-cache-status> <rl-status>"
        )
        return 0
    verdict = assess(
        sys.argv[1],
        int(sys.argv[2] or 0),
        # `releases` is deliberately NOT parse-guarded the way the health body is: it comes from
        # `gh`, not from the edge. live-check.yml already retries that listing five times and
        # exits rather than let a failed one through as empty, so a body that does not parse
        # here is a broken TOOL, not an observation about the site -- scheduled-failure.yml is
        # what reports that, and folding it into a LiveVerdict would file a `live-red` issue
        # naming the wrong subject.
        json.loads(sys.argv[3] or "[]"),
        sys.argv[4],
        sys.argv[5],
        int(sys.argv[6] or 0),
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
