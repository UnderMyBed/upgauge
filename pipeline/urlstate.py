"""The permalink codec: `PivotQuery` <-> query string. CI-ONLY reference implementation.

pipeline/ never runs in prod -- the server does this in TypeScript. This module IS the
spec M3b's port is verified against, same relationship as pivot.py's `render_pivot` to the
templates it renders.

**The encoding is a frozen public contract from the first shipped link.** Keys are short and
readable, not a base64 JSON blob: this audience hand-edits permalinks and pastes them into
forums, where an opaque blob is both unreadable and un-editable. `v=1` exists so a future
incompatible change can migrate a link instead of silently misreading it.

**Decode is TOTAL.** An unknown query-string key, an unrecognised or missing `v`, or anything
that fails `render_pivot`'s own allowlist/structural validation (unknown dimension/measure/
sort key, unknown grain/grouping, empty dimension or measure list, a non-positive limit, a
filter with no values) is a rejection via `UrlStateError` -- never a silent drop to a
default. A permalink that quietly renders a *different* query than the one it encodes still
screenshots as authoritative, which is worse than one that errors.

**Division of validation labour** (per the project rule against a second, drifting
validator): identifier and structural validation -- is this dimension/measure/sort key on
the allowlist, is the grain/grouping recognised, is the limit a positive int, does every
filter have values -- is reused *as-is* from `pipeline.pivot.render_pivot`, which this module
calls purely to validate a candidate `PivotQuery` (its rendered SQL/params are discarded).
That is the ONE place those rules live.

What `render_pivot` cannot check, because it is URL syntax rather than a `PivotQuery` field,
is validated HERE instead:
  - the `v` key itself (present, and equal to `URL_VERSION`);
  - unknown query-string keys (anything not in `_ALLOWED_KEYS`);
  - the shape of `t` (`YYYY-MM:YYYY-MM`) and `f` (`key:val1,val2,...`) tokens;
  - parsing `n` as an integer at all (a non-numeric limit is a codec-level parse failure,
    not a value `render_pivot` would ever see as anything but the wrong Python type).
"""

from __future__ import annotations

from urllib.parse import parse_qsl

from pipeline.pivot import GRAINS, GROUPINGS, PivotError, PivotQuery, render_pivot

URL_VERSION = 1

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
    string -- required for the `url -> state -> url` round trip.
    """
    parts = [
        f"v={URL_VERSION}",
        f"k={_GRAIN_TO_URL[q.grain]}",
        f"d={','.join(q.dimensions)}",
        f"m={','.join(q.measures)}",
        f"t={q.time_from}:{q.time_to}",
    ]
    for key, values in q.filters:
        parts.append(f"f={key}:{','.join(values)}")
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
    if not time_from or not time_to:
        raise UrlStateError(f"malformed time range {raw!r}, expected 'YYYY-MM:YYYY-MM'")
    return time_from, time_to


def _parse_filter(raw: str) -> tuple[str, tuple[str, ...]]:
    if ":" not in raw:
        raise UrlStateError(f"malformed filter {raw!r}, expected 'key:val1,val2,...'")
    key, values_raw = raw.split(":", 1)
    values = tuple(v for v in values_raw.split(",") if v)
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
    pairs = parse_qsl(qs, keep_blank_values=True)

    unknown = [key for key, _ in pairs if key not in _ALLOWED_KEYS]
    if unknown:
        raise UrlStateError(f"unknown query key(s): {sorted(set(unknown))}")

    single: dict[str, str] = {}
    filters_raw: list[str] = []
    for key, value in pairs:
        if key == "f":
            filters_raw.append(value)
        else:
            # Last one wins for a repeated non-'f' key; nothing in the schema needs the
            # first, and 'f' is the only key documented as repeatable.
            single[key] = value

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
