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
    delim = secrets.token_hex(16)
    while delim in value:
        delim = secrets.token_hex(16)
    fh.write(f"{name}<<{delim}\n{value}\n{delim}\n")


#: How much of an unreadable body reaches the operator. Enough to tell a Cloudflare interstitial
#: from a 502 from a truncated JSON body without going and fetching it by hand, which is the
#: whole point of carrying it at all.
SNIPPET_BYTES = 200


def snippet(body: str, limit: int = SNIPPET_BYTES) -> str:
    """The first `limit` characters of `body`, whitespace-collapsed, truncation MARKED.

    Collapsed because the value is rendered as one markdown list item and one `::error::`
    annotation, neither of which survives an embedded newline. Marked because a snippet that
    silently ends mid-tag is indistinguishable from a body that really ended there -- the
    operator is being shown evidence, and evidence that quietly omits its own truncation is
    worse than no evidence.

    Nothing else is altered: the bytes between here and `limit` are verbatim, which is why
    `code_span` below has to cope with whatever they contain rather than sanitising them.
    """
    collapsed = " ".join(body.split())
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
