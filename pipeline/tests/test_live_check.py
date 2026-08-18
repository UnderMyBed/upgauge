"""The served site is the only place several of these claims are checkable at all. Each test
names the bug its assertion exists to catch -- and each was confirmed by breaking the
implementation, never by reading it."""

from __future__ import annotations

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


def test_a_healthy_site_reports_no_failures():
    v = assess(HEALTHY, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert v.failures == []


def test_a_forgotten_promote_is_caught():
    """THE bug this file exists for. The release-based freshness alert reads publishedAt and
    stays green while the SITE serves last month's warehouse -- nothing upstream of the box
    can see a box that never got the new image."""
    stale = {**HEALTHY, "build": {"sha": "9a9511d", "warehouse": "warehouse-2026.04"}}
    v = assess(stale, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert any("warehouse-2026.04" in f and "warehouse-2026.05" in f for f in v.failures)


def test_localhost_in_the_sitemap_is_caught():
    """UPGAUGE_BASE_URL unset: every page renders, the sitemap validates, and every <loc>
    and canonical points at localhost. Nothing else in the system notices."""
    v = assess(
        HEALTHY,
        RELEASES,
        "<loc>http://localhost:3000/explore</loc>",
        cf_cache_status="HIT",
        ratelimit_status=429,
    )
    assert any("localhost" in f for f in v.failures)


def test_an_uncached_edge_is_caught():
    """Fact 5: Cloudflare does not cache text/html by default, so HTML_CACHE reaches an edge
    that ignores it and the whole cost model is fiction. A MISS on a second fetch is the
    symptom."""
    v = assess(HEALTHY, RELEASES, SITEMAP, cf_cache_status="MISS", ratelimit_status=429)
    assert any("cf-cache-status" in f for f in v.failures)


def test_an_absent_rate_limit_is_caught():
    v = assess(HEALTHY, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=200)
    assert any("rate limit" in f.lower() for f in v.failures)


def test_a_degraded_health_report_is_caught_with_its_named_cause():
    """/api/health never throws; it reports a named cause. Losing the cause turns a 503 into
    'something is wrong', which is what the endpoint exists to avoid."""
    degraded = {
        **HEALTHY,
        "status": "degraded",
        "data": {"asOf": None, "missing": ["mart_route_health"], "error": "boom"},
    }
    v = assess(degraded, RELEASES, SITEMAP, cf_cache_status="HIT", ratelimit_status=429)
    assert any("mart_route_health" in f for f in v.failures)


def test_every_failure_reaches_the_issue_body():
    """A verdict that fails silently in the body is an alert an operator cannot act on."""
    stale = {**HEALTHY, "build": {"sha": "x", "warehouse": "warehouse-2026.04"}}
    v = assess(
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
