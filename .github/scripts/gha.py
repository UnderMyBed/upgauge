"""GitHub Actions plumbing shared by the scripts in this directory.

One implementation each, because the delimiter rule below is a security property, the fencing
rule under it is a correctness property, and two copies of either is one copy plus a place for it
to be wrong.
"""

from __future__ import annotations

import re
import secrets
from typing import TextIO


def write_multiline_output(fh: TextIO, name: str, value: str) -> None:
    """Append a `name<<DELIM ... DELIM` block to an open $GITHUB_OUTPUT handle.

    The delimiter is randomized, per GitHub's own guidance for output values built from
    unpredictable upstream text: a static delimiter (e.g. a fixed `EOF`) that happens to
    appear verbatim on its own line inside `value` would truncate the value silently instead
    of failing loudly. The cost of generating one is a function call, and the alternative is a
    delimiter collision nobody would notice until an issue body went missing its tail.
    """
    value = printable(value)
    delim = secrets.token_hex(16)
    while delim in value:
        value = printable(value)
    delim = secrets.token_hex(16)
    fh.write(f"{name}<<{delim}\n{value}\n{delim}\n")


#: How many CHARACTERS of an unreadable body reach the operator -- characters, not bytes: the
#: value is sliced after decoding, so a multi-byte character counts once. Enough to tell a
#: Cloudflare interstitial from a 502 from a truncated JSON body without going and fetching it by
#: hand, which is the whole point of carrying it at all.
SNIPPET_CHARS = 200


def printable(text: str) -> str:
    """Undecodable bytes as U+FFFD, rather than as an exception on the way out.

    `sys.argv` decodes with `surrogateescape`, so a body that is not valid UTF-8 -- a binary
    error page, a response truncated mid-character -- arrives carrying lone surrogates. Encoding
    those to a stream whose error handler is `strict` raises UnicodeEncodeError, which on this
    path means the alert CRASHES INSTEAD OF REPORTING: the exact failure its callers exist to
    end, reachable by anything that can serve the runner a non-UTF-8 body.

    APPLY THIS AT EVERY BOUNDARY, not only to bodies. `open()` defaults to `errors="strict"`
    under EVERY locale, so the locale only ever affected stdout -- measured:

        LANG=C.UTF-8 (ubuntu-latest)   stdout ok        file write RAISES
        LANG=en_US.UTF-8               stdout RAISES    file write RAISES

    So a `$GITHUB_OUTPUT` or step-summary write raises on the runner today, and any value read
    out of a PARSED body (a status, a warehouse name, an error message) carries the same risk as
    a raw one. A crash there means the alert dies before filing anything -- and in
    `promote_check` it exits 1, the code for "read nothing", silently downgrading an earned
    rollback to the blind path. A no-op for valid text.
    """
    return text.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def inline(value: object) -> str:
    """An untrusted VALUE rendered for a one-line message: printable, whitespace collapsed.

    `snippet` guards raw bodies, but every message these alerts build also interpolates values
    read OUT of a parsed body -- a `status`, a `data.error`, a `build.warehouse`, a
    `cf-cache-status` header, a dispatch-supplied tag. Those are just as attacker-shaped as the
    body they came from, and a newline in one of them lands in the same two places a raw body
    would: an unprefixed line on the runner's stdout, where Actions parses `::add-mask::` and
    `::stop-commands::` in jobs holding `issues: write` and `packages: write`.

    So the collapse belongs where the message is BUILT, not only on the snippet.

    This does NOT re-encode undecodable bytes: `printable` owns that, once, at the emission
    boundary. Doing it in both places left every boundary guard unreachable -- three mutants
    deleting them survived the whole suite, because the value had already been sanitised on its
    way in. One rule, one place, one test each.
    """
    return " ".join(str(value).split())


def is_health_report(parsed: dict) -> bool:
    """Whether this object is a `HealthReport` (`app/src/lib/health.ts:7-14`) rather than merely
    some JSON that parsed.

    `status`, `build` and `data` are all non-optional there, and `identity()` computes `build`
    before every return branch, so an object missing any of them did not come from this app --
    a Cloudflare JSON error body (`{"success":false,"errors":[...]}`), an intermediary's own
    JSON, or `{}`.

    SHARED, because both watchdogs answer the same question and `docs/architecture/deploy.md`
    states the rule for both. It lived in `live_check` alone for one commit, and in that commit
    any JSON carrying a `build` dict -- `{"build":{}}` included -- earned `promote.yml`'s
    unconditional ROLL BACK NOW, or, if the keys happened to line up, declared the promote a
    success outright.
    """
    return (
        isinstance(parsed.get("status"), str)
        and isinstance(parsed.get("build"), dict)
        and isinstance(parsed.get("data"), dict)
    )


def snippet(body: str, limit: int = SNIPPET_CHARS) -> str:
    """The first `limit` characters of `body`, whitespace-collapsed, truncation MARKED.

    Collapsed because the value is rendered as one markdown list item and one `::error::`
    annotation, neither of which survives an embedded newline -- and because a newline inside
    edge-controlled evidence would put attacker-chosen bytes at the START of a line on the
    runner's stdout, where Actions parses `::add-mask::` and `::stop-commands::`, in jobs
    holding `packages: write`. The collapse is what makes that unreachable, so it is a security
    property, not formatting. Marked because a snippet that
    silently ends mid-tag is indistinguishable from a body that really ended there -- the
    operator is being shown evidence, and evidence that quietly omits its own truncation is
    worse than no evidence.

    Nothing else is altered: the bytes between here and `limit` are verbatim, which is why
    `code_span` below has to cope with whatever they contain rather than sanitising them.
    """
    collapsed = inline(body)
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[:limit] + " [truncated]"


def code_span(text: str) -> str:
    """`text` as a markdown code span that renders whatever `text` actually contains.

    GitHub renders raw HTML in an issue body and a step summary, so an unfenced
    `<!DOCTYPE html><html>...` -- the exact body these alerts exist to surface -- is swallowed
    by the renderer and the operator sees an empty bullet. A fixed pair of backticks is not
    enough either: the fence has to be LONGER than the longest backtick run inside the value,
    or a body carrying a backtick closes the span early. Same failure shape as `gha.py`'s
    delimiter rule one layer up, so it lives beside it.

    The one-space padding is CommonMark's own escape for content that begins or ends with a
    backtick; the renderer strips it back off.
    """
    if not text:
        return "(empty)"
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{fence}{pad}{text}{pad}{fence}"
