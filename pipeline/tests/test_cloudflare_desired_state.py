"""`deploy/cloudflare/*.json` is the desired state `make cloudflare-apply` PUTs verbatim to the
Cloudflare API (`deploy/cloudflare-apply.sh`) -- these files ARE the config, not documentation
of it, so a syntax error or a silently-changed number here ships straight to production the next
time someone runs the target.

`rate-limit.json` is where issue #19's third acceptance criterion is satisfied: "the thresholds
are the record, not a sentence about them" (2026-08-18 deploy runbook, Task 5 brief). The bug
this guards against is the number moving without anyone noticing -- someone "simplifying" the
rate limit to a round number, or a copy-paste from a different project's threshold, would still
be syntactically valid JSON and would still get applied cleanly. Only an assertion pinned to the
actual value catches that.
"""

from __future__ import annotations

import json
from pathlib import Path

CLOUDFLARE = Path(__file__).parents[2] / "deploy" / "cloudflare"


def _load(name: str) -> dict:
    return json.loads((CLOUDFLARE / name).read_text())


def test_all_three_desired_state_files_are_valid_json():
    """`--data @file` sends the file's bytes as-is (deploy/cloudflare-apply.sh). Invalid JSON
    here is a `curl` 4xx that only surfaces when Task 6 runs it against the real API, not
    something any earlier gate would catch."""
    for name in ("cache-rules.json", "rate-limit.json", "tunnel-config.json"):
        _load(name)  # raises json.JSONDecodeError on malformed content


def test_rate_limit_threshold_is_60_requests_per_60_seconds_per_ip():
    """THE number: 60 requests/minute/IP on /api/, pinned here rather than left to the
    surrounding prose. A human on /explore triggers a handful of /api/pivot calls a minute; a
    scraper walking 22,420 route pages does not fit inside it (CLAUDE.md, rate-limit design
    facts). If this drifts to some other value with the JSON still well-formed, only this
    assertion -- not the JSON parse above -- catches it."""
    rule = _load("rate-limit.json")["rules"][0]
    assert rule["action"] == "block"
    ratelimit = rule["ratelimit"]
    assert ratelimit["period"] == 60
    assert ratelimit["requests_per_period"] == 60
    assert "ip.src" in ratelimit["characteristics"]


def test_rate_limit_targets_api_paths_only():
    """A rule that matches everything (or nothing) still parses and still applies -- this
    catches the expression drifting off `/api/` and silently rate-limiting the whole site, or
    silently rate-limiting nothing."""
    rule = _load("rate-limit.json")["rules"][0]
    assert '"/api/"' in rule["expression"]
    assert "starts_with" in rule["expression"]


def test_cache_rule_makes_html_cacheable_and_respects_origin_ttl():
    """Fact 5: Cloudflare's default cache keys off static file extensions, so HTML is not
    cached without this rule -- and if it doesn't respect_origin, it silently overrides the
    app's own HTML_CACHE / no-store distinctions (CLAUDE.md's per-route Cache-Control rules)
    with one flat edge TTL instead of deferring to them."""
    rule = _load("cache-rules.json")["rules"][0]
    assert rule["action"] == "set_cache_settings"
    params = rule["action_parameters"]
    assert params["cache"] is True
    assert params["edge_ttl"]["mode"] == "respect_origin"
    assert params["browser_ttl"]["mode"] == "respect_origin"


def test_tunnel_ingress_ends_with_a_catch_all():
    """cloudflared requires the LAST ingress rule to have no hostname (a catch-all); anything
    else is silently unreachable traffic or a tunnel that refuses to start. A catch-all in the
    middle of the list would shadow every rule after it -- position matters, not just
    presence."""
    ingress = _load("tunnel-config.json")["config"]["ingress"]
    assert ingress[-1] == {"service": "http_status:404"}
    assert all("hostname" in rule for rule in ingress[:-1])


def test_tunnel_ingress_routes_the_production_host_to_the_app_service():
    """A wrong hostname or service here means the tunnel starts fine and every request 404s
    at Cloudflare's edge -- nothing on the box would ever see it."""
    ingress = _load("tunnel-config.json")["config"]["ingress"]
    assert {"hostname": "upgauge.shipman.dev", "service": "http://app:3000"} in ingress
