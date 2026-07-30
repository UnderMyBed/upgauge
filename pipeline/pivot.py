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

from dataclasses import dataclass
from pathlib import Path

import duckdb

QUERIES_DIR = Path(__file__).parents[1] / "sql" / "03_queries"
MAINLINE_JOIN_PATH = QUERIES_DIR / "pivot_mainline_join.sql"

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
        for r in con.execute("SELECT * FROM meta_pivot_dimensions").fetchall()
    }
    meas = {
        r[0]: dict(zip(("key", "label", "is_additive", "expr"), r, strict=True))
        for r in con.execute("SELECT * FROM meta_pivot_measures").fetchall()
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
        if len(columns) != 1:
            raise PivotError(
                f"dimension {key!r} spans multiple columns ({entry['column_expr']}); "
                "filter on the underlying columns directly, not the composite dimension"
            )
        placeholders = []
        for j, value in enumerate(values):
            pname = f"f{i}_{j}"
            params[pname] = value
            placeholders.append(f"${pname}")
        filter_clauses.append(f"{columns[0]} IN ({', '.join(placeholders)})")
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
        # column, not a dimension -- matches how every product Top-N view is read.
        sort_key = q.measures[0] if q.measures else next(iter(sortable))

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
