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
import re
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


def test_rate_limit_holds_one_request_per_second_per_ip_in_a_period_the_plan_allows():
    """THE number, and the constraint it has to fit inside. MEASURED 2026-08-19: this zone's
    plan rejects any other window --

        not entitled to use the period 60, can only use a period among [10]

    -- so the 60-requests-per-60s the design asked for is not expressible here. The RATE is
    what carries the intent (a human on /explore makes a handful of /api/pivot calls a minute;
    a scraper walking 22,509 route pages does not fit inside 1/s), so it is preserved at
    1 req/s and the window is the one the plan permits. Asserting the ratio rather than a bare
    threshold is what keeps this honest if the window ever changes again.

    Note the tightened burst tolerance: 10-in-10s trips on a burst that 60-in-60s would have
    absorbed. That is a real behaviour change, accepted because the plan allows nothing else."""
    rule = _load("rate-limit.json")["rules"][0]
    assert rule["action"] == "block"
    ratelimit = rule["ratelimit"]
    assert ratelimit["period"] == 10, "the plan permits no other period; measured from the API"
    assert ratelimit["requests_per_period"] / ratelimit["period"] == 1.0, (
        "the sustained rate must stay at 1 request/second/IP"
    )
    assert "ip.src" in ratelimit["characteristics"]
    # Same plan constraint, second measurement: "not entitled to use a mitigation timeout
    # different from 10". The design asked to block for 60s; the plan blocks for 10, so a
    # throttled scraper resumes six times sooner. The rule caps sustained throughput; it is
    # not a wall, and nothing downstream should describe it as one.
    assert ratelimit["mitigation_timeout"] == 10


# The rule's expression is a disjunction of path predicates, so it can be EVALUATED rather than
# string-matched. That distinction is the point: `assert '"/api/"' in expression` passes for an
# expression that also matches every other path on the site, and passes for one whose operator
# is wrong. Extracting (operator, literal) pairs and running real paths through them is what
# makes each assertion below fail for the reason it names.
_PATH_CLAUSE = re.compile(r'(starts_with|ends_with)\(http\.request\.uri\.path,\s*"([^"]+)"\)')


def _covered(expression: str, path: str) -> bool:
    clauses = _PATH_CLAUSE.findall(expression)
    assert clauses, f"no http.request.uri.path predicate in {expression!r}"
    return any(
        path.startswith(literal) if op == "starts_with" else path.endswith(literal)
        for op, literal in clauses
    )


# Every surface the rule must match, with the cost that puts it there. The first six reach the
# origin on EVERY request. The last three do not -- a filter value that resolves is a cacheable
# 200 -- and are matched anyway because `http.request.uri.path` carries no query string, so the
# refused-value family underneath them cannot be addressed on its own (#113).
COVERED = (
    ("/api/pivot", "a DuckDB aggregation, and the residual `f` axis rides the 30-day cache"),
    ("/explore", "the same `f` axis on the HTML page, which no key or value bound closes"),
    ("/route/JFK-LAX/opengraph-image", "a DuckDB query plus a rasterize, with no warm path"),
    ("/airport/SEA/opengraph-image", "same"),
    ("/carrier/DL/opengraph-image", "same"),
    ("/aircraft/B737-8/opengraph-image", "same"),
    ("/carrier/DL", "a refused `?type=` is no-store and renders in full: 82-104 ms, unbounded"),
    ("/aircraft/B737-8", "`?carrier=` has the identical shape (#106)"),
    ("/airport/SEA", "`?y=<junk>` has had it since M7 Task 9, at a smaller radius"),
)

# Deliberately outside the rule. Each of these is either cheap, cached at the edge for long
# enough that a walk does not reach the origin, or would break something legitimate if limited.
UNCOVERED = (
    ("/", "static, and the entry point every real visitor lands on"),
    # NOT "it is cached, so a walk does not reach us" -- that is equally true of `/carrier/DL`,
    # which IS covered above. What actually distinguishes `/route/:pair` is that it is the one
    # entity path with `keys: NO_KEYS` (app/src/lib/canonicalQuery.ts), so it has no
    # refused-value family. Its own residual -- an unbounded 404 space, each miss running the
    # site's largest query twice with no CDN absorption -- is uncovered and tracked as #117.
    ("/route/JFK-LAX", "no query key at all, so no refused-value family reaches the origin"),
    ("/watch/gauge", "four closed slugs, so the whole surface is four cacheable documents"),
    ("/sitemap.xml", "PROJECT_CACHE for 30 days, and crawlers are supposed to fetch it"),
    ("/robots.txt", "same, and limiting it teaches a crawler nothing"),
    ("/_next/static/chunks/main.js", "immutable assets: a real page load asks for a dozen"),
)


def test_rate_limit_covers_every_surface_that_can_reach_the_origin_uncached():
    """Issues #83 and #113. Before #83 the expression was `/api/` alone -- so `/explore` had no
    edge rate limit at all, though it carries the identical residual `f` axis that
    `lib/canonicalQuery.ts` and `lib/pivot/bounds.ts` deliberately leave open BECAUSE an edge
    limit was said to cover it. The four card paths were uncovered too, and they are the most
    expensive thing on the site per request: a DuckDB query plus a rasterize, no warm path.

    #113 added the three entity prefixes that carry a filter key. `?y=`, `?type=` and
    `?carrier=` are canonical KEYS, so a value the server refuses is not stripped -- the page
    renders in full under `no-store` at 82-104 ms, against 0.9-1.6 ms for the 307 strip, and
    the value space is unbounded because failing the value rule does not make the key unknown.

    `can reach`, not `reaches`: those three prefixes' resolving values are cacheable 200s and a
    real visitor's page view is one of them. They are matched anyway because Cloudflare's
    `http.request.uri.path` excludes the query string, so the refused-value family cannot be
    addressed without its cached siblings. That collateral is affordable only because an entity
    page view is exactly ONE request against this bucket -- `DataTable` emits a plain `<a href>`
    (components/DataTable.tsx:78,93), `TopBar` pins `prefetch={false}`, and every asset the page
    pulls is under the excluded `/_next/`. A `<Link>` with prefetch on an entity page would
    break that arithmetic, which is why this note names the mechanism rather than the number.

    Asserting coverage path by path is what distinguishes this from the check it replaces --
    that one asserted the string `"/api/"` appeared, which an expression matching only `/api/`
    satisfies just as well as one matching everything."""
    expression = _load("rate-limit.json")["rules"][0]["expression"]
    for path, why in COVERED:
        assert _covered(expression, path), f"{path} is not rate limited, and it costs: {why}"


def test_rate_limit_does_not_reach_the_cached_pages_or_the_static_assets():
    """The other half, and the one a careless widening breaks: `starts_with(path, "/")` covers
    every path in COVERED and would pass the test above while rate-limiting the entire site at
    1 req/s -- a single real page load asks for more static chunks than that.

    #113 made this the load-bearing half. The rule now matches three whole entity prefixes, so
    `/_next/` is what stands between it and every static asset on the site, and this list is the
    only thing asserting that. It shrank by one entry (`/carrier/DL` moved to COVERED); it must
    never shrink to nothing, and `/_next/static/chunks/main.js` must never leave it."""
    expression = _load("rate-limit.json")["rules"][0]["expression"]
    for path, why in UNCOVERED:
        assert not _covered(expression, path), f"{path} must not be rate limited: {why}"


def test_rate_limit_keeps_the_name_the_zone_actually_holds():
    """MEASURED 2026-08-24, applying #83: a PUT to the http_ratelimit phase entrypoint updates
    the ruleset's `description` and its rules, and SILENTLY IGNORES `name`. The rule's expression
    went from `/api/` alone to the three-path disjunction and the description changed with it --
    `version` bumped 1 -> 2 -- while `name` stayed exactly as it was. The API returned
    `success: true` and reported no error about the field it dropped.

    So `name` is not desired state on this endpoint, however much the rest of this file is: it is
    fixed at creation. Renaming it here to match the widened scope would have left the repo
    asserting something about the zone that no `make cloudflare-apply` could ever make true --
    the exact "committed file IS the config" claim these tests exist to keep honest. It stays at
    the creation-time name, which no longer describes the scope, and that is why this test says
    so rather than leaving the next person to rename it and believe it applied."""
    assert _load("rate-limit.json")["name"] == "upgauge-api-rate-limit"


def test_rate_limit_expression_has_no_client_controlled_escape_hatch():
    """Guards the evaluator above AND a real bug that was drafted into this rule and caught
    before it shipped: excluding React's own prefetches with

        and not any(http.request.headers["rsc"][*] == "1")

    reads as a correctness fix and is a total bypass -- `curl -H 'RSC: 1'` opts any client out
    of the limit. `docs/architecture/hosting.md` already records the same reasoning for the
    `_rsc` query param: it is attacker-choosable. Nothing about a request that a client picks
    may narrow this rule, so the expression stays a pure disjunction of path predicates.

    (It needs no such exclusion: every link to `/explore` in the app is a raw `<a href>`, and
    `TopBar` sets `prefetch={false}` on the two `<Link>`s a data page renders.)"""
    expression = _load("rate-limit.json")["rules"][0]["expression"]
    for operator in (" and ", " not ", "http.request.headers"):
        assert operator not in expression, (
            f"{operator!r} narrows the rule; if it reads a client-supplied header or query "
            "param, the narrowing is a bypass, not an exemption"
        )


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


def test_cloudflare_apply_verifies_the_dns_record_points_at_the_tunnel():
    """MEASURED 2026-08-19: `make cloudflare-apply` reported "desired state applied" while
    `dig upgauge.shipman.dev` returned nothing. The script PUT cache rules, the rate limit and
    the tunnel ingress -- and never looked at DNS, though D8's justification claims "DNS is an
    upsert by name". The tunnel was configured and nothing pointed at it.

    The record is created once by hand (the token carries DNS *read* only, so it can never
    rewrite another record in this zone), which makes verifying it the script's job. All three
    properties matter and each fails differently: a missing record does not resolve, a record
    aimed somewhere other than <tunnel>.cfargotunnel.com resolves to the wrong origin, and an
    unproxied record bypasses the cache rule and the rate limit entirely while still serving
    the site -- the silent one."""
    # Executable lines only. A needle that also matches the script's own explanatory comments
    # certifies prose, which is how two other checks in this repo passed while broken.
    code = "\n".join(
        ln
        for ln in (CLOUDFLARE.parent / "cloudflare-apply.sh").read_text().splitlines()
        if not ln.lstrip().startswith("#")
    )
    assert "dns_records" in code, "cloudflare-apply.sh never queries DNS"
    # The target is BUILT from the tunnel id, never matched loosely: a bare-domain check would
    # accept a record pointing at someone else's <other-id>.cfargotunnel.com.
    assert "${CLOUDFLARE_TUNNEL_ID}.cfargotunnel.com" in code, (
        "it does not construct the expected target from the tunnel id"
    )
    assert "proxied" in code, (
        "it does not check the record is PROXIED -- an unproxied record still serves the site "
        "but silently bypasses the cache rule and the rate limit"
    )
