"""Render an Explorer pivot query. CI-ONLY reference implementation.

pipeline/ never runs in prod -- the server does this in TypeScript. This module exists to
GENERATE AND VERIFY the golden fixtures that pin the contract, so M3b's implementation is a
verification exercise rather than a second, drifting validator.

Only identifiers are substituted, and only after allowlist validation against the two catalog
objects `meta_pivot_dimensions` / `meta_pivot_measures` (sql/02_marts/300_*.sql, 301_*.sql).
Values are ALWAYS bound `$params`, never interpolated -- request input never reaches a
substitution slot un-validated. Same shape as marts.py's `{{PARQUET_ROOT}}` token.

Derived measures (load_factor, asm, rpm, ...) come from the allowlist's `expr` verbatim --
this module never rebuilds a measure expression itself, which is what keeps the
no-averaging rule enforced in exactly one place (the catalog), not two.

Where the validation line is drawn (M3b needs this -- this module IS the spec it ports):
anything `render_pivot` can reject CHEAPLY as structurally malformed (an identifier not on
the allowlist, an empty dimension/measure list, a non-positive limit, a filter with no
values) raises `PivotError`. Anything that is a legitimate value-domain mismatch -- a filter
value of the wrong type for its column, an out-of-range airline_id -- is left to DuckDB's own
casting/binding to reject. Duplicating DuckDB's type system in Python would be exactly the
over-engineering the project's rules forbid elsewhere. The boundary: PivotError for "this
request could never produce valid SQL," DuckDB for "this request produced valid SQL that
doesn't match any data."
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import duckdb

QUERIES_DIR = Path(__file__).parents[1] / "sql" / "03_queries"
MAINLINE_JOIN_PATH = QUERIES_DIR / "pivot_mainline_join.sql"
GOLDENS_DIR = QUERIES_DIR / "goldens"
PIVOT_GOLDENS_PATH = GOLDENS_DIR / "pivot.json"
URLSTATE_GOLDENS_PATH = GOLDENS_DIR / "urlstate.json"

GRAINS = frozenset({"segment", "route"})
GROUPINGS = frozenset({"operating", "mainline"})

#: The one dimension whose SELECT/GROUP BY expression changes when grouping == "mainline".
#: coalesce(...) falls back to the operating carrier for anyone absent from
#: map_mainline_group (independents, shared regionals, subsidiaries before their acquisition
#: month) -- which is every carrier by default, since the map is wholly-owned-only.
_MAINLINE_CARRIER_EXPR = "coalesce(m.parent_airline_id, f.op_airline_id)"


class PivotError(Exception):
    """A pivot request referenced something not on the allowlist."""


@dataclass(frozen=True)
class PivotQuery:
    grain: str
    dimensions: tuple[str, ...]
    measures: tuple[str, ...]
    time_from: str
    time_to: str
    filters: tuple[tuple[str, tuple[str, ...]], ...] = ()
    sort: str | None = None
    sort_desc: bool = True
    limit: int = 100
    grouping: str = "operating"  # "operating" | "mainline"

    def __post_init__(self) -> None:
        # sort_desc is only meaningful once a sort key exists: with sort=None, render_pivot
        # picks the default sort key (the first measure) and reads sort_desc for its
        # direction, so `sort=None, sort_desc=False` is NOT a no-op -- it changes rendered
        # SQL from DESC to ASC. But `encode` only ever emits a direction alongside a sort key
        # (`if q.sort is not None: ...`), so a `PivotQuery(sort=None, sort_desc=False)` has no
        # representation in the URL format and silently decodes back as `sort_desc=True`.
        # Normalizing here, at construction, means every equal-by-value PivotQuery the format
        # CAN represent is the only kind that can ever be built -- so the round trip is total
        # by construction, not merely in the cases someone thought to test.
        if self.sort is None and not self.sort_desc:
            object.__setattr__(self, "sort_desc", True)


def query_to_jsonable(q: PivotQuery) -> dict:
    """`PivotQuery` -> a plain dict of JSON-safe types (tuples become lists).

    Shared by `write_goldens` (below) and `pipeline/tests/test_pivot_goldens.py` via
    `query_from_jsonable`'s inverse, so the on-disk shape of a golden case and the shape the
    test reconstructs from it can never drift apart into two hand-written definitions of the
    same mapping.
    """
    return {
        "grain": q.grain,
        "dimensions": list(q.dimensions),
        "measures": list(q.measures),
        "time_from": q.time_from,
        "time_to": q.time_to,
        "filters": [[key, list(values)] for key, values in q.filters],
        "sort": q.sort,
        "sort_desc": q.sort_desc,
        "limit": q.limit,
        "grouping": q.grouping,
    }


def query_from_jsonable(d: dict) -> PivotQuery:
    """Inverse of `query_to_jsonable`. Defaults on `sort`/`sort_desc`/`limit`/`grouping` match
    `PivotQuery`'s own, so a golden case that omits one (none currently do) still round-trips
    to the same query a bare `PivotQuery(...)` call would produce."""
    return PivotQuery(
        grain=d["grain"],
        dimensions=tuple(d["dimensions"]),
        measures=tuple(d["measures"]),
        time_from=d["time_from"],
        time_to=d["time_to"],
        filters=tuple((key, tuple(values)) for key, values in d.get("filters", [])),
        sort=d.get("sort"),
        sort_desc=d.get("sort_desc", True),
        limit=d.get("limit", 100),
        grouping=d.get("grouping", "operating"),
    )


def load_allowlist(
    con: duckdb.DuckDBPyConnection,
) -> tuple[dict[str, dict], dict[str, dict]]:
    """Read the two catalog objects Task 2 built into plain dicts keyed by `key`.

    Queried fresh on every call rather than cached at import time: the allowlist is a cheap
    view over hand-curated VALUES rows, and a module-level cache would let a stale allowlist
    survive a database rebuilt mid-process -- exactly what `make verify`'s two-pass build
    does.
    """
    dims = {
        r[0]: dict(
            zip(("key", "label", "column_expr", "grain", "join_dim", "join_key"), r, strict=True)
        )
        for r in con.execute((QUERIES_DIR / "catalog_dimensions.sql").read_text()).fetchall()
    }
    meas = {
        r[0]: dict(zip(("key", "label", "is_additive", "expr"), r, strict=True))
        for r in con.execute((QUERIES_DIR / "catalog_measures.sql").read_text()).fetchall()
    }
    return dims, meas


def _validate_dimension(key: str, dims: dict[str, dict], grain: str) -> dict:
    """Look up `key` on the dimension allowlist and check it against the requested grain.

    This is the ONE place a dimension key is checked, for both the dimension list and every
    filter key -- so an unvalidated string can reach neither a SELECT/GROUP BY slot nor a
    filter's identifier slot.
    """
    entry = dims.get(key)
    if entry is None:
        raise PivotError(f"unknown dimension {key!r}")
    if entry["grain"] not in ("both", grain):
        raise PivotError(
            f"dimension {key!r} is {entry['grain']!r}-grain, not offered at {grain!r} grain "
            f"-- offering it would render SQL that fails at execution, not at validation"
        )
    return entry


def _validate_measure(key: str, meas: dict[str, dict]) -> dict:
    entry = meas.get(key)
    if entry is None:
        raise PivotError(f"unknown measure {key!r}")
    return entry


def _dimension_columns(entry: dict) -> list[str]:
    """Split a dimension's `column_expr` into its underlying column name(s).

    Most dimensions are one column; `route` is the PAIR `route_key_low, route_key_high`.
    Shared by the filter and sort logic below so a multi-column dimension is handled once,
    not reasoned about separately in two places.
    """
    return [c.strip() for c in entry["column_expr"].split(",")]


def _dim_render(key: str, entry: dict, grouping: str) -> tuple[str, str, str]:
    """Return `(select_expr, group_by_expr, sortable_name)` for one dimension key.

    Identical for every dimension except `op_airline_id` under `grouping == "mainline"`:
    there the SELECT item is `coalesce(...) AS op_airline_id` -- aliased back to the
    dimension's own key -- so the OUTPUT column name (and therefore what ORDER BY can name)
    is identical in both grouping modes, matching every other dimension's behavior. GROUP BY
    uses the raw, unaliased expression: relying on an output alias inside GROUP BY is
    engine-specific behavior this module -- the spec M3b's TypeScript port copies -- should
    not assume.

    `sortable_name` is only meaningful for single-column dimensions; the caller checks
    `_dimension_columns(entry)` before trusting it (route, the one multi-column dimension,
    has no single sortable name).
    """
    if grouping == "mainline" and key == "op_airline_id":
        return f"{_MAINLINE_CARRIER_EXPR} AS op_airline_id", _MAINLINE_CARRIER_EXPR, "op_airline_id"
    return entry["column_expr"], entry["column_expr"], entry["column_expr"]


def render_pivot(q: PivotQuery, con: duckdb.DuckDBPyConnection) -> tuple[str, dict]:
    """Validate `q` against the catalog allowlists and render one of the pivot templates.

    Returns `(sql, params)`. `sql` has only validated identifiers substituted; every value
    in `q` -- the time range, the limit, every filter value -- is bound in `params`, never
    written into `sql` as text.
    """
    if q.grain not in GRAINS:
        raise PivotError(f"unknown grain {q.grain!r}, expected one of {sorted(GRAINS)}")
    if q.grouping not in GROUPINGS:
        raise PivotError(f"unknown grouping {q.grouping!r}, expected one of {sorted(GROUPINGS)}")

    # Structurally malformed requests, rejected before touching the allowlist or the
    # template: an empty dimension/measure list renders a stray-comma SELECT that only fails
    # once DuckDB parses it, and deselecting every dimension (or every measure) is a
    # plausible Explorer UI state, not an exotic edge case.
    if not q.dimensions:
        raise PivotError("at least one dimension is required")
    if not q.measures:
        raise PivotError("at least one measure is required")
    if isinstance(q.limit, bool) or not isinstance(q.limit, int) or q.limit <= 0:
        raise PivotError(f"limit must be a positive integer, got {q.limit!r}")
    for key, values in q.filters:
        if not values:
            raise PivotError(f"filter {key!r} has no values")

    dims, meas = load_allowlist(con)

    dim_entries = [_validate_dimension(key, dims, q.grain) for key in q.dimensions]
    measure_entries = [_validate_measure(key, meas) for key in q.measures]

    # column_expr is already the real column name(s) on the fact table (e.g. 'op_airline_id',
    # or the PAIR 'route_key_low, route_key_high' for the route dimension) -- so no alias is
    # needed, and joining dimension exprs with a comma naturally handles a multi-column
    # dimension without any code that assumes one column per key.
    #
    # The one exception is op_airline_id under grouping == "mainline" -- see _dim_render's
    # docstring. dim_renders is computed once and shared by dim_select/group_by below AND by
    # the sortable map further down, so the SELECT alias and what ORDER BY may reference can
    # never drift apart.
    dim_renders = [
        _dim_render(key, entry, q.grouping)
        for key, entry in zip(q.dimensions, dim_entries, strict=True)
    ]
    dim_select = ", ".join(r[0] for r in dim_renders)
    group_by = ", ".join(r[1] for r in dim_renders)

    measure_select = ", ".join(
        f"{entry['expr']} AS {key}"
        for key, entry in zip(q.measures, measure_entries, strict=True)
    )

    params: dict[str, object] = {
        "time_from": q.time_from,
        "time_to": q.time_to,
        "limit": q.limit,
    }

    filter_clauses: list[str] = []
    for i, (key, values) in enumerate(q.filters):
        entry = _validate_dimension(key, dims, q.grain)
        columns = _dimension_columns(entry)
        if len(columns) == 1:
            placeholders = []
            for j, value in enumerate(values):
                pname = f"f{i}_{j}"
                params[pname] = value
                placeholders.append(f"${pname}")
            filter_clauses.append(f"{columns[0]} IN ({', '.join(placeholders)})")
            continue

        # A composite dimension names more than one key column -- `route` is
        # (route_key_low, route_key_high). One filter VALUE encodes one whole route as
        # "<low>-<high>", so multiple values stay OR'd exactly like every other dimension's
        # IN-list rather than inventing a positional pair convention that would make
        # "a,b,c" meaningless.
        #
        # least()/greatest() rather than trusting stored column order: the filter must be
        # correct however the fact row was written. Filtering the underlying columns
        # separately -- what this branch used to tell callers to do -- is NOT equivalent and
        # is silently wrong: `origin IN (a,b) AND dest IN (a,b)` also matches a->a and b->b,
        # and 12,738 such same-airport filings exist across 530 airports. On JFK-LAX that
        # inflates seats by 18,895 (docs/data/invariants.md).
        if len(columns) != 2:
            raise PivotError(
                f"dimension {key!r} spans {len(columns)} columns; only two are supported"
            )
        pair_clauses = []
        for j, value in enumerate(values):
            parts = value.split("-")
            if len(parts) != 2 or not all(p.strip() for p in parts):
                raise PivotError(
                    f"filter value {value!r} for composite dimension {key!r} must be "
                    "two ids joined by '-', e.g. '12478-12892'"
                )
            lo_name, hi_name = f"f{i}_{j}a", f"f{i}_{j}b"
            params[lo_name] = parts[0].strip()
            params[hi_name] = parts[1].strip()
            pair_clauses.append(
                f"(least({columns[0]}, {columns[1]}) = ${lo_name} "
                f"AND greatest({columns[0]}, {columns[1]}) = ${hi_name})"
            )
        filter_clauses.append(f"({' OR '.join(pair_clauses)})")
    filters_sql = " AND ".join(filter_clauses) if filter_clauses else "TRUE"

    # Sortable identifiers are exactly what's in the SELECT list: single-column dimensions by
    # their OUTPUT column name (from dim_renders -- the alias when op_airline_id was rewritten
    # for mainline grouping, the bare column name otherwise), and measures by their alias. A
    # multi-column dimension (route) has no single sortable name, so it is deliberately absent
    # here.
    sortable: dict[str, str] = {}
    for (key, entry), (_select_expr, _group_expr, sortable_name) in zip(
        zip(q.dimensions, dim_entries, strict=True), dim_renders, strict=True
    ):
        columns = _dimension_columns(entry)
        if len(columns) == 1:
            sortable[key] = sortable_name
    for key in q.measures:
        sortable[key] = key

    sort_key = q.sort
    if sort_key is None:
        if not sortable:
            raise PivotError("no sort specified and nothing sortable is selected")
        # Prefer the first requested measure so a sort default always points at a value
        # column, not a dimension -- matches how every product Top-N view is read. No `else`
        # branch: `q.measures` is already guaranteed non-empty by the "at least one measure
        # is required" check near the top of this function, so falling back to `sortable`
        # here would be unreachable dead code, not defensive.
        sort_key = q.measures[0]

    if sort_key not in sortable:
        raise PivotError(
            f"unknown sort key {sort_key!r}: must be one of the selected dimensions or "
            f"measures ({sorted(sortable)})"
        )
    direction = "DESC" if q.sort_desc else "ASC"
    sort_sql = f"{sortable[sort_key]} {direction}"

    # The join is its own .sql file, not a string built in Python -- read fresh each call,
    # same as the templates below, so query logic lives in exactly one place. Rendered to the
    # empty string for "operating" so the default grouping adds no join at all.
    mainline_join_sql = (
        "\n" + MAINLINE_JOIN_PATH.read_text().rstrip("\n") if q.grouping == "mainline" else ""
    )

    template_path = QUERIES_DIR / f"pivot_{q.grain}.sql"
    sql = template_path.read_text()
    sql = sql.replace("{{DIM_SELECT}}", dim_select)
    sql = sql.replace("{{MEASURE_SELECT}}", measure_select)
    sql = sql.replace("{{GROUP_BY}}", group_by)
    sql = sql.replace("{{FILTERS}}", filters_sql)
    sql = sql.replace("{{SORT}}", sort_sql)
    sql = sql.replace("{{MAINLINE_JOIN}}", mainline_join_sql)

    return sql, params


# ---------------------------------------------------------------------------------------
# Golden fixtures -- `make goldens`.
#
# sql/03_queries/goldens/{pivot,urlstate}.json are the M3a handoff artifact: M3b's
# TypeScript is verified against these exact bytes rather than re-deriving this module's
# validation/rendering semantics. Each case below is a `PivotQuery`; `write_goldens` renders
# it through THIS module's own `render_pivot` (and, for the URL cases,
# `pipeline.urlstate.encode`/`decode`) and writes the result verbatim. The cases are curated
# here, not generated combinatorially, because which combinations matter is a judgment call
# about what the contract needs to prove -- see each case's `description`.
# ---------------------------------------------------------------------------------------

#: (name, description, query). Covers: a single-dimension segment pivot; a multi-dimension
#: pivot; a route-grain pivot (the multi-column `route` dimension); a derived-measure pivot
#: (also the case Step 4 of the M3a plan mutates to prove the goldens pin something); a
#: filtered pivot; a mainline-grouped pivot; an ascending-sort pivot; and the Task 5
#: regression -- sorting by the carrier dimension under mainline grouping, which crashed
#: until op_airline_id's ORDER BY expression was made to match its GROUP BY expression.
_PIVOT_GOLDEN_CASES: list[tuple[str, str, PivotQuery]] = [
    (
        "single_dimension_segment",
        "One dimension, one additive measure, segment grain, default sort/limit/grouping.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12",
        ),
    ),
    (
        "multi_dimension_segment",
        "Two dimensions x two measures -- exercises the comma-joined SELECT/GROUP BY list.",
        PivotQuery(
            grain="segment", dimensions=("year_month", "op_airline_id"),
            measures=("seats", "passengers"), time_from="2015-01", time_to="2015-12",
        ),
    ),
    (
        "route_grain",
        "The route dimension's multi-column column_expr (route_key_low, route_key_high) at "
        "route grain, against fct_route_month's SUM(quarantined_rows) -- not the segment "
        "template's COUNT(*) FILTER.",
        PivotQuery(
            grain="route", dimensions=("route",), measures=("seats",),
            time_from="2015-01", time_to="2015-12",
        ),
    ),
    (
        "derived_measure_load_factor",
        "load_factor: SUM(passengers)/NULLIF(SUM(seats),0), each SUM filtered by NOT "
        "is_quarantined -- never AVG(). Step 4 of the M3a plan mutates this measure's expr "
        "in sql/02_marts/301_meta_pivot_measures.sql to prove this golden actually pins it.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("load_factor",),
            time_from="2015-01", time_to="2015-12",
        ),
    ),
    (
        "filtered_by_carrier",
        "A filter clause: op_airline_id IN ($f0_0, $f0_1) -- the values are bound params, "
        "never interpolated into the SQL text.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12",
            filters=(("op_airline_id", ("19790", "19805")),),
        ),
    ),
    (
        "mainline_grouped",
        "grouping='mainline': op_airline_id's SELECT/GROUP BY becomes "
        "coalesce(m.parent_airline_id, f.op_airline_id) AS op_airline_id and "
        "pivot_mainline_join.sql's LEFT JOIN is appended after FROM.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12", grouping="mainline",
        ),
    ),
    (
        "mainline_grouped_with_filter_on_carrier",
        "The undocumented-until-now gap pinned in pivot_mainline_join.sql's header: under "
        "grouping='mainline' the SELECT/GROUP BY dimension coalesces to the parent airline, "
        "but {{FILTERS}} still renders the raw, un-coalesced op_airline_id IN (...) -- "
        "filtering a mainline-grouped pivot to a parent excludes rows its subsidiaries "
        "contribute to that same rolled-up row. See "
        "test_mainline_filter_does_not_coalesce_like_the_dimension_does in "
        "test_pivot_real_data.py for the real-number proof (3,842,350 unfiltered vs "
        "2,336,210 filtered, 2017-01, op_airline_id=19930/Alaska). This is a pin of CURRENT "
        "behaviour, not an endorsement -- see the SQL file's header for why it's unchanged.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12", grouping="mainline",
            filters=(("op_airline_id", ("19930",)),),
        ),
    ),
    (
        "ascending_sort",
        "sort_desc=False renders 'ORDER BY seats ASC' instead of the default DESC.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12", sort="seats", sort_desc=False,
        ),
    ),
    (
        "sort_by_carrier_under_mainline_grouping",
        "The Task 5 regression: under grouping='mainline', op_airline_id's GROUP BY "
        "expression is coalesce(m.parent_airline_id, f.op_airline_id), not the bare column, "
        "so ORDER BY must reference the identical expression -- the alias the SELECT list "
        "assigns back to op_airline_id lets ORDER BY name it uniformly in both grouping "
        "modes.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12", sort="op_airline_id", grouping="mainline",
        ),
    ),
]

#: (name, description, query). Covers the URL codec's own required round-trips: grain='route'
#: through its short token ('k=route'); grouping='mainline' through its short token ('g=ml');
#: an ascending sort (no '-' prefix on 's'); ordinary multi-value filters; and a filter value
#: containing every character the URL format itself uses structurally (',' '&' '%' ':' '='
#: '+' and a space) -- the one piece of user/attacker-controlled free text in the contract.
_URLSTATE_GOLDEN_CASES: list[tuple[str, str, PivotQuery]] = [
    (
        "baseline_round_trip",
        "Multiple dimensions and measures, explicit descending sort, non-default limit.",
        PivotQuery(
            grain="segment", dimensions=("year_month", "op_airline_id"),
            measures=("seats", "load_factor"), time_from="2015-01", time_to="2015-12",
            sort="seats", sort_desc=True, limit=25,
        ),
    ),
    (
        "route_grain",
        "grain='route' round-trips through its short URL token ('k=route').",
        PivotQuery(
            grain="route", dimensions=("route",), measures=("seats",),
            time_from="2015-01", time_to="2015-12",
        ),
    ),
    (
        "mainline_grouping",
        "grouping='mainline' round-trips through its short URL token ('g=ml') -- must not "
        "silently decode back to the 'operating' default.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12", grouping="mainline",
        ),
    ),
    (
        "ascending_sort",
        "sort_desc=False encodes without the '-' prefix ('s=seats', not 's=-seats').",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12", sort="seats", sort_desc=False,
        ),
    ),
    (
        "no_sort_key_ignores_sort_desc",
        "PivotQuery(sort=None, sort_desc=False) has no representation in this format -- a "
        "direction is only ever emitted alongside a sort key -- so PivotQuery.__post_init__ "
        "normalizes sort_desc back to True at construction time. That normalization itself "
        "is guarded by pipeline/tests/test_pivot.py's "
        "test_sort_desc_normalizes_to_true_when_sort_is_none and "
        "pipeline/tests/test_urlstate.py's test_sort_none_and_sort_desc_false_round_trips, "
        "both mutation-verified. This golden pins only the ENCODED FORM the normalized "
        "query produces (no 's=' key, identical to the default) -- since query_from_jsonable "
        "reconstructs an already-normalized PivotQuery from the stored 'sort_desc: true', a "
        "regression that removed the normalization would NOT fail this or any other golden "
        "test; it would only show up as a diff in the next `make goldens` regeneration, "
        "which no test runs automatically.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12", sort=None, sort_desc=False,
        ),
    ),
    (
        "multiple_plain_filter_values",
        "A filter with several ordinary values, joined by the structural ','.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12",
            filters=(("origin_airport_id", ("14771", "13487", "12892")),),
        ),
    ),
    (
        "filter_value_reserved_characters",
        "A filter value containing every character the URL format itself uses as a "
        "delimiter or the escape character (',' '&' '%' ':' '=' '+' and a space) -- must "
        "percent-encode and round-trip exactly rather than corrupt the structural "
        "delimiters or silently reparse into the wrong number of values.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12",
            filters=(
                ("origin_airport_id", ("14,771", "13&487", "9%5", "12:34", "a=b", "a+b", "a b")),
            ),
        ),
    ),
    (
        "filter_value_encodeuricomponent_divergence",
        "Filter values containing ! * ' ( ) -- the characters JS encodeURIComponent leaves "
        "literal but Python quote(safe='') percent-encodes. Real data: 119 "
        "unique_carrier_code values carry BTS's '(1)' suffix, 163 airport names an "
        "apostrophe. Pins the encoding for M3b's TypeScript port.",
        PivotQuery(
            grain="segment", dimensions=("op_airline_id",), measures=("seats",),
            time_from="2015-01", time_to="2015-12",
            filters=(("op_airline_id", ("2T (1)", "O'Hare", "a!b", "c*d")),),
        ),
    ),
]


def _goldens_connection(tmp_path: Path) -> duckdb.DuckDBPyConnection:
    """Build the same small, deterministic warehouse pipeline/tests/test_pivot.py and
    test_urlstate.py build from the fixtures committed under pipeline/tests/fixtures/.

    Deliberately the ONLY place pipeline/pivot.py imports from pipeline/tests: this reuses
    that construction instead of writing a second "how to build a throwaway warehouse from
    fixtures" recipe that could silently drift from the one every other pivot test already
    relies on. Rendered SQL/params depend only on the catalog views (300_/301_, hand-curated
    VALUES) and the static template files -- never on fact row content -- so this warehouse
    (built from a 2015 sample) is exactly as valid a source for the goldens as the full
    2015-2026 production database would be, and is available in any checkout without first
    requiring `make ingest` against live BTS data.
    """
    from pipeline.marts import build_database
    from pipeline.tests.test_marts import _warehouse

    db = tmp_path / "goldens.duckdb"
    build_database(_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n")


def write_goldens() -> None:
    """Regenerate sql/03_queries/goldens/{pivot,urlstate}.json. `make goldens` runs this.

    NEVER hand-edit the JSON -- see each file's own `_data_not_sql` header and
    pipeline/tests/test_pivot_goldens.py, which is what actually consumes them. Every case is
    executed against real DuckDB (not merely rendered) before being written, and every
    urlstate case's encode/decode round trip is asserted before being written -- a golden
    built from a query that doesn't actually run, or a round trip that's already broken,
    would only enshrine the bug.
    """
    import tempfile

    from pipeline.urlstate import decode, encode

    with tempfile.TemporaryDirectory() as tmp:
        con = _goldens_connection(Path(tmp))
        try:
            pivot_cases = []
            for name, description, query in _PIVOT_GOLDEN_CASES:
                sql, params = render_pivot(query, con)
                con.execute(sql, params).fetchall()
                pivot_cases.append(
                    {
                        "name": name,
                        "description": description,
                        "query": query_to_jsonable(query),
                        "sql": sql,
                        "params": params,
                    }
                )

            url_cases = []
            for name, description, query in _URLSTATE_GOLDEN_CASES:
                url = encode(query)
                decoded = decode(url, con)
                assert decoded == query, (
                    f"{name}: encode/decode did not round-trip while generating the "
                    "golden -- a fixture built from a broken round trip would only "
                    "confirm the bug, never catch it"
                )
                url_cases.append(
                    {
                        "name": name,
                        "description": description,
                        "query": query_to_jsonable(query),
                        "url": url,
                    }
                )
        finally:
            con.close()

    GOLDENS_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(
        PIVOT_GOLDENS_PATH,
        {
            "_data_not_sql": (
                "This file lives under sql/03_queries/ for proximity to the templates it "
                "pins, but it is DATA, not SQL -- consumed by "
                "pipeline/tests/test_pivot_goldens.py, never executed directly. Regenerate "
                "ONLY via `make goldens` (python -m pipeline.pivot --write-goldens), and "
                "read the diff by eye before committing: a golden file is only as good as "
                "its first generation."
            ),
            "cases": pivot_cases,
        },
    )
    _write_json(
        URLSTATE_GOLDENS_PATH,
        {
            "_data_not_sql": (
                "Same note as pivot.json: DATA, not SQL, despite the sql/ path. Pins "
                "pipeline.urlstate's encode/decode contract -- consumed by "
                "pipeline/tests/test_pivot_goldens.py. Regenerate ONLY via `make goldens`."
            ),
            "cases": url_cases,
        },
    )


def main(argv: list[str] | None = None) -> int:
    """`make goldens`."""
    import argparse

    parser = argparse.ArgumentParser(description="Generate the Explorer pivot contract goldens.")
    parser.add_argument(
        "--write-goldens",
        action="store_true",
        help="Regenerate sql/03_queries/goldens/{pivot,urlstate}.json from this module",
    )
    args = parser.parse_args(argv)
    if not args.write_goldens:
        parser.error("nothing to do -- pass --write-goldens")

    write_goldens()
    print(f"wrote {PIVOT_GOLDENS_PATH} ({len(_PIVOT_GOLDEN_CASES)} cases)")
    print(f"wrote {URLSTATE_GOLDENS_PATH} ({len(_URLSTATE_GOLDEN_CASES)} cases)")
    return 0


if __name__ == "__main__":
    # `python -m pipeline.pivot` runs this file as the `__main__` module -- a SEPARATE module
    # object from `pipeline.pivot`, with its own copy of every class defined here. Once
    # `write_goldens` imports `pipeline.urlstate` (which does its own top-level
    # `from pipeline.pivot import ... PivotQuery ...`), Python has never seen 'pipeline.pivot'
    # imported by that dotted name before, so it imports the file a SECOND time as a genuinely
    # distinct module -- `pipeline.urlstate.decode` then returns a `PivotQuery` instance built
    # from that second class, which a frozen dataclass's `__eq__` (type-checked) never
    # considers equal to a `PivotQuery` from `__main__`'s class, even with identical fields.
    # Importing the canonical module explicitly here -- before `main()` runs -- registers
    # 'pipeline.pivot' in `sys.modules` up front, so `pipeline.urlstate`'s later import
    # resolves to the SAME module `main()` itself is running from, and every `PivotQuery`
    # compared anywhere in `write_goldens` is the one class. Caught by running
    # `make goldens` for real rather than only via `python -c "...write_goldens()"`, which
    # imports this module normally and never reproduces the bug.
    import pipeline.pivot as _canonical

    raise SystemExit(_canonical.main())
