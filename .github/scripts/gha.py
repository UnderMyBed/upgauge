"""GitHub Actions plumbing shared by the scripts in this directory.

One implementation, because the delimiter rule below is a security property and two copies of a
security property is one copy plus a place for it to be wrong.
"""

from __future__ import annotations

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
