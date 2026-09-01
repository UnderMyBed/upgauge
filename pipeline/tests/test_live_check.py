"""The served site is the only place several of these claims are checkable at all. Each test
names the bug its assertion exists to catch -- and each was confirmed by breaking the
implementation, never by reading it.

The second family of tests here is about what this alert does when it cannot read the site at
all. `assess()` takes the health BODY and its HTTP status rather than a parsed report, because a
body that does not parse has to SUPPRESS the two health-derived checks: falling back to `{}` and
carrying on makes the alert report a forgotten promote it never observed.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from live_check import assess, main  # noqa: E402

LIVE_CHECK = Path(__file__).parents[2] / ".github" / "workflows" / "live-check.yml"

HEALTHY = {
    "status": "ok",
    "build": {"sha": "9a9511d", "warehouse": "warehouse-2026.05"},
    "data": {"asOf": "2026-05", "missing": []},
}
RELEASES = [{"tagName": "warehouse-2026.05", "publishedAt": "2026-08-14T08:01:21Z"}]
SITEMAP = "<loc>https://upgauge.shipman.dev/explore</loc>"

#: What a Cloudflare interstitial actually looks like on the wire: HTTP success, HTML body.
#: Empty would have hit the old `or "{}"` fallback and parsed -- this is the body that did not.
CHALLENGE = (
    '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>'
    '<meta http-equiv="refresh" content="390"></head><body>'
)


def _assess(health: dict, *args, health_status: int = 200, pivot_body: str | None = None, **kwargs):
    """The healthy-fetch spelling: a real report, serialized, answered with a real status.

    `pivot_body` defaults to a CURRENT probe result (resolved at call time, since the fixture is
    defined further down) so the tests that predate #156 keep describing the sites they were
    written about. The default lives here and NOT on `assess`, which requires the argument: a
    default in production would let a mis-wired workflow drop the currency check silently, and a
    silent watchdog is the failure class this script exists to end."""
    return assess(
        json.dumps(health),
        health_status,
        *args,
        pivot_body=PIVOT_CURRENT if pivot_body is None else pivot_body,
        **kwargs,
    )


def test_a_healthy_site_reports_no_failures():
    v = _assess(HEALTHY, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert v.failures == []


def test_a_forgotten_promote_is_caught():
    """THE bug this file exists for. The release-based freshness alert reads publishedAt and
    stays green while the SITE serves last month's warehouse -- nothing upstream of the box
    can see a box that never got the new image."""
    stale = {**HEALTHY, "build": {"sha": "9a9511d", "warehouse": "warehouse-2026.04"}}
    v = _assess(stale, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert any("warehouse-2026.04" in f and "warehouse-2026.05" in f for f in v.failures)


def test_localhost_in_the_sitemap_is_caught():
    """UPGAUGE_BASE_URL unset: every page renders, the sitemap validates, and every <loc>
    and canonical points at localhost. Nothing else in the system notices."""
    v = _assess(
        HEALTHY,
        RELEASES,
        "<loc>http://localhost:3000/explore</loc>",
        cf_cache_status="HIT",
        ratelimit_status=429,
    )
    assert any("localhost" in f for f in v.failures)
    assert any("UPGAUGE_BASE_URL" in f for f in v.failures)


def test_an_uncached_edge_is_caught():
    """Fact 5: Cloudflare does not cache text/html by default, so HTML_CACHE reaches an edge
    that ignores it and the whole cost model is fiction. A MISS on a second fetch is the
    symptom."""
    v = _assess(HEALTHY, RELEASES, SITEMAP, cf_cache_status="MISS", ratelimit_status=429)
    assert any("cf-cache-status" in f for f in v.failures)


def test_an_absent_rate_limit_is_caught():
    v = _assess(HEALTHY, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=200)
    assert any("rate limit" in f.lower() for f in v.failures)


def test_a_degraded_health_report_is_caught_with_its_named_cause():
    """/api/health never throws; it reports a named cause. Losing the cause turns a 503 into
    'something is wrong', which is what the endpoint exists to avoid."""
    degraded = {
        **HEALTHY,
        "status": "degraded",
        "data": {"asOf": None, "missing": ["mart_route_health"], "error": "boom"},
    }
    v = _assess(
        degraded,
        RELEASES,
        SITEMAP,
        health_status=503,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert any("mart_route_health" in f for f in v.failures)


def test_a_503_carrying_a_real_report_is_read_as_a_real_report():
    """The status code is NEVER what decides whether the body was readable. `/api/health`
    answers 503 with a complete, valid HealthReport when the data layer is degraded
    (app/src/app/api/health/route.ts:27), and that is a genuine observation of the box: it must
    produce the degraded finding, not an 'I could not read it' one."""
    degraded = {
        **HEALTHY,
        "status": "degraded",
        "data": {"asOf": None, "missing": ["fct_segment_month"], "error": "boom"},
    }
    v = _assess(
        degraded,
        RELEASES,
        SITEMAP,
        health_status=503,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert any("fct_segment_month" in f for f in v.failures)
    assert not any("could not" in f for f in v.failures)


def test_every_failure_reaches_the_issue_body():
    """A verdict that fails silently in the body is an alert an operator cannot act on."""
    stale = {**HEALTHY, "build": {"sha": "x", "warehouse": "warehouse-2026.04"}}
    v = _assess(
        stale,
        RELEASES,
        "<loc>http://localhost:3000/</loc>",
        cf_cache_status="MISS",
        ratelimit_status=200,
    )
    body = v.issue_body()
    for failure in v.failures:
        assert failure in body


# --------------------------------------------------------------------------------------
# What the alert does when it cannot read the site (#77)
# --------------------------------------------------------------------------------------


def test_a_non_json_health_body_is_reported_not_raised():
    """THE defect. `json.loads` on a challenge page raised JSONDecodeError out of `main()`, so
    the verdict, the `file_issue` output, the dedupe step and `gh issue create` all never ran --
    the script whose entire purpose is to file an issue when the site is wrong filed nothing,
    precisely when it could not see the site. A body that is non-empty and not JSON is a
    legitimate OBSERVATION, and it must carry the status and the first bytes so an operator can
    tell a challenge page from a 502 without going and fetching it by hand."""
    v = assess(
        CHALLENGE,
        403,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert v.failed
    named = [f for f in v.failures if "/api/health" in f]
    assert named, f"no failure named /api/health: {v.failures}"
    assert "403" in named[0]
    assert "Just a moment" in named[0], "the body that was actually served is not carried"


def test_an_unreadable_health_body_does_not_also_claim_a_forgotten_promote():
    """Catches the `{}` fallback surviving underneath the fix. `{}` has no `build`, so the
    release comparison would report `the site is serving `` but `warehouse-2026.05` is
    published -- a promote was forgotten`: a second failure asserting a CAUSE that was never
    observed, in the same alert that just said it could not read the site. CLAUDE.md's rule
    about re-deriving each clause of a compound claim, applied to an alert."""
    v = assess(
        CHALLENGE,
        403,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert len(v.failures) == 1, f"expected only the unreadable finding, got {v.failures}"
    assert not any("promote was forgotten" in f for f in v.failures)


def test_a_curl_failure_reports_that_the_fetch_never_completed():
    """`curl` failing outright (dropped connection, DNS, the box unreachable) is status 000 and
    an empty body -- a fetch that never completed, which is a different finding from a server
    that answered with nothing. Asserting only "does not say `None`" is not enough: collapsing
    this into the empty-body branch below still satisfies that, so the distinguishing fact --
    that no HTTP status came back at all -- is what gets asserted."""
    v = assess(
        "",
        0,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert v.failed
    named = next(f for f in v.failures if "/api/health" in f)
    assert "did not complete the transfer" in named
    assert "empty body" not in named, "collapsed into the finding below, which it is not"


def test_an_empty_body_under_a_real_status_is_reported_not_defaulted():
    """The `or "{}"` fallback's own failure mode, and the one the status-000 test above cannot
    reach: a server that DID answer, with nothing. Defaulting to `{}` makes `status` `None` and
    the alert then reads ``/api/health reports `None` `` -- a sentence about a report that was
    never served, in place of the fact that the body was empty."""
    v = assess(
        "",
        200,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert v.failed
    named = next(f for f in v.failures if "/api/health" in f)
    assert "reports `None`" not in named
    assert "empty body" in named
    assert "200" in named


def test_a_json_body_that_is_not_an_object_is_reported_not_raised():
    """A JSON array or bare scalar parses fine and then blows up on `.get`. Same class as the
    decode error and the same remedy: report what came back, do not raise."""
    v = assess(
        "[]",
        200,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert v.failed
    assert any("/api/health" in f for f in v.failures)


def test_the_health_snippet_is_carried_verbatim_and_marks_its_truncation():
    """Two bugs, both of which make the evidence lie. Stripping characters out of the body to
    make it render alters the one artifact the operator is being shown; truncating it without
    saying so makes a body that ends mid-tag indistinguishable from one that really ended
    there. The backtick matters because it is what a fixed pair of backticks would break on."""
    body = "<html>x=`1` " + ("y" * 400)
    v = assess(
        body,
        502,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    named = next(f for f in v.failures if "/api/health" in f)
    assert "x=`1`" in named, "the body was altered on its way to the operator"
    assert "[truncated]" in named, "a truncated body is presented as if it were whole"
    assert "y" * 100 in named


def test_a_sitemap_that_is_not_a_sitemap_does_not_blame_UPGAUGE_BASE_URL():
    """A3. The same blind run that cannot read /api/health cannot read /sitemap.xml either, and
    a challenge page contains no <loc> -- so this check reported `UPGAUGE_BASE_URL is wrong`, a
    diagnosis it never made, fired by the very condition being fixed. The BASE_URL claim is
    licensed only by a <loc> that was actually found carrying another host."""
    v = assess(
        json.dumps(HEALTHY),
        200,
        RELEASES,
        CHALLENGE,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    named = next(f for f in v.failures if "sitemap" in f)
    assert "UPGAUGE_BASE_URL" not in named
    assert "Just a moment" in named, "the response that was actually served is not carried"


# --------------------------------------------------------------------------------------
# Assertions about the workflow YAML, which no Python test above can reach
# --------------------------------------------------------------------------------------


def _run_scalars(path: Path) -> list[str]:
    """Every `run:` string in the file."""
    doc = yaml.safe_load(path.read_text())
    return [
        step["run"]
        for job in (doc.get("jobs") or {}).values()
        for step in (job.get("steps") or [])
        if isinstance(step, dict) and isinstance(step.get("run"), str)
    ]


def _uncommented(run: str) -> str:
    """`run` with bash comment lines removed.

    Without this, an index lookup finds the string in PROSE. Measured: the ordering test below
    resolved `/api/health` to character 104 -- inside `# /api/health is under /api/.` -- so
    moving the actual fetch after the burst left it green. Fifth instance of that shape on this
    branch, and the only pre-existing one.
    """
    return "\n".join(ln for ln in run.splitlines() if not ln.strip().startswith("#"))


def test_no_static_delimiter_output_write_of_remote_content():
    """THE fix for the Important review finding. `sitemap` is remote content fetched from the
    origin, in a job holding issues:write. A `name<<EOF ... EOF` heredoc write to
    $GITHUB_OUTPUT truncates silently if the value ever contains a line reading exactly `EOF`
    -- everything after it is then parsed as new key=value output pairs. `.github/scripts/
    gha.py`'s `write_multiline_output` exists precisely to randomize this delimiter per call,
    and its own module docstring calls a second, static-delimiter copy of the same mechanism
    "two copies of a security property... plus a place for it to be wrong." The fix removes the
    surface rather than patching it: `health`/`releases`/`sitemap` fetch and the
    `live_check.py` call now live in ONE step, so those values never leave a bash variable and
    never touch $GITHUB_OUTPUT at all. This pins both halves of that shape."""
    text = LIVE_CHECK.read_text()
    assert "<<EOF" not in text, (
        "a static-delimiter heredoc write to $GITHUB_OUTPUT reappeared -- remote content (the "
        "sitemap) can contain a line reading exactly the delimiter and truncate the value "
        "silently, with everything after it parsed as new output pairs in a job holding "
        "issues:write"
    )
    for name in ("health", "releases", "sitemap"):
        assert f"outputs.{name}" not in text, (
            f"{name} is read back via steps.*.outputs.{name} -- it crossed a step boundary "
            "through $GITHUB_OUTPUT, which is exactly the surface the fix removed"
        )


def test_health_and_sitemap_are_fetched_before_the_rate_limit_burst():
    """An ordering, asserted as an ordering -- CLAUDE.md's rule: when the property is a
    position, assert the position, never the set of things present. The burst deliberately
    trips a rate limit that blocks this runner's IP on /api/ for 60s, and /api/health is under
    /api/ -- fetching health after the burst would block the check's own probe and report a
    false failure. Merging the fetch and the decision into one bash script (the fix for the
    static-delimiter finding above) makes an accidental reorder a one-line diff instead of a
    cross-step change, which is exactly what this guards."""
    run = _uncommented(next(r for r in _run_scalars(LIVE_CHECK) if "/api/health" in r))
    health_at = run.index("/api/health")
    burst_at = run.index("seq 1 80")
    assert health_at < burst_at, "the health/sitemap fetch must run BEFORE the rate-limit burst"


def test_the_workflow_captures_the_health_status_code_and_passes_it_on():
    """A script that can report the status is worth nothing if the workflow never measures one
    -- the "testing a module the workflow no longer calls" trap this repo has hit before. Scoped
    to the line that fetches /api/health, deliberately: `%{http_code}` ALREADY appears on the
    rate-limit burst's curl, so an unscoped membership check passes without the health fetch
    capturing anything at all."""
    run = next(r for r in _run_scalars(LIVE_CHECK) if "/api/health" in r)
    # Everything before the sitemap fetch, which is the health fetch and nothing else.
    health_fetch = run[: run.index("/sitemap.xml")]
    assert "/api/health" in health_fetch
    assert "%{http_code}" in health_fetch, "the health fetch measures no status"
    call = run[run.index("live_check.py") :]
    assert '"$hcode"' in call, "the measured status never reaches live_check.py"


# --------------------------------------------------------------------------------------
# A body that PARSED is not thereby a health report
# --------------------------------------------------------------------------------------

#: Every one of these is valid JSON and none is a health report. The first is a real Cloudflare
#: JSON error body; the rest are shapes an intermediary or a half-configured origin can serve.
NOT_A_REPORT = [
    '{"success":false,"errors":[{"code":1015,"message":"rate limited"}]}',
    "{}",
    '{"status": "ok", "build": "not-a-dict"}',
    # Valid `status` and `data`, bad `build` -- without this the build guard could be deleted
    # and every other fixture would still be caught by the `data` guard.
    '{"status": "ok", "build": "not-a-dict", "data": {"asOf": null, "missing": []}}',
    '{"status": "degraded", "data": "oops", "build": {"warehouse": "w", "sha": "s"}}',
    '{"build": {"warehouse": "warehouse-2026.05", "sha": "9a9511d"}}',
    # `build` and `data` both well-formed, `status` absent: without this the status clause of
    # is_health_report can be deleted with the whole suite still green, and the mutant then
    # emits the `reports `None`` string another test says must never appear.
    '{"build": {"warehouse": "w", "sha": "s"}, "data": {"asOf": null, "missing": []}}',
]


def test_json_that_is_not_a_health_report_is_reported_never_raised():
    """Suppression was keyed on "did it parse", not "is it a report", so any dict flowed into
    checks that read `build` and `data` -- and `'not-a-dict'.get(...)` raises. That is defect A
    still live: `main()` dies before the issue-filing, on a body the edge controls."""
    for body in NOT_A_REPORT:
        v = assess(
            body,
            200,
            RELEASES,
            SITEMAP,
            cf_cache_status="HIT",
            ratelimit_status=429,
            pivot_body=PIVOT_CURRENT,
        )
        assert v.failed, body
        assert len(v.failures) == 1, f"{body} -> {v.failures}"
        assert "/api/health" in v.failures[0], body


def test_a_parsed_non_report_does_not_fabricate_a_forgotten_promote():
    """The other half, and the one that does not raise. `{}` has no `build`, so the release
    comparison read `` and reported `the site is serving `` but `warehouse-2026.05` is
    published -- a promote was forgotten`: a cause invented out of a body that named no build at
    all. `docs/architecture/deploy.md` states this as a rule, so the rule and the code have to
    agree."""
    for body in NOT_A_REPORT:
        v = assess(
            body,
            200,
            RELEASES,
            SITEMAP,
            cf_cache_status="HIT",
            ratelimit_status=429,
            pivot_body=PIVOT_CURRENT,
        )
        assert not any("promote was forgotten" in f for f in v.failures), body
        assert not any("reports `None`" in f for f in v.failures), body


def test_a_health_report_whose_missing_list_is_malformed_does_not_raise():
    """`", ".join(...)` over a non-list is the last unguarded read on the degraded path."""
    body = json.dumps(
        {"status": "degraded", "build": {"warehouse": "w", "sha": "s"}, "data": {"missing": 5}}
    )
    v = assess(
        body,
        503,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert any("degraded" in f for f in v.failures)


# --------------------------------------------------------------------------------------
# Two more claims that were unreachable until the crash was fixed
# --------------------------------------------------------------------------------------


def test_an_absent_cf_cache_header_is_not_a_claim_that_the_edge_stopped_caching():
    """`cf="${cf:-absent}"` means NO `cf-cache-status` header came back. A challenge page
    carries none either, so "the edge is not caching HTML" is a diagnosis from a response that
    never reached the cache path -- the `UPGAUGE_BASE_URL` mistake in a third place."""
    v = assess(
        json.dumps(HEALTHY),
        200,
        RELEASES,
        SITEMAP,
        cf_cache_status="absent",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    named = next(f for f in v.failures if "cf-cache-status" in f)
    assert "not caching HTML" not in named
    assert "never measured" in named or "never observed" in named


def test_a_reported_cf_miss_still_reports_that_the_edge_is_not_caching():
    """Guards over-suppression. A header that says MISS IS the edge answering about its own
    cache, and that diagnosis must survive -- otherwise the fix above silences the check."""
    v = assess(
        json.dumps(HEALTHY),
        200,
        RELEASES,
        SITEMAP,
        cf_cache_status="MISS",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert any("not caching HTML" in f for f in v.failures)


def test_a_blocked_burst_is_not_a_claim_that_the_rate_limit_is_absent():
    """A burst that ends in 403 never reached `/api/pivot`, so it measured nothing about the
    rate limit -- and sends an operator to check a Cloudflare rule that is fine."""
    v = assess(
        json.dumps(HEALTHY),
        200,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=403,
        pivot_body=PIVOT_CURRENT,
    )
    named = next(f for f in v.failures if "/api/" in f and "burst" in f)
    assert "not in force" not in named
    assert "403" in named


def test_a_burst_that_got_through_still_reports_the_rate_limit_absent():
    """Guards over-suppression the other way: 80 requests answered 200 IS the measurement."""
    v = assess(
        json.dumps(HEALTHY),
        200,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=200,
        pivot_body=PIVOT_CURRENT,
    )
    assert any("not in force" in f for f in v.failures)


# --------------------------------------------------------------------------------------
# The workflow -> script argv contract, which no test above can reach
# --------------------------------------------------------------------------------------


def _argv_after(run: str, script: str) -> list[str]:
    """The quoted arguments and flags of the call to `script`, in ORDER, with bash line
    continuations joined and COMMENT lines skipped.

    The comment filter is not tidiness: this file explains `live_check.py`'s outputs in a bash
    comment above the call, and a naive `next(... if script in ln)` reads that comment and finds
    no arguments at all. Same trap as `_promote_emitted` -- check the bytes that run, not the
    bytes that are written down.
    """
    joined = run.replace("\\\n", " ")
    line = next(
        ln
        for ln in joined.splitlines()
        if script in ln and not ln.strip().startswith("#") and "python" in ln
    )
    return re.findall(r'--[A-Za-z-]+|"[^"]*"', line[line.index(script) + len(script) :])


def test_the_workflow_passes_live_check_its_arguments_in_order():
    """`assess` reads argv positionally, so a transposed pair is a silent wrong answer and a
    transposed status is a `ValueError` -- defect A returning by another door. Membership cannot
    see either; this asserts the ORDER, the way
    `test_the_tag_is_validated_before_the_poll_loop_is_ever_entered` asserts a position."""
    run = next(r for r in _run_scalars(LIVE_CHECK) if "/api/health" in r)
    assert _argv_after(run, "live_check.py") == [
        '"$health"',
        '"$hcode"',
        '"$releases"',
        '"$sitemap"',
        '"$cf"',
        '"$rl"',
        '"$pivot"',
    ]


def test_the_workflow_never_appends_to_a_status_curl_already_wrote():
    """curl emits its `-w` output even when the transfer fails, so `$(curl -w '%{http_code}' ...
    || echo 000)` CONCATENATES: measured `000000` on a refused connection and `200000` when
    --max-time expires mid-body, which `f"{status:03d}"` then prints verbatim as
    `HTTP 200000`. Assign in an `if !` block instead -- `promote.yml`'s imagetools retry is the
    in-file precedent."""
    run = next(r for r in _run_scalars(LIVE_CHECK) if "/api/health" in r)
    # Continuations JOINED first: the fallback sits on the second physical line, so
    # splitting raw made this check pass against the very bug it names.
    for line in run.replace("\\\n", " ").splitlines():
        if "%{http_code}" in line:
            assert "|| echo" not in line, f"a status curl still appends a fallback: {line.strip()}"


# --------------------------------------------------------------------------------------
# main(), which nothing imported at all
# --------------------------------------------------------------------------------------


def test_main_files_an_issue_for_a_body_it_could_not_read(monkeypatch, tmp_path):
    """End to end through the real call shape: the crash killed `main()` before any of this,
    so `file_issue` and `issue_body` never reached the workflow and no issue was ever filed."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "live_check.py",
            CHALLENGE,
            "403",
            json.dumps(RELEASES),
            SITEMAP,
            "HIT",
            "429",
            PIVOT_CURRENT,
        ],
    )
    assert main() == 0, "a site condition is reported through the ISSUE, not a red run"
    text = out.read_text()
    assert "failed=1" in text
    assert "file_issue=1" in text
    assert "Just a moment" in text


def test_main_refuses_a_wrong_call_shape_loudly(monkeypatch, tmp_path):
    """A mis-wired workflow printed usage and returned 0: a GREEN run, no `file_issue`, no
    issue, forever -- a silent watchdog, which is the failure class of this whole issue. A
    broken invocation is not a site condition, and `scheduled-failure.yml` is what reports it."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(sys, "argv", ["live_check.py", "{}", "200", "[]"])
    assert main() != 0
    assert not out.exists()


def test_main_cannot_emit_a_workflow_command_out_of_the_body(monkeypatch, tmp_path, capsys):
    """The same surface on this side: failures are printed as `- {f}`, so the prefix lands on
    the FIRST line only and anything after an embedded newline starts its own line on the
    runner's stdout, where Actions parses `::add-mask::` and `::stop-commands::` in a job
    holding issues:write."""
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "out"))
    hostile = "<html>\n::stop-commands::deadbeef\n::add-mask::hunter2\n</html>"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "live_check.py",
            hostile,
            "403",
            json.dumps(RELEASES),
            SITEMAP,
            "HIT",
            "429",
            PIVOT_CURRENT,
        ],
    )
    assert main() == 0
    for line in capsys.readouterr().out.splitlines():
        assert not line.startswith("::"), f"a workflow command reached line start: {line!r}"


def test_the_fetch_half_of_the_step_survives_an_unreachable_origin(tmp_path):
    """No text assertion can see this, so the scalar is executed.

    Under `set -euo pipefail` a bare `cf=$(curl ... | tr | awk)` whose curl cannot reach the
    origin makes the pipeline non-zero and ABORTS THE STEP -- live_check.py never runs, nothing
    is written to $GITHUB_OUTPUT, and no issue is filed, on precisely the condition this alert
    exists to report. Measured before the fix: exit 7, no output file. That is defect A reached
    through the shell instead of through Python, and `docs/architecture/deploy.md`'s "files its
    alert either way" was false while it held.

    Only the fetch half runs here: the release listing needs `gh` and the script call needs
    `mise`, neither of which this assertion is about.
    """
    for tool in ("bash", "curl"):
        if shutil.which(tool) is None:
            pytest.skip(f"{tool} is not installed")
    run = next(r for r in _run_scalars(LIVE_CHECK) if "/api/health" in r)
    fetches = run.split('releases=""')[0]
    # Hermetic: a proxy variable would send these fetches somewhere that can ANSWER, and
    # RUNNER_TEMP keeps the body file out of a fixed host path. 127.0.0.1:1 is refused rather
    # than blackholed, so this is fast -- but the verdict does not depend on that, only the
    # runtime does.
    env = {
        k: v
        for k, v in os.environ.items()
        if k.lower() not in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
    }
    result = subprocess.run(
        ["bash", "-c", fetches + '\necho "SURVIVED hcode=$hcode cf=$cf"'],
        env={**env, "BASE": "http://127.0.0.1:1", "RUNNER_TEMP": str(tmp_path)},
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, (
        f"the step aborted before live_check.py could run (exit {result.returncode}) -- "
        f"no verdict, no file_issue, no issue:\n{result.stderr[-400:]}"
    )
    assert "SURVIVED hcode=000 cf=absent" in result.stdout, result.stdout
    # Hermetic in the other direction too: the body file honours RUNNER_TEMP rather than
    # clobbering a fixed host path that a parallel job (or a developer) also owns.
    assert (tmp_path / "health.body").exists(), (
        "the step wrote its body file outside RUNNER_TEMP, to a fixed host path"
    )


def test_a_report_naming_no_warehouse_is_not_a_forgotten_promote():
    """A well-formed report whose `build` names no warehouse produced `the site is serving ``
    but `warehouse-2026.05` is published -- a promote was forgotten`, from a body no
    `NOT_A_REPORT` fixture supplies, because this one IS a health report.

    The mutant is deleting the `isinstance(live_warehouse, str) or not live_warehouse` branch,
    NOT restoring the `or ""` this used to name: `""` is a falsy str, so the branch catches it
    either way and that mutant survives. Name the branch that does the work."""
    for build in ({}, {"sha": "x"}, {"warehouse": None}, {"warehouse": ""}):
        body = json.dumps({"status": "ok", "build": build, "data": {}})
        v = assess(
            body,
            200,
            RELEASES,
            SITEMAP,
            cf_cache_status="HIT",
            ratelimit_status=429,
            pivot_body=PIVOT_CURRENT,
        )
        assert not any("promote was forgotten" in f for f in v.failures), build
        assert any("named no warehouse" in f for f in v.failures), build


def test_a_newline_in_a_parsed_value_cannot_open_a_workflow_command(monkeypatch, tmp_path, capsys):
    """`snippet`'s collapse guards the raw-body branch only. Every OTHER failure interpolates a
    value read out of a PARSED body -- `status`, `data.error`, `data.missing[]`,
    `build.warehouse`, the `cf-cache-status` header -- and a newline in any of them reaches the
    same unprefixed stdout, in a job holding `issues: write`."""
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "out"))
    hostile = "x\n::stop-commands::deadbeef"
    body = json.dumps(
        {
            "status": f"degraded{hostile}",
            "build": {"warehouse": f"w{hostile}", "sha": "s"},
            "data": {"asOf": None, "missing": [f"m{hostile}"], "error": f"e{hostile}"},
        }
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "live_check.py",
            body,
            "503",
            json.dumps(RELEASES),
            SITEMAP,
            f"HIT{hostile}",
            "429",
            PIVOT_CURRENT,
        ],
    )
    assert main() == 0
    for line in capsys.readouterr().out.splitlines():
        assert not line.startswith("::"), f"a workflow command reached line start: {line!r}"


def test_an_undecodable_byte_in_a_parsed_value_does_not_kill_the_output_write(
    monkeypatch, tmp_path
):
    """`open()` is strict under EVERY locale, so this is live on ubuntu-latest today: a
    surrogate anywhere in a rendered line kills the $GITHUB_OUTPUT write, and with it
    `file_issue` and the issue. Guarding only `snippet` left every value read out of a parsed
    body exposed."""
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "summary"))
    bad = b"\xff\xfe".decode("utf-8", "surrogateescape")
    body = json.dumps(
        {"status": "degraded", "build": {"warehouse": "w", "sha": "s"}, "data": {"error": bad}}
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["live_check.py", body, "503", json.dumps(RELEASES), SITEMAP, "HIT", "429", PIVOT_CURRENT],
    )
    assert main() == 0
    assert "file_issue=1" in out.read_text()


def test_a_fetch_that_hung_mid_body_carries_what_did_arrive():
    """Status 000 with a NON-EMPTY body: the origin began answering and then stalled, which is a
    different finding from a connection refused -- and the bytes that arrived are the only thing
    that separates them. Both other 000 fixtures pass an empty body, so neither can see this."""
    v = assess(
        '{"status":"ok"',
        0,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    named = next(f for f in v.failures if "/api/health" in f)
    assert "did not complete the transfer" in named
    assert '{"status":"ok"' in named, "the partial response was discarded"


def test_a_newline_in_the_sitemap_host_cannot_open_a_workflow_command(
    monkeypatch, tmp_path, capsys
):
    """`_LOC_HOST`'s `[^/]+` matches newlines in Python, and what it captures is REMOTE CONTENT
    from the origin that reaches `print(rendered)` unprefixed, in a job holding `issues: write`.
    The parsed-body fixtures cannot reach this: it is the sitemap argument, not the health one."""
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "out"))
    hostile = "<loc>https://evil\n::stop-commands::deadbeef/explore</loc>"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "live_check.py",
            json.dumps(HEALTHY),
            "200",
            json.dumps(RELEASES),
            hostile,
            "HIT",
            "429",
            PIVOT_CURRENT,
        ],
    )
    assert main() == 0
    for line in capsys.readouterr().out.splitlines():
        assert not line.startswith("::"), f"a workflow command reached line start: {line!r}"


def test_the_rate_limit_burst_is_bounded_overall_not_only_per_request():
    """80 requests x `--max-time` with no overall deadline is up to 800s against an origin that
    BLACKHOLES rather than refusing or challenging -- past this job's `timeout-minutes: 10`, so
    the step is killed and no issue is filed. That is the last case where this branch's own
    claim in deploy.md ("files its alert either way") would not have held."""
    run = _uncommented(next(r for r in _run_scalars(LIVE_CHECK) if "/api/health" in r))
    lines = run.splitlines()
    start = next(i for i, ln in enumerate(lines) if "seq 1 80" in ln)
    end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == "done")
    burst = "\n".join(lines[start:end])
    assert "burst_deadline" in burst, "the burst has no overall deadline, only a per-request one"
    assert "break" in burst
    assert any("burst_deadline=" in ln for ln in lines[:start]), "the deadline is never set"


# ---------------------------------------------------------------------------------------------
# THE PROBE ASKS ABOUT CURRENT DATA, BY CONSTRUCTION (#156)
# ---------------------------------------------------------------------------------------------
#
# The window was HAND-SPELLED as `t=2025-05:2026-04` in live-check.yml and again in
# deploy.md. Nothing reddened as it decayed: `bounds.ts` admits any in-window range and the
# dataset's floor never moves, so that window stays valid forever while receding one month
# further into the past with every BTS refresh. A liveness probe that asks "is production
# serving a fixed historical slice?" is a strictly weaker question than the one it was written
# to ask, and it degrades into it silently.
#
# The fix asserts the RELATIONSHIP instead: the month `/api/pivot` can retrieve IS the month
# `/api/health` reports as DATA AS OF. That property cannot rot, because both halves are read
# from the site on every run.


def _pivot(*months: str) -> str:
    """What `/api/pivot?d=year_month` answers, reduced to the one column this check reads."""
    return json.dumps(
        {
            "columns": ["year_month", "seats"],
            "rows": [{"year_month": m, "seats": 92684939} for m in months],
        }
    )


#: The served month agrees with the health report -- what a correct run looks like.
PIVOT_CURRENT = _pivot("2026-05")

#: EXACTLY WHAT THE FROZEN WINDOW PRODUCED. `t=2025-05:2026-04` against a 2026-05 warehouse
#: retrieves 2026-04 as its newest month while the site reports 2026-05. Measured against
#: production on 2026-09-01: health said `2026-05`, and the pinned window's newest row was
#: `2026-04`. This fixture is that observation.
PIVOT_STALE = _pivot("2026-04")


def test_a_probe_window_behind_the_served_month_is_caught():
    """THE #156 defect. The frozen window retrieved 2026-04 while DATA AS OF said 2026-05, and
    every gate stayed green because the window was still ADMISSIBLE.

    Asserts both months are named. "the probe is stale" without them sends an operator to
    read the dataset by hand for the two facts this check already holds."""
    v = _assess(
        HEALTHY,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_STALE,
    )
    assert len(v.failures) == 1
    assert "2026-05" in v.failures[0] and "2026-04" in v.failures[0]


def test_a_current_probe_window_reports_no_failure():
    """DISCRIMINATION, not decoration: without this, an implementation that fails
    unconditionally passes the test above and this check reddens on every healthy run."""
    v = _assess(
        HEALTHY,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=PIVOT_CURRENT,
    )
    assert v.failures == []


def test_an_unreadable_pivot_body_is_reported_as_unmeasured_never_as_stale():
    """A challenge page is not evidence about the data layer. Reporting it as a stale window
    would assert a cause nobody observed -- the rule `read_health` already follows for the
    health body, applied to this fetch."""
    v = _assess(
        HEALTHY,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=CHALLENGE,
    )
    assert len(v.failures) == 1
    assert "never measured" in v.failures[0]
    # The months must NOT appear: naming them would read as a currency verdict.
    assert "2026-05" not in v.failures[0]


def test_json_that_is_not_a_pivot_result_is_unmeasured_too():
    """`read_newest_month` has TWO refusal branches and a fixture only reaches one of them: a
    challenge page is not JSON at all, so it exits at the decode. This body PARSES and is still
    not a pivot result -- Cloudflare's own JSON error shape, the same one `is_health_report`
    exists to refuse on the health side. Without this the `isinstance(rows, list)` guard is
    deletable green: a mutant that returns a month from it kills no test."""
    v = _assess(
        HEALTHY,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body='{"success": false, "errors": [{"code": 1015}]}',
    )
    assert len(v.failures) == 1
    assert "never measured" in v.failures[0]
    assert "2026-05" not in v.failures[0]


def test_an_empty_pivot_result_is_its_own_finding():
    """A 200 carrying zero rows is not the same finding as a body that could not be read: the
    query reached the data layer and the data layer had nothing for the month the site claims."""
    v = _assess(
        HEALTHY,
        RELEASES,
        SITEMAP,
        cf_cache_status="HIT",
        ratelimit_status=429,
        pivot_body=_pivot(),
    )
    assert len(v.failures) == 1
    assert "no rows" in v.failures[0] and "2026-05" in v.failures[0]


def test_the_currency_check_is_suppressed_when_health_is_unreadable():
    """No asOf was observed, so there is no month to compare against. Carrying on would file a
    second failure asserting a cause, in the same alert that just said it could not read the
    site -- the suppression rule the module docstring states for the two health-derived
    checks, which this is now a third instance of."""
    v = assess(
        CHALLENGE,
        403,
        RELEASES,
        SITEMAP,
        "HIT",
        429,
        pivot_body=PIVOT_STALE,
    )
    assert len(v.failures) == 1
    assert "/api/health" in v.failures[0]


def test_the_workflow_hand_spells_no_month_window():
    """The issue's own warning: re-pinning to the current month is this defect with a fresher
    constant. A literal `t=YYYY-MM:YYYY-MM` anywhere in the workflow's bash is that re-pin."""
    spelled = [
        run
        for run in _run_scalars(LIVE_CHECK)
        if re.search(r"t=\d{4}-\d{2}:\d{4}-\d{2}", _uncommented(run))
    ]
    assert spelled == []


def test_the_runbook_hand_spells_no_month_window():
    """`deploy.md` documented the same frozen query as the hand-run form. A documented form
    that disagrees with the workflow is how the next reader re-introduces the pin, so the doc
    is bound to the same rule rather than merely corrected once."""
    runbook = Path(__file__).parents[2] / "docs" / "architecture" / "deploy.md"
    assert re.search(r"t=\d{4}-\d{2}:\d{4}-\d{2}", runbook.read_text()) is None
