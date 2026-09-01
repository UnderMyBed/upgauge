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

from gha import (
    code_span,
    health_cause,
    inline,
    is_health_report,
    printable,
    snippet,
    write_multiline_output,
)

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
        # Whatever arrived before the transfer died: `{"status":"ok"` from an origin that began
        # answering and then hung is a different finding from nothing at all, and those bytes
        # are the only thing that tells them apart.
        partial = f" What did arrive: {code_span(snippet(body))}" if body.strip() else ""
        return {}, (
            "/api/health could not be fetched -- curl did not complete the transfer, so no "
            "response was read in full and nothing here is a claim about the site's health."
            f"{partial}"
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
    if not is_health_report(parsed):
        return {}, (
            f"/api/health answered HTTP {code} with JSON that is not a health report: "
            f"{code_span(snippet(body))} -- {_BLIND}"
        )
    return parsed, None


def read_newest_month(body: str) -> tuple[str, str | None]:
    """`(newest-month, None)` when the body is a pivot result, `("", why-not)` when it is
    anything else.

    Same contract and same reason as `read_health`: a challenge page, an HTML error page and a
    proxy failure are all "not a pivot result", and none of them is evidence about the data
    layer. Reporting one as a stale window would assert a cause nobody observed.

    The workflow asks for a SINGLE month (`t=$asof:$asof`) grouped by `year_month`, so a correct
    answer is exactly one row naming that month. Reading `max()` rather than `rows[0]` keeps
    this independent of the query's sort, which is a property of the URL and not of the check.
    """
    if not body.strip():
        return "", "empty"
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return "", f"answered with a body that is not JSON: {code_span(snippet(body))}"
    if not isinstance(parsed, dict) or not isinstance(parsed.get("rows"), list):
        return "", f"answered with JSON that is not a pivot result: {code_span(snippet(body))}"
    months = [
        r["year_month"]
        for r in parsed["rows"]
        if isinstance(r, dict) and isinstance(r.get("year_month"), str)
    ]
    if not months:
        # Distinguished from an unreadable body by the CALLER, which names the month that was
        # asked for: the query reached the data layer and the data layer had nothing for it.
        return "", None
    return max(months), None


def assess(
    health_body: str,
    health_status: int,
    releases: list[dict],
    sitemap: str,
    cf_cache_status: str,
    ratelimit_status: int,
    *,
    pivot_body: str,
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
            # `health_cause` is total by construction and SHARED with promote_check: `data` is a
            # dict (checked in read_health) but its CONTENTS are not this app's to guarantee once
            # anything else can serve JSON, and a TypeError out of `", ".join(5)` would be the
            # same crash by another route. Both watchdogs render one box's cause one way.
            cause = health_cause(health)
            failures.append(f"/api/health reports `{inline(status)}`: {inline(cause)}")

        live_warehouse = health["build"].get("warehouse")
        published = [r["tagName"] for r in releases if _TAG.match(r.get("tagName") or "")]
        newest = max(published) if published else ""
        if newest:
            if not isinstance(live_warehouse, str) or not live_warehouse:
                # `... or ""` turned a missing warehouse into an empty one and then compared it,
                # reporting a forgotten promote out of a report that never named a build. Same
                # default-for-missing the <loc> and cf-cache-status branches already refuse.
                failures.append(
                    "/api/health named no warehouse in its `build` section, so what the site is "
                    f"serving could not be compared against the published `{inline(newest)}`"
                )
            elif live_warehouse != newest:
                failures.append(
                    f"the site is serving `{inline(live_warehouse)}` but `{inline(newest)}` is "
                    "published -- a promote was forgotten, and the release-based freshness "
                    "alert cannot see this"
                )

        # THE PROBE ASKS ABOUT CURRENT DATA, BY CONSTRUCTION (#156). The window was hand-spelled
        # `t=2025-05:2026-04` in the workflow and in deploy.md, and nothing reddened as it
        # decayed: bounds.ts admits any in-window range and the dataset's floor never moves, so
        # the pin stayed valid forever while receding a month further into the past with every
        # refresh. It had drifted from "is production serving current data?" to "is production
        # serving a fixed historical slice?" -- a strictly weaker question, reached silently.
        #
        # So this asserts the RELATIONSHIP rather than a window: the month /api/pivot can
        # retrieve IS the month the site reports as DATA AS OF. Both halves are read from the
        # site on every run, so there is no constant left to rot.
        # SUPPRESSED unless the report says `ok`, for the reason an unreadable body suppresses
        # the two checks above: a degraded box answers 503 with `asOf: null` and NAMES its own
        # cause in `data.missing`, so a second failure saying the month could not be compared
        # asserts nothing that report did not already say, in the same alert.
        as_of = health["data"].get("asOf") if status == "ok" else "suppressed"
        if as_of == "suppressed":
            pass
        elif not isinstance(as_of, str) or not as_of:
            failures.append(
                "/api/health named no `asOf` in its `data` section, so the month the site "
                "claims to serve could not be compared against what /api/pivot returns"
            )
        else:
            newest, unreadable_pivot = read_newest_month(pivot_body)
            if unreadable_pivot == "empty":
                failures.append(
                    "the /api/pivot currency probe returned an empty body, so whether the "
                    f"query path can retrieve the served month was never measured -- {_BLIND}"
                )
            elif unreadable_pivot:
                failures.append(
                    f"the /api/pivot currency probe {unreadable_pivot}, so whether the query "
                    f"path can retrieve the served month was never measured -- {_BLIND}"
                )
            elif not newest:
                failures.append(
                    f"/api/health reports `DATA AS OF {inline(as_of)}` but /api/pivot returned "
                    "no rows for that month -- the query path reached the data layer and the "
                    "data layer had nothing for the month the site claims to serve"
                )
            elif newest != as_of:
                failures.append(
                    f"/api/health reports `DATA AS OF {inline(as_of)}` but the newest month "
                    f"/api/pivot returns is `{inline(newest)}` -- the two disagree, so the "
                    "served pages and the query path are not describing the same dataset"
                )

    if base_url not in sitemap:
        m = _LOC_HOST.search(sitemap)
        if m:
            failures.append(
                f"/sitemap.xml does not carry `{base_url}` -- found `{inline(m.group(1))}` "
                "instead, so "
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

    cf = cf_cache_status.strip()
    if cf.upper() not in _CACHED:
        if not cf or cf.lower() == "absent":
            # `absent` is the workflow's sentinel for "no cf-cache-status header came back".
            # A challenge page carries none either, so the header's ABSENCE cannot support a
            # claim about the edge's caching -- same evidence rule as the <loc> branch above.
            failures.append(
                "a second fetch of /watch carried no `cf-cache-status` header at all, so the "
                "response never reached the edge's cache path and HTML caching was never "
                "measured"
            )
        else:
            failures.append(
                f"a second fetch reported `cf-cache-status: {inline(cf_cache_status)}` -- the "
                "edge is "
                "not caching HTML, so every repeat visit reaches the origin"
            )

    if ratelimit_status != 429:
        if 200 <= ratelimit_status < 300:
            failures.append(
                f"a burst on /api/ returned {ratelimit_status}, not 429 -- the rate limit is "
                "not in force"
            )
        else:
            # The burst never reached /api/pivot, so it measured nothing about the rule. Saying
            # "the rate limit is not in force" here sends an operator to check a Cloudflare rule
            # that is fine, on a run whose real finding is that it could not reach the site.
            failures.append(
                f"a burst on /api/ ended in HTTP {ratelimit_status}, neither 429 nor a success "
                "-- it never reached /api/pivot, so whether the rate limit is in force was "
                "never measured"
            )

    return LiveVerdict(failures=failures)


def main() -> int:
    if len(sys.argv) < 8:
        # NOT 0, unlike every site verdict below. Returning 0 here made a MIS-WIRED workflow a
        # green run with no `file_issue` and no issue, forever -- a silent watchdog, which is
        # the failure class this whole script exists to end. A broken invocation is not a site
        # condition: scheduled-failure.yml is the right reporter for it.
        print(
            "usage: live_check.py <health> <health-status> <releases> <sitemap> "
            "<cf-cache-status> <rl-status> <pivot>",
            file=sys.stderr,
        )
        return 64
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
        pivot_body=sys.argv[7],
    )

    report = ["## Live check - " + ("FAILED" if verdict.failed else "ok"), ""] + [
        f"- {f}" for f in verdict.failures
    ]
    # printable() at the boundary, not only on bodies: `open()` is strict under every locale,
    # so a surrogate anywhere in a rendered line kills the write -- and with it the file_issue
    # output and the issue. See gha.printable.
    rendered = printable("\n".join(report))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write(rendered + "\n")
    print(rendered)

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
