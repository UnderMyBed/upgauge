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

ROOT = Path(__file__).parents[2]
CLOUDFLARE = ROOT / "deploy" / "cloudflare"


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


# The rule's expression is a disjunction of path predicates, optionally NARROWED by conjuncts
# that read an edge-evaluated signal (§ the provenance gate below), so it can be EVALUATED
# rather than string-matched. That distinction is the point: `assert '"/api/"' in expression`
# passes for an expression that also matches every other path on the site, and passes for one
# whose operator is wrong. Extracting (operator, literal) pairs and running real paths through
# them is what makes each assertion below fail for the reason it names.
_PATH_CLAUSE = re.compile(r'(starts_with|ends_with)\(http\.request\.uri\.path,\s*"([^"]+)"\)')

# Cloudflare's Rules language spells every logical operator TWICE -- `and`/`&&`, `or`/`||`,
# `not`/`!` are C-like notations for the SAME operators, with identical precedence
# (developers.cloudflare.com/ruleset-engine/rules-language/operators/). Every structural check
# in this file matches both notations, because a gate that reasons about one spelling has moved
# the hole rather than closed it.
_AND = (r"\band\b", r"&&")
_OR = (r"\bor\b", r"\|\|")

# Identifiers are read off the LITERAL-MASKED expression, never the raw string: otherwise the
# path literal `"/api/"` reads as an identifier and a field name written inside a literal reads
# as a field the expression uses.
#
# EXTRACTION IS CASE-INSENSITIVE AND STRUCTURE MATCHING IS NOT, and the asymmetry is the design:
# be permissive where you REFUSE, strict where you ADMIT. Cloudflare's fields are lower-case, but
# an `[a-z]`-anchored extractor matches no part of `HTTP.USER_AGENT` and reports the expression
# CLEAN -- the same bypass as `&& !(http.user_agent contains "bot")`, reached by varying case
# instead of notation. Case is a spelling, and gets the same treatment as `&&` versus `and`.
# Anything strict (`_PATH_CLAUSE`, `_NEGATED_SIGNAL`) stays case-SENSITIVE, so a case-varied
# clause is refused rather than admitted -- fail closed on both sides.
#
# Cloudflare has BARE fields too, and exactly one of them is client-choosable: `ssl`, "returns
# true when the HTTP connection to the client is encrypted". The client picks its own scheme, so
# `and not ssl` limits plain HTTP alone and every `https://` client walks straight through. A
# dotted-identifier extractor cannot see it, so bare identifiers are extracted as well and
# admitted only when they are an operator word, a boolean literal, or an allow-listed function.
_DOTTED_FIELD = re.compile(r"\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+", re.IGNORECASE)
_BARE_IDENT = re.compile(r"\b[a-z][a-z0-9_]*\b", re.IGNORECASE)
_OPERATOR_WORDS = frozenset(
    {"and", "or", "not", "xor", "in", "eq", "ne", "lt", "le", "gt", "ge", "contains", "matches"}
)
_BOOLEAN_LITERALS = frozenset({"true", "false"})


def _mask_literals(expression: str) -> str:
    """Blank the CONTENTS of every string literal, preserving LENGTH so offsets still index the
    original. Length preservation is what lets the structural splits below run on the masked
    copy and slice the real one -- and it is what stops a path literal such as `"/brand/"` from
    contributing an `and` to the conjunct split."""
    out: list[str] = []
    i, n = 0, len(expression)
    while i < n:
        if expression[i] == '"':
            close = i + 1
            while close < n and expression[close] != '"':
                # `\"` is one unit. Scanning for a bare `"` ends the literal early, which fails
                # closed (the masked span is a PREFIX of the real one, so it can over-reject but
                # never hide a field) -- consuming the escape is still what makes it correct.
                close += 2 if expression[close] == "\\" else 1
            if close >= n:
                # Unterminated. Emit exactly `n - i` characters: appending a synthetic closing
                # quote would return 41 characters for 40, and `_split_top_level` slices the
                # ORIGINAL by offsets taken from this copy.
                out.append('"' + "\0" * (n - i - 1))
                i = n
            else:
                out.append('"' + "\0" * (close - i - 1) + '"')
                i = close + 1
        else:
            out.append(expression[i])
            i += 1
    return "".join(out)


def _split_top_level(expression: str, operators: tuple[str, ...]) -> list[str]:
    """Split on occurrences of `operators` at paren depth 0, in EITHER notation."""
    masked = _mask_literals(expression)
    pattern = re.compile("|".join(operators), re.IGNORECASE)
    parts: list[str] = []
    depth = last = i = 0
    while i < len(masked):
        char = masked[i]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif depth == 0:
            match = pattern.match(masked, i)
            if match:
                parts.append(expression[last : match.start()])
                last = i = match.end()
                continue
        i += 1
    parts.append(expression[last:])
    return [part.strip() for part in parts]


def _unwrap(term: str) -> str:
    """Strip ONE balanced outer paren pair, and only when it wraps the whole term."""
    term = term.strip()
    if not (term.startswith("(") and term.endswith(")")):
        return term
    depth = 0
    for k, char in enumerate(_mask_literals(term)):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return term[1:-1].strip() if k == len(term) - 1 else term
    return term


def _path_disjunction(expression: str) -> str:
    """The leading conjunct -- the part of the rule that decides WHICH PATHS are matched.

    `_covered` models the expression as a pure disjunction of path clauses. A narrowing conjunct
    silently falsifies that model, so the evaluator is handed this slice rather than the whole
    expression, and `test_rate_limit_expression_narrows_only_outside_its_path_disjunction`
    proves no later conjunct reads the path. Those two together are what keep the coverage and
    exclusion tests sound now that a narrowing is expressible at all."""
    return _unwrap(_split_top_level(expression, _AND)[0])


def _covered(expression: str, path: str) -> bool:
    clauses = _PATH_CLAUSE.findall(_path_disjunction(expression))
    assert clauses, f"no http.request.uri.path predicate in {expression!r}"
    return any(
        path.startswith(literal) if op == "starts_with" else path.endswith(literal)
        for op, literal in clauses
    )


# Every surface the rule must match, with the cost that puts it there. Three shapes, matched for
# three different reasons: `/api/pivot`, `/explore` and the four cards reach the origin on EVERY
# request; `/route/ZZZZ-QQQ` is an unbounded 404 family that no cache absorbs (#117); the rest are
# cacheable 200s matched as collateral, because `http.request.uri.path` carries no query string,
# so neither the refused-value family (#113) nor the 404 family (#117) can be addressed apart from
# its cached siblings.
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
    # #117, and BOTH entries are load-bearing. A literal `starts_with(path, "/route/JFK-LAX")`
    # satisfies every assertion the KNOWN pair makes while bounding ZERO of the 404 family the
    # prefix was added for. The unknown pair is what distinguishes a prefix from a fixture;
    # delete it and that mutant lives.
    #
    # FIXTURES FOR A PREFIX MUST DIFFER IN THE SUFFIX TOO. Two /route/ fixtures sharing a suffix
    # are both matched by `ends_with(<shared suffix>)` substituted for the prefix, and nothing in
    # UNCOVERED ends that way either -- so that substitution passes every test in this file while
    # bounding none of the space. An outcome the buggy expression also produces is not evidence.
    #
    # /route/ has no single-literal narrowing escape left; the other five prefixes do (#129).
    (
        "/route/ZZZZ-QQQ",
        "an unknown pair is a no-store 404 that runs the reverse lookup THREE times (proxy, "
        "page, then not-found.tsx's reason -- proxy.ts:750) with no CDN absorption, over an "
        "unbounded URL space",
    ),
    (
        "/route/JFK-LAX",
        "the cacheable 200 beside it: a path predicate cannot separate the two, and a real "
        "page view spends exactly ONE slot here (measured from the served bytes)",
    ),
)

# Deliberately outside the rule. Each of these is either cheap, cached at the edge for long
# enough that a walk does not reach the origin, or would break something legitimate if limited.
UNCOVERED = (
    ("/", "static, and the entry point every real visitor lands on"),
    ("/watch/gauge", "four closed slugs, so the whole surface is four cacheable documents"),
    # The reason is the CACHE alone. Nearly every URL this document enumerates is itself inside
    # the rule since #117, so "crawlers fetch it" exempts nothing -- it is one cached document,
    # and a walk of it reaches the origin once per TTL however many URLs it lists.
    ("/sitemap.xml", "one document behind PROJECT_CACHE for 30 days: a walk hits the origin once"),
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

    #117 added `/route/`, and for a DIFFERENT reason: it is the one entity path with
    `keys: NO_KEYS` (`lib/canonicalQuery.ts`), so it has no refused-value family at all. Its
    residual is a 404 space instead -- an unknown pair is a `no-store` 404 running the site's
    largest query THREE times (proxy, page, then not-found.tsx's reason -- proxy.ts:750),
    uncached, over an unbounded URL space.

    It is CHEAPER per miss than the family #113 closed and BROADER in surface, which are two
    claims and not one: a refused `?type=` renders a whole page at 82-104 ms while a /route/ miss
    is three runs of the 8 ms lookup plus three dimension-only probes. What earns it a place here
    is the SHAPE of the space, not the cost -- `/carrier/:code` is unbounded in the VALUE under
    one path, `/route/` has no value gate at all and every miss is a DISTINCT PATH, so its family
    is unbounded and uncacheable per-URL. Do not compress this to "strictly worse"; on the only
    axis either sentence names, it is not.

    `can reach`, not `reaches`: all four prefixes' resolving values are cacheable 200s and a
    real visitor's page view is one of them. They are matched anyway because Cloudflare's
    `http.request.uri.path` excludes the query string, so neither residual can be addressed
    without its cached siblings. That collateral is affordable only because an entity page view
    is exactly ONE request against this bucket -- `DataTable` emits a plain `<a href>`
    (components/DataTable.tsx:78,93), `TopBar` pins `prefetch={false}`, and every asset the page
    pulls is under the excluded `/_next/`. MEASURED 2026-08-27 against the served route page:
    every serialized `<Link>` ref carries `"prefetch":false` (5 refs, 5 props, 1:1 -- 2 rendered
    by `TopBar` on a 200, the other 3 inside the not-found boundary subtree), and the 13
    subresources a browser fetches are all under the excluded `/_next/`. 13 counts DISTINCT URLs
    across the body AND the `Link:` response header -- the counting rule matters, because the 4
    `.woff2` sit in both (header `rel=preload`, body RSC flight payload as `:HL[...,"font",...]`
    hint records) and counting `src=`/`href=` attributes instead both misses them and
    double-counts a chunk. One slot per view. A `<Link>` with prefetch on an entity page would
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

    This is the load-bearing half. The rule matches all FOUR entity prefixes whole, so `/_next/`
    is the only thing standing between it and every static asset on the site, and this list is
    the only thing asserting that. Entries leave this list as the rule widens, which is normal;
    it must never shrink to nothing, and `/_next/static/chunks/main.js` must never leave it."""
    expression = _load("rate-limit.json")["rules"][0]["expression"]
    for path, why in UNCOVERED:
        assert not _covered(expression, path), f"{path} must not be rate limited: {why}"


def test_the_og_cards_stay_covered_by_their_own_clause_when_the_entity_prefixes_are_struck_out():
    """`ends_with(path, "/opengraph-image")` is a BACKSTOP since #117, and this is the only thing
    keeping it honest.

    Every card route in the app lives under one of the four entity prefixes -- there are exactly
    four `opengraph-image.tsx` files and they sit at `app/src/app/{route,airport,carrier,aircraft}
    /[...]/`. Since #117 all four of those prefixes are in the expression, so the clause now
    matches nothing they do not already match, and **deleting it leaves every other test in this
    file green**. That is the whole reason this test exists.

    The clause is kept rather than deleted because it is redundant only WHILE all four prefixes
    stay covered. It costs one clause, it survives a future narrowing of any one of them, and the
    cards are the most expensive request on the site: a DuckDB query plus a rasterize with no warm
    path at the origin. A working defense removed because it is currently redundant is the
    "simplified by someone who doesn't know why it exists" failure, and a redundant clause with no
    test naming it is one the next widening retires by accident.

    Asserting that the cards are covered would NOT catch this -- the entity prefixes cover them
    too, so that assertion passes either way. Striking the prefixes out and re-asking is what
    makes the clause's own coverage the property under test."""
    expression = _load("rate-limit.json")["rules"][0]["expression"]
    cards_only = " or ".join(
        f'ends_with(http.request.uri.path, "{literal}")'
        for op, literal in _PATH_CLAUSE.findall(expression)
        if op == "ends_with"
    )
    assert cards_only, (
        "no `ends_with` clause is left in the expression -- the four `*/opengraph-image` paths "
        "are now covered only incidentally, by whichever entity prefixes happen to remain"
    )
    # The premise, asserted against the DISK rather than against this file's own COVERED tuple.
    # Counting COVERED entries would let a FIFTH card route be added -- `/watch/[preset]/` is the
    # plausible one -- with no test noticing: the clause would silently become load-bearing again,
    # the "BACKSTOP, not load-bearing" paragraph in hosting.md would become false, and every
    # assertion here would stay green. Same shape as `canonicalQuery.test.ts` agreeing with
    # `config.matcher` rather than restating it.
    card_dirs = sorted(
        f.relative_to(ROOT / "app" / "src" / "app").parts[0]
        for f in (ROOT / "app" / "src" / "app").rglob("opengraph-image.tsx")
    )
    assert card_dirs == ["aircraft", "airport", "carrier", "route"], (
        f"the card routes on disk are {card_dirs}, not the four entity prefixes this clause is "
        "redundant with -- a card outside those prefixes makes `ends_with` load-bearing again"
    )
    cards = [(path, why) for path, why in COVERED if path.endswith("/opengraph-image")]
    assert len(cards) == 4, "all four card paths must be listed in COVERED"
    for path, why in cards:
        assert _covered(cards_only, path), (
            f"{path} is covered only by an entity prefix, not by the card clause: {why}"
        )


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


# WHOSE SIGNAL IS IT? A narrowing may read only something the EDGE decides -- never something
# the client sends. That is a property about PROVENANCE, and it is not the same check as banning
# an operator.
#
# `cf.` is a NAMESPACE, not a provenance guarantee, and Cloudflare's own field reference settles
# it inside a single subtree: `cf.tls_client_auth.cert_presented` "Returns `true` when an mTLS
# client presents a certificate (valid or not)", while its neighbour
# `cf.tls_client_auth.cert_verified` requires a VALID one. Two adjacent fields, one validated and
# one not -- a prefix rule cannot tell them apart, a named allow-list can. The same subtree holds
# `cf.tls_client_random`, "the 32-byte random value provided by the client". So a field is
# admissible because someone established the edge decides it and wrote the reason down beside the
# name, never because it matched a pattern.
PATH_SUBJECT = "http.request.uri.path"

EDGE_EVALUATED = {
    "cf.client.bot": (
        "Cloudflare resolves it against the verified-bot list IT maintains, keyed on network "
        "identity: reverse DNS validation that the source IP matches the requesting service, "
        "published IP and ASN blocks, or a Web Bot Auth signature. A User-Agent is part of the "
        "match pattern but never sufficient on its own, and generic UA patterns are rejected "
        "outright -- so `curl -A Googlebot` cannot make this true. Corroborated by the plan: "
        "Cloudflare restricts a FREE zone's rate-limiting expression to exactly `Path` and "
        "`Verified Bot`, which is this entry plus PATH_SUBJECT and nothing else."
    ),
}

# Only the two the expression actually uses. Deny-by-default here too: `any(...)` is the shape
# the RSC-header bypass was drafted in, and a function nobody has justified does not get to
# appear just because its argument happens to pass the field check.
ALLOWED_FUNCTIONS = frozenset({"starts_with", "ends_with"})

# A narrowing, in full: `not <field>` or `!<field>`, optionally parenthesised, nothing else. The
# paren is one ALTERNATIVE rather than two independent optionals -- `\(?...\)?` admits
# `not cf.client.bot)`, half a narrowing that the API would reject and this file claims to
# refuse. Case-SENSITIVE and anchored by `fullmatch`, so `NOT cf.client.bot`, `not not x`, a
# trailing `or ...` and a call like `not any(...)` are refused rather than half-understood.
_NEGATED_SIGNAL = re.compile(r"(?:not\s+|!\s*)(?:\(\s*([a-z][a-z0-9_.]*)\s*\)|([a-z][a-z0-9_.]*))")


def _provenance_failures(expression: str) -> list[str]:
    """Every identifier the expression names must be the path subject or an allow-listed edge
    signal. Whole-expression, notation-agnostic and case-agnostic, so a client-controlled field
    is caught wherever it appears and however it is spelled -- narrowing the rule or widening it.

    The guarantee is what an ASCII identifier parser can SEE, which is narrower than "every
    field" and is stated that way on purpose. It holds for a non-ASCII homoglyph
    (`cf.\u0441lient.bot`, Cyrillic) only because the ASCII fragments left either side of the
    substituted character are themselves unclassified identifiers -- `cf` and `bot` -- and the
    bare-identifier pass below refuses those. It is not a general Unicode guarantee."""
    masked = _mask_literals(expression)
    admissible = {PATH_SUBJECT, *EDGE_EVALUATED}
    failures = [
        f"field {field!r} is not on the edge-evaluated allow-list"
        for field in sorted({f.lower() for f in _DOTTED_FIELD.findall(masked)})
        if field not in admissible
    ]
    # Whatever survives blanking the dotted names is a bare identifier -- a field like `ssl`, or
    # a function name. One space, one rule: admissible only as an operator word, a boolean
    # literal, or an allow-listed function. Folding functions in here rather than checking them
    # separately is what keeps ALLOWED_FUNCTIONS killable -- drop `starts_with` from it and the
    # shipped expression is refused immediately.
    residue = _DOTTED_FIELD.sub(lambda m: "\0" * len(m.group()), masked)
    failures += [
        f"bare identifier {name!r} is not on the edge-evaluated allow-list"
        for name in sorted({n.lower() for n in _BARE_IDENT.findall(residue)})
        if name not in _OPERATOR_WORDS | _BOOLEAN_LITERALS | ALLOWED_FUNCTIONS
    ]
    return failures


def _structure_failures(expression: str) -> list[str]:
    """The rule must be `<path disjunction> [and not <edge signal>]*`, in either notation.

    POLARITY IS THE OTHER HALF OF PROVENANCE, and reading only the field name misses it: the
    intended narrowing is `and not cf.client.bot`, and dropping the `not` inverts it into
    `and cf.client.bot`, which rate-limits VERIFIED BOTS ONLY and leaves every curl, every
    unverified scraper and every ordinary visitor outside the rule. That is a total bypass
    needing no client action at all, it is the one-character sign flip of the exact edit #126
    asks for, and on this free plan `Path` and `Verified Bot` are the only two fields the API
    accepts -- so it sits inside the accepted vocabulary and would apply cleanly.

    Requiring each later conjunct to be exactly `not <allow-listed signal>` settles the shapes a
    field check alone admits, but the two halves of this function do not divide the work the way
    it looks. `and cf.client.bot or cf.client.bot` parses as `((A) and X) or X` -- true for a
    verified bot on ANY path, `/_next/` included, since `and` binds tighter than `or` -- and it
    dies on the fullmatch here, as does `&& !starts_with(http.request.uri.path, "/route/")`,
    which deletes the unbounded 404 family #117 added that prefix for. A BARE top-level `or`
    carries no `and` to split on, so it never reaches this loop at all: it dies in the
    disjunction half above, on `_PATH_CLAUSE.fullmatch`. Same for `xor` and `^^`, which are a
    fourth operator pair binding between `and` and `or` and which `_split_top_level` splits on
    neither. Do not restate this as "polarity subsumes the `or` shapes"; on the bare form it
    does not, and the fixtures name which half each row exercises.

    And the allow-list membership check on the extracted signal is the ONLY thing refusing
    `and not true` -- which is `and false`, so the rule matches nothing on every path and the
    edge limit is silently OFF. That is worse than the sign flip above, `true` is Cloudflare's
    own catch-all, and provenance is clean for it because a boolean literal is not a field.

    (`(A or (B))` is refused though it means `(A or B)`. Over-rejection, and it fails closed.)"""
    conjuncts = _split_top_level(expression, _AND)
    failures = [
        f"{term!r} in the leading disjunction is not a bare path predicate"
        for term in _split_top_level(_unwrap(conjuncts[0]), _OR)
        if not _PATH_CLAUSE.fullmatch(term)
    ]
    for conjunct in conjuncts[1:]:
        negated = _NEGATED_SIGNAL.fullmatch(conjunct)
        signal = negated and (negated.group(1) or negated.group(2))
        if negated is None:
            failures.append(
                f"narrowing {conjunct!r} is not `not <signal>` -- a narrowing may only REMOVE "
                "traffic on a signal the edge decides, and this one does not have that shape"
            )
        elif signal not in EDGE_EVALUATED:
            failures.append(
                f"narrowing reads {signal!r}, which is not on the edge-evaluated allow-list"
            )
    return failures


# Narrowings the gate must ADMIT. Both notations, and a parenthesised form, because the whole
# point of #126 is that this edit stays available.
ADMITTED_NARROWINGS = (
    "and not cf.client.bot",
    "&& !cf.client.bot",
    "and not (cf.client.bot)",
    # The `*` in `[and not <signal>]*`, which nothing else reaches: every other row appends
    # exactly ONE conjunct to an expression carrying none, so "check only the first narrowing"
    # is indistinguishable from "check them all" until a second one exists.
    "and not cf.client.bot and not cf.client.bot",
)

# A disjunction spelled with `||`. `&&` is exercised by the rows above; without this the C-like
# spelling of the OTHER operator is admitted by a code path no fixture ever runs.
ADMITTED_DISJUNCTIONS = (
    (
        '(starts_with(http.request.uri.path, "/api/")'
        ' || starts_with(http.request.uri.path, "/explore"))',
        ("/api/pivot", "/explore"),
    ),
)

# Narrowings the gate must REFUSE, each naming the bug it is. A gate that refuses EVERYTHING
# passes this table and fails ADMITTED_NARROWINGS; a gate that admits everything does the
# reverse. Neither table proves anything without the other.
# Narrowings refused for WHAT THEY READ. `_provenance_failures` must fire on each -- asserted
# specifically rather than "something refused it", because the shape rule below happens to catch
# every one of these too, and a table that accepts either answer lets the entire allow-list be
# deleted with the suite green.
REFUSED_FOR_WHAT_THEY_READ = (
    ('and not (http.user_agent contains "bot")', "`curl -A` chooses the User-Agent"),
    ('&& !(http.user_agent contains "bot")', "the notation the operator ban never saw"),
    ('&& !(HTTP.USER_AGENT contains "bot")', "case is a spelling: the same bypass, upper case"),
    ("and not Http.User_Agent", "and mixed case, which an [a-z] extractor reads as nothing"),
    ("and not ssl", "a BARE client-choosable field: every https:// client walks through"),
    ("and ssl", "the same field inverted, limiting encrypted traffic alone"),
    ('&& !any(http.request.headers["rsc"][*] == "1")', "`curl -H 'RSC: 1'` is the bypass"),
    ("and not lower(http.request.uri.path)", "a function nobody allow-listed"),
    ("and not cf.tls_client_random", "`cf.` is a namespace: the client supplies these bytes"),
    (
        "and not cf.tls_client_auth.cert_presented",
        "true for a certificate VALID OR NOT, one field from `cert_verified` -- the pair a "
        "`cf.` prefix rule cannot tell apart and a named allow-list can",
    ),
    ("and not cf.client.bot_score", "a near-miss on the allow-listed name is not a match"),
    ("and not cf.\u0441lient.bot", "a Cyrillic homoglyph, caught by its ASCII fragments"),
    ("and not ip.src in {1.2.3.0/24}", "`ip.src` may be adjusted by X-Forwarded-For"),
)

# Narrowings refused for their SHAPE. Every one is provenance-CLEAN -- it names only allow-listed
# identifiers -- which is asserted here too, because that is precisely what makes the shape rule
# load-bearing on its own rather than a second opinion about the field names.
REFUSED_FOR_THEIR_SHAPE = (
    ("and cf.client.bot", "the sign flip: rate-limits verified bots ONLY, exempting everyone"),
    ("&& cf.client.bot", "the same inversion in the C-like notation"),
    ("and cf.client.bot or cf.client.bot", "`and` binds tighter: true for a bot on ANY path"),
    ("and not cf.client.bot or cf.client.bot", "the same shape wearing the safe narrowing"),
    (
        '&& !starts_with(http.request.uri.path, "/route/")',
        "deletes the unbounded 404 family #117 added that prefix for, invisibly to `_covered`",
    ),
    # The allow-list membership check on the EXTRACTED SIGNAL is the only thing refusing these,
    # and provenance is clean for all three -- a boolean literal is not a field, and the path
    # subject is an admissible field that is not an edge SIGNAL. Without a row here that branch
    # is deletable with the whole suite green, which is the same asymmetry the split tables were
    # built to fix, sitting on the other side of it.
    ("and not true", "`not true` is `false`: the rule matches NOTHING, on every path"),
    ("and not http.request.uri.path", "admissible as a field, but it is not an edge signal"),
    ("and not starts_with", "an allow-listed FUNCTION name is not a signal either"),
    # Case. `_NEGATED_SIGNAL` is deliberately case-sensitive, and nothing asserted it.
    ("and NOT cf.client.bot", "the strict matchers admit one spelling: upper case is refused"),
    # `xor`/`^^` are a fourth operator pair, binding between `and` and `or`, that
    # `_split_top_level` splits on neither -- so these die in the DISJUNCTION half, not here.
    ("xor cf.client.bot", "`xor` is not a narrowing, and is not split into one"),
    ("^^ cf.client.bot", "and the same in its C-like spelling"),
    ("and not cf.client.bot)", "half a narrowing: the API rejects it and so does this"),
    (
        "and not cf.client.bot and cf.client.bot",
        "a SECOND conjunct, unnegated -- checking only the first narrowing misses it",
    ),
)

# A whole expression, not a narrowing: refused by the DISJUNCTION half of the shape rule while
# naming no unclassified identifier at all, which is what keeps that half separately necessary.
REFUSED_DISJUNCTIONS = (
    (
        '(starts_with(http.request.uri.path, "/api/") or true)',
        "a bare `true` disjunct matches every path while naming no field",
    ),
    (
        '(STARTS_WITH(http.request.uri.path, "/api/"))',
        "`_PATH_CLAUSE` is case-sensitive on purpose: a clause is ADMITTED, so it fails closed",
    ),
)


def test_rate_limit_expression_reads_only_fields_whose_value_the_edge_decides():
    """The property the rule needs, stated as the thing it protects rather than as an operator.

    A narrowing may read only a signal Cloudflare's edge decides. `cf.client.bot` is one, and a
    client cannot assert it (see EDGE_EVALUATED). `http.user_agent`,
    `http.request.headers[...]`, `http.request.uri.query` and the bare `ssl` are whatever the
    client sent or chose, so narrowing on one is a BYPASS, not an exemption -- and that is not
    hypothetical: `and not any(http.request.headers["rsc"][*] == "1")`, drafted into this rule
    to spare React's own prefetches, reads as a correctness fix and is `curl -H 'RSC: 1'` away
    from opting any client out of the limit. `docs/architecture/hosting.md` records the same
    reasoning for the `_rsc` query param.

    BANNING THE OPERATOR IS A DIFFERENT CHECK, and a weaker one in BOTH directions. Cloudflare
    spells every logical operator twice, so a ban on the substrings `" and "` and `" not "`
    never saw the C-like form at all. MEASURED against the predecessor of this test, on the
    shipped expression: `... && !(http.user_agent contains "bot")` -- a total bypass -- passed
    every test in this file, while the SAFE `... and not cf.client.bot` was refused. It
    under-blocked and over-blocked at once, and the door it was holding shut was already open.

    Deny-by-default is what makes this survive the next field someone wants: an identifier
    nobody has classified fails here until it is added to EDGE_EVALUATED with its reason. A
    `cf.` prefix rule would not have -- see the `cert_presented`/`cert_verified` pair above."""
    failures = _provenance_failures(_load("rate-limit.json")["rules"][0]["expression"])
    assert failures == [], "; ".join(failures)


def test_rate_limit_expression_is_a_path_disjunction_narrowed_only_by_negated_edge_signals():
    """Admitting a narrowing at all puts `_covered` at risk, and this is what holds it up.

    That helper models the expression as a pure disjunction of path clauses, so a conjunct that
    reads the path silently falsifies the model rather than the test. Requiring the shape
    `<path disjunction> [and not <edge signal>]*` -- and requiring the NEGATION, which is the
    other half of provenance (see `_structure_failures`) -- is what keeps it honest.

    Two guarantees follow, and they are why the two tables above are still true statements.
    UNCOVERED is sound UNCONDITIONALLY: every later conjunct is `and not <signal>`, so the whole
    expression is `A and X1 and X2 ...`, a subset of `A`. Nothing outside the disjunction can be
    pulled in -- which is exactly what a stray top-level `or` would do, and why one is refused.
    COVERED reads "covered for every client that does not satisfy the narrowing", and because a
    narrowing may read only an edge-evaluated field, that is a set no client can put itself in."""
    failures = _structure_failures(_load("rate-limit.json")["rules"][0]["expression"])
    assert failures == [], "; ".join(failures)


def test_a_path_literal_is_never_read_as_a_field_or_as_an_operator():
    """The checks above extract identifiers and split conjuncts. Both run on a copy with every
    string literal blanked, or the rule's own DATA gets parsed as its STRUCTURE.

    Nothing in the shipped expression can show this: none of its seven path literals contains a
    dot or an operator word, so masking is invisible on today's bytes and deleting it leaves
    every other test in this file green -- run as a mutant, it survived. These fixtures are the
    ones that kill it. `/sitemap.xml` and `/robots.txt` are the two paths this rule is likeliest
    to gain next and unmasked they read as the FIELDS `sitemap.xml` and `robots.txt`, which no
    allow-list contains; a literal carrying `and` or `&&` splits the expression mid-clause and
    silently discards everything after the split."""
    for literal in ("/sitemap.xml", "/robots.txt", "/brand-and-heritage", "/a&&b", "/SSL"):
        expression = f'(starts_with(http.request.uri.path, "{literal}"))'
        assert _provenance_failures(expression) == [], (
            f"the path literal {literal!r} was read as a field the expression uses"
        )
        assert _structure_failures(expression) == [], (
            f"the path literal {literal!r} was read as a logical operator"
        )
        assert _covered(expression, literal), (
            f"the path literal {literal!r} did not survive the conjunct split intact"
        )
    # `\"` is ONE unit, asserted on the mask itself. Scanning for a bare `"` ends the literal
    # early, so the tail of the real literal is left looking like STRUCTURE -- here the stray `y`
    # would become a bare identifier. It fails closed (the masked span can only ever be a PREFIX
    # of the true literal, so it over-rejects and never hides a field), which is exactly why no
    # expression fixture can show it and this has to be asserted at the helper.
    assert _mask_literals('a == "x\\"y" and b') == 'a == "\0\0\0\0" and b'
    # The length invariant the offset-slicing depends on, asserted directly. An unterminated
    # literal and an escaped quote are the two inputs that broke it.
    for raw in (
        'starts_with(http.request.uri.path, "/a',
        'x == "a\\"b" and not cf.client.bot',
        '(starts_with(http.request.uri.path, "/api/"))',
    ):
        assert len(_mask_literals(raw)) == len(raw), f"mask changed length on {raw!r}"


def test_the_gate_tells_edge_evaluated_from_client_asserted_in_both_notations():
    """Both directions, because only the pair proves the gate REASONS rather than reacts.

    A gate that refuses everything passes REFUSED_NARROWINGS; a gate that permits everything
    passes ADMITTED_NARROWINGS; the predecessor -- a substring ban on the word forms -- passed
    one of each, for the wrong reason both times. Asserting only that the SHIPPED expression is
    admissible catches none of it, because the shipped expression carries no narrowing at all:
    the negative direction has to be constructed to be tested.

    The admitted forms are also checked to leave the path disjunction BYTE-IDENTICAL, which is
    the non-vacuous form of "the narrowing did not perturb which paths are matched". Running
    COVERED/UNCOVERED through `_covered` here would not be: `_covered` reads the disjunction,
    and for every narrowing this test can construct the disjunction is unchanged by
    construction, so those loops could never disagree with the un-narrowed run."""
    shipped = _load("rate-limit.json")["rules"][0]["expression"]
    baseline = _path_disjunction(shipped)

    for narrowing in ADMITTED_NARROWINGS:
        candidate = f"{shipped} {narrowing}"
        assert _provenance_failures(candidate) == [], (
            f"{narrowing!r} reads an edge-evaluated signal and must stay admissible; refusing "
            "it leaves the only safe narrowing unavailable, which is the whole of #126"
        )
        assert _structure_failures(candidate) == [], f"{narrowing!r} must satisfy the shape"
        assert _path_disjunction(candidate) == baseline, (
            f"{narrowing!r} perturbed which paths the rule matches"
        )

    for narrowing, why in REFUSED_FOR_WHAT_THEY_READ:
        assert _provenance_failures(f"{shipped} {narrowing}") != [], (
            f"the allow-list admitted {narrowing!r}, and it is a bypass: {why}"
        )

    for narrowing, why in REFUSED_FOR_THEIR_SHAPE:
        candidate = f"{shipped} {narrowing}"
        assert _provenance_failures(candidate) == [], (
            f"{narrowing!r} must be provenance-CLEAN for this row to test the shape rule; it "
            "names only allow-listed identifiers, and the bug in it is the shape"
        )
        assert _structure_failures(candidate) != [], (
            f"the shape rule admitted {narrowing!r}, and it is a bypass: {why}"
        )

    for expression, why in REFUSED_DISJUNCTIONS:
        assert _provenance_failures(expression) == [], "this row exists to test the shape rule"
        assert _structure_failures(expression) != [], (
            f"the shape rule admitted {expression!r}, and it is a bypass: {why}"
        )

    for expression, paths in ADMITTED_DISJUNCTIONS:
        assert _provenance_failures(expression) == [], f"{expression!r} must stay admissible"
        assert _structure_failures(expression) == [], f"{expression!r} must satisfy the shape"
        for path in paths:
            assert _covered(expression, path), f"{path} lost coverage under {expression!r}"

    # Case-insensitivity, asserted at the EXTRACTORS. The dotted and bare passes cover each
    # other for every realistic input -- an upper-case dotted field the dotted pass misses is
    # caught by its bare fragments, and vice versa -- so neither is individually reachable
    # through a whole expression. That mutual redundancy is real defense, but it means the
    # contract gets asserted here or it gets asserted nowhere.
    assert _DOTTED_FIELD.findall("HTTP.USER_AGENT") == ["HTTP.USER_AGENT"]
    assert "SSL" in _BARE_IDENT.findall("and not SSL")


def test_the_evaluator_reads_the_path_disjunction_not_the_whole_expression():
    """`_covered` is scoped to the disjunction, and nothing else in this file can show it.

    Every admissible expression has a narrowing free of path predicates, so scoping the
    evaluator and not scoping it agree on all of them -- reverting `_covered` to scan the whole
    expression leaves the entire file green. This asserts the helper's own contract on an
    expression the gate REFUSES, which is the only place the two can disagree: a `/_next/`
    literal smuggled into a narrowing must not grant `/_next/` coverage, or the exclusion table
    -- the one thing standing between this rule and every static asset on the site -- would be
    read off a clause that removes traffic rather than one that matches it."""
    shipped = _load("rate-limit.json")["rules"][0]["expression"]
    smuggled = f'{shipped} and not starts_with(http.request.uri.path, "/_next/")'
    assert not _covered(smuggled, "/_next/static/chunks/main.js"), (
        "a path literal inside a NARROWING granted coverage: `_covered` is reading the whole "
        "expression instead of its path disjunction"
    )
    assert _structure_failures(smuggled) != [], "and the shape rule must refuse it outright"


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
