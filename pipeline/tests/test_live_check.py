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
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from live_check import assess  # noqa: E402

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


def _assess(health: dict, *args, health_status: int = 200, **kwargs):
    """The healthy-fetch spelling: a real report, serialized, answered with a real status."""
    return assess(json.dumps(health), health_status, *args, **kwargs)


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
        degraded, RELEASES, SITEMAP, health_status=503, cf_cache_status="HIT", ratelimit_status=429
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
        degraded, RELEASES, SITEMAP, health_status=503, cf_cache_status="HIT", ratelimit_status=429
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
    v = assess(CHALLENGE, 403, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
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
    v = assess(CHALLENGE, 403, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert len(v.failures) == 1, f"expected only the unreadable finding, got {v.failures}"
    assert not any("promote was forgotten" in f for f in v.failures)


def test_a_curl_failure_reports_that_the_fetch_never_completed():
    """`curl` failing outright (dropped connection, DNS, the box unreachable) is status 000 and
    an empty body -- a fetch that never completed, which is a different finding from a server
    that answered with nothing. Asserting only "does not say `None`" is not enough: collapsing
    this into the empty-body branch below still satisfies that, so the distinguishing fact --
    that no HTTP status came back at all -- is what gets asserted."""
    v = assess("", 0, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert v.failed
    named = next(f for f in v.failures if "/api/health" in f)
    assert "could not be fetched at all" in named
    assert "no HTTP status" in named


def test_an_empty_body_under_a_real_status_is_reported_not_defaulted():
    """The `or "{}"` fallback's own failure mode, and the one the status-000 test above cannot
    reach: a server that DID answer, with nothing. Defaulting to `{}` makes `status` `None` and
    the alert then reads ``/api/health reports `None` `` -- a sentence about a report that was
    never served, in place of the fact that the body was empty."""
    v = assess("", 200, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert v.failed
    named = next(f for f in v.failures if "/api/health" in f)
    assert "reports `None`" not in named
    assert "empty body" in named
    assert "200" in named


def test_a_json_body_that_is_not_an_object_is_reported_not_raised():
    """A JSON array or bare scalar parses fine and then blows up on `.get`. Same class as the
    decode error and the same remedy: report what came back, do not raise."""
    v = assess("[]", 200, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert v.failed
    assert any("/api/health" in f for f in v.failures)


def test_the_health_snippet_is_carried_verbatim_and_marks_its_truncation():
    """Two bugs, both of which make the evidence lie. Stripping characters out of the body to
    make it render alters the one artifact the operator is being shown; truncating it without
    saying so makes a body that ends mid-tag indistinguishable from one that really ended
    there. The backtick matters because it is what a fixed pair of backticks would break on."""
    body = "<html>x=`1` " + ("y" * 400)
    v = assess(body, 502, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
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
        json.dumps(HEALTHY), 200, RELEASES, CHALLENGE, cf_cache_status="HIT", ratelimit_status=429
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
    run = next(r for r in _run_scalars(LIVE_CHECK) if "/api/health" in r)
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
