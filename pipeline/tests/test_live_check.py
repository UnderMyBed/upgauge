"""The served site is the only place several of these claims are checkable at all. Each test
names the bug its assertion exists to catch -- and each was confirmed by breaking the
implementation, never by reading it."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / ".github" / "scripts"))

from live_check import assess  # noqa: E402

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
