"""The permalink codec: `PivotQuery` <-> query string. CI-ONLY reference implementation.

pipeline/ never runs in prod -- the server does this in TypeScript. This module IS the
spec M3b's port is verified against, same relationship as pivot.py's `render_pivot` to the
templates it renders.

**The encoding is a frozen public contract from the first shipped link.** Keys are short and
readable, not a base64 JSON blob: this audience hand-edits permalinks and pastes them into
forums, where an opaque blob is both unreadable and un-editable. `v=1` exists so a future
incompatible change can migrate a link instead of silently misreading it.

**Decode is TOTAL.** An unknown query-string key, a duplicate non-`f` key, an unrecognised or
missing `v`, or anything that fails `render_pivot`'s own allowlist/structural validation
(unknown dimension/measure/sort key, unknown grain/grouping, empty dimension or measure
list, a non-positive limit, a filter with no values) is a rejection via `UrlStateError` --
never a silent drop to a default. A permalink that quietly renders a *different* query than
the one it encodes still screenshots as authoritative, which is worse than one that errors.
A duplicate key (`d=a&d=b`) is rejected on the same principle: `encode` never produces one,
so a decoded link containing one is malformed, not a link whose second value should quietly
win.

**Known, accepted gap: two `f` tokens naming the same dimension.** `f` is repeatable by
design (a query filters on several different dimensions at once), so the duplicate-key check
above deliberately exempts it -- but nothing stops two `f` tokens from naming the SAME
dimension, e.g. `f=op_airline_id:19790&f=op_airline_id:19805`. `render_pivot` ANDs every
filter clause together, so that decodes to `op_airline_id IN (19790) AND op_airline_id IN
(19805)` -- always zero rows, since one row's `op_airline_id` cannot be both values at once.
`encode` can produce this: two `PivotQuery.filters` tuples keyed on the same dimension is a
valid field value it does not deduplicate or merge. Not guarded here on purpose, same
reasoning as the reversed-time-range gap below -- a silently-empty result is a surprising but
plausible reading of a self-contradictory filter, not a corruption of the query it claims to
encode.

**Division of validation labour** (per the project rule against a second, drifting
validator): identifier and structural validation -- is this dimension/measure/sort key on
the allowlist, is the grain/grouping recognised, is the limit a positive int, does every
filter have values -- is reused *as-is* from `pipeline.pivot.render_pivot`, which this module
calls purely to validate a candidate `PivotQuery` (its rendered SQL/params are discarded).
That is the ONE place those rules live.

What `render_pivot` cannot check, because it is URL syntax rather than a `PivotQuery` field,
is validated HERE instead:
  - the `v` key itself (present, and equal to `URL_VERSION`);
  - unknown query-string keys (anything not in `_ALLOWED_KEYS`) and duplicate non-`f` keys;
  - the shape of `t` (`YYYY-MM:YYYY-MM`) and `f` (`key:val1,val2,...`) tokens;
  - parsing `n` as an integer at all (a non-numeric limit is a codec-level parse failure,
    not a value `render_pivot` would ever see as anything but the wrong Python type).

**Escaping: who owns which layer, and why `parse_qsl` is never used.** Every key except `f`
carries plain, allowlisted-identifier text (dimension/measure/sort keys, the grain/grouping
tokens, the limit) -- text this module itself produced or a hand-editor typed from the same
vocabulary -- so it needs no escaping. A filter VALUE is the one piece of user/attacker-
controlled free text in the whole contract, and it can legally contain the very characters
this format uses as delimiters: `,` (between values), `:` (between a filter's key and its
values), and `&`/`=` (between query-string pairs). `encode` therefore percent-encodes each
filter key and value individually with `urllib.parse.quote(..., safe="")` before joining them
with the structural `,`/`:`. Decoding must split on the structural delimiters FIRST and
`unquote` each token only AFTER -- never the reverse. This is why `decode` does its own
`&`/`=` splitting (`_split_pairs`) instead of `urllib.parse.parse_qsl`: `parse_qsl` unquotes
each value as part of splitting it out, which would decode a percent-encoded structural comma
(`%2C`) back into a literal comma before `_parse_filter`'s own `.split(",")` ever saw it --
silently reintroducing the exact corruption the percent-encoding exists to prevent.

**Known accepted gap.** A reversed time range (`t=2015-12:2015-01`) decodes without error and
simply yields zero rows once queried, matching `render_pivot`'s own boundary -- it doesn't
validate ordering either. Not guarded here on purpose: `encode` never produces one, but a
hand-edited link can, and the empty result is a plausible (if surprising) reading of a
backwards range, not a corruption of the query it claims to encode.
"""

from __future__ import annotations

import re
from urllib.parse import quote, unquote

from pipeline.pivot import GRAINS, GROUPINGS, PivotError, PivotQuery, render_pivot

URL_VERSION = 1

#: `t`'s shape is `YYYY-MM`, per the module docstring's "what render_pivot cannot check"
#: section -- this is URL syntax, not a value-domain question (an out-of-range month number
#: like '2015-99' is still rejected here, as shape, not left to DuckDB; a real but
#: nonexistent month like '2015-02' with no data is a value-domain question and IS left to
#: DuckDB, which just returns zero rows). Format only: no calendar validity (e.g. no check
#: that a year is "reasonable") beyond the two digits being 01-12.
_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

#: grain <-> its short URL token. Frozen alongside the rest of the key schema.
_GRAIN_TO_URL = {"segment": "seg", "route": "route"}
_URL_TO_GRAIN = {v: k for k, v in _GRAIN_TO_URL.items()}

#: grouping <-> its short URL token.
_GROUPING_TO_URL = {"operating": "op", "mainline": "ml"}
_URL_TO_GROUPING = {v: k for k, v in _GROUPING_TO_URL.items()}

#: The complete key vocabulary. Anything else on the query string is a rejection, not a
#: silently-ignored extra -- see module docstring.
_ALLOWED_KEYS = frozenset({"v", "k", "d", "m", "t", "f", "s", "n", "g"})

assert set(_GRAIN_TO_URL) == GRAINS, "grain URL-token map has drifted from pivot.GRAINS"
assert set(_GROUPING_TO_URL) == GROUPINGS, "grouping URL-token map has drifted from pivot.GROUPINGS"


class UrlStateError(Exception):
    """A query string could not be decoded into a valid `PivotQuery`."""


def encode(q: PivotQuery) -> str:
    """Serialize a `PivotQuery` to a query string (no leading `?`).

    Deterministic and total over every `PivotQuery` the caller can construct: every field
    always has a key, in a fixed order, so two equal queries always encode to the same
    string -- required for the `url -> state -> url` round trip. This holds only because
    `PivotQuery.__post_init__` normalizes `sort_desc` to `True` whenever `sort is None` --
    `sort=None, sort_desc=False` has no representation in this format (a direction is only
    ever emitted alongside a sort key, below), so without that normalization it would be a
    constructible `PivotQuery` this function cannot round-trip.
    """
    parts = [
        f"v={URL_VERSION}",
        f"k={_GRAIN_TO_URL[q.grain]}",
        f"d={','.join(q.dimensions)}",
        f"m={','.join(q.measures)}",
        f"t={q.time_from}:{q.time_to}",
    ]
    for key, values in q.filters:
        encoded_key = quote(key, safe="")
        encoded_values = ",".join(quote(v, safe="") for v in values)
        parts.append(f"f={encoded_key}:{encoded_values}")
    if q.sort is not None:
        prefix = "-" if q.sort_desc else ""
        parts.append(f"s={prefix}{q.sort}")
    parts.append(f"n={q.limit}")
    parts.append(f"g={_GROUPING_TO_URL[q.grouping]}")
    return "&".join(parts)


def _parse_time_range(raw: str) -> tuple[str, str]:
    if raw.count(":") != 1:
        raise UrlStateError(f"malformed time range {raw!r}, expected 'YYYY-MM:YYYY-MM'")
    time_from, time_to = raw.split(":")
    if not _MONTH_RE.match(time_from) or not _MONTH_RE.match(time_to):
        raise UrlStateError(f"malformed time range {raw!r}, expected 'YYYY-MM:YYYY-MM'")
    return time_from, time_to


def _split_pairs(qs: str) -> list[tuple[str, str]]:
    """Split a query string into `(key, raw_value)` pairs, raw meaning NOT yet `unquote`d.

    Deliberately not `urllib.parse.parse_qsl`: see the module docstring's escaping section.
    Splitting is pure slicing on the literal `&` (between pairs) and the first `=` (between a
    key and its value) -- both always literal here, because `encode` percent-encodes any `&`
    or `=` that occurs *inside* a filter value before assembly. Percent-decoding happens only
    later, after every structural delimiter -- including `f`'s own `:` and `,` -- has already
    done its job.
    """
    if not qs:
        return []
    pairs: list[tuple[str, str]] = []
    for chunk in qs.split("&"):
        if not chunk:
            continue
        key, sep, raw_value = chunk.partition("=")
        pairs.append((key, raw_value if sep else ""))
    return pairs


def _parse_filter(raw: str) -> tuple[str, tuple[str, ...]]:
    """Parse one `f` token's raw (still percent-encoded) value into `(key, values)`.

    Splits on the structural `:` and `,` first, then `unquote`s each resulting token -- so a
    percent-encoded structural character (e.g. a filter value containing a literal comma,
    encoded by `encode` as `%2C`) survives the split intact and is restored only afterward.
    """
    if ":" not in raw:
        raise UrlStateError(f"malformed filter {raw!r}, expected 'key:val1,val2,...'")
    key_raw, values_raw = raw.split(":", 1)
    key = unquote(key_raw)
    values = tuple(unquote(v) for v in values_raw.split(",") if v)
    if not key or not values:
        raise UrlStateError(f"malformed filter {raw!r}, expected 'key:val1,val2,...'")
    return key, values


def decode(qs: str, con) -> PivotQuery:
    """Parse a query string into a `PivotQuery`, validated via `con` against the catalog.

    Raises `UrlStateError` for anything malformed at the URL-syntax level (see module
    docstring), and re-raises `pipeline.pivot.PivotError` -- from `render_pivot`, called
    purely to validate -- as `UrlStateError` so callers only need to catch one exception
    type from this module.
    """
    pairs = _split_pairs(qs)

    unknown = [key for key, _ in pairs if key not in _ALLOWED_KEYS]
    if unknown:
        raise UrlStateError(f"unknown query key(s): {sorted(set(unknown))}")

    # 'f' is the only key documented as repeatable (see module docstring's key schema); a
    # repeated non-'f' key is not something `encode` ever produces, so -- same principle as
    # the unknown-key check above -- it is rejected rather than resolved last-wins-silently.
    key_counts: dict[str, int] = {}
    for key, _ in pairs:
        if key != "f":
            key_counts[key] = key_counts.get(key, 0) + 1
    duplicates = sorted(key for key, count in key_counts.items() if count > 1)
    if duplicates:
        raise UrlStateError(f"duplicate query key(s): {duplicates}")

    single: dict[str, str] = {}
    filters_raw: list[str] = []
    for key, raw_value in pairs:
        if key == "f":
            # Left un-unquoted here on purpose -- `_parse_filter` unquotes each token only
            # after splitting on ':' and ',', per the module docstring's escaping section.
            filters_raw.append(raw_value)
        else:
            single[key] = unquote(raw_value)

    version_raw = single.get("v")
    if version_raw is None:
        raise UrlStateError("missing url version ('v')")
    try:
        version = int(version_raw)
    except ValueError:
        raise UrlStateError(f"unrecognised url version {version_raw!r}") from None
    if version != URL_VERSION:
        raise UrlStateError(f"unrecognised url version {version!r}, expected {URL_VERSION}")

    grain_token = single.get("k", "")
    grain = _URL_TO_GRAIN.get(grain_token, grain_token)

    dimensions = tuple(single["d"].split(",")) if single.get("d") else ()
    measures = tuple(single["m"].split(",")) if single.get("m") else ()

    if "t" not in single:
        raise UrlStateError("missing time range ('t')")
    time_from, time_to = _parse_time_range(single["t"])

    filters = tuple(_parse_filter(raw) for raw in filters_raw)

    sort: str | None = None
    sort_desc = True
    if "s" in single:
        raw_sort = single["s"]
        if raw_sort.startswith("-"):
            sort, sort_desc = raw_sort[1:], True
        else:
            sort, sort_desc = raw_sort, False

    if "n" in single:
        try:
            limit = int(single["n"])
        except ValueError:
            raise UrlStateError(f"limit ('n') must be an integer, got {single['n']!r}") from None
    else:
        limit = 100

    grouping_token = single.get("g", "operating")
    grouping = _URL_TO_GROUPING.get(grouping_token, grouping_token)

    candidate = PivotQuery(
        grain=grain,
        dimensions=dimensions,
        measures=measures,
        time_from=time_from,
        time_to=time_to,
        filters=filters,
        sort=sort,
        sort_desc=sort_desc,
        limit=limit,
        grouping=grouping,
    )

    try:
        render_pivot(candidate, con)
    except PivotError as exc:
        raise UrlStateError(str(exc)) from exc

    return candidate
