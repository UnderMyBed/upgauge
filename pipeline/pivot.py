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
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import duckdb

QUERIES_DIR = Path(__file__).parents[1] / "sql" / "03_queries"

GRAINS = frozenset({"segment", "route"})


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
    grouping: str = "operating"  # "operating" | "mainline" -- reserved for a later task


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


def render_pivot(q: PivotQuery, con: duckdb.DuckDBPyConnection) -> tuple[str, dict]:
    """Validate `q` against the catalog allowlists and render one of the pivot templates.

    Returns `(sql, params)`. `sql` has only validated identifiers substituted; every value
    in `q` -- the time range, the limit, every filter value -- is bound in `params`, never
    written into `sql` as text.
    """
    if q.grain not in GRAINS:
        raise PivotError(f"unknown grain {q.grain!r}, expected one of {sorted(GRAINS)}")

    dims, meas = load_allowlist(con)

    dim_entries = [_validate_dimension(key, dims, q.grain) for key in q.dimensions]
    measure_entries = [_validate_measure(key, meas) for key in q.measures]

    # column_expr is already the real column name(s) on the fact table (e.g. 'op_airline_id',
    # or the PAIR 'route_key_low, route_key_high' for the route dimension) -- so no alias is
    # needed, and joining dimension exprs with a comma naturally handles a multi-column
    # dimension without any code that assumes one column per key.
    dim_select = ", ".join(entry["column_expr"] for entry in dim_entries)
    group_by = dim_select

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
        columns = [c.strip() for c in entry["column_expr"].split(",")]
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
    # their (unaliased) column name, and measures by their alias. A multi-column dimension
    # (route) has no single sortable name, so it is deliberately absent here.
    sortable: dict[str, str] = {}
    for key, entry in zip(q.dimensions, dim_entries, strict=True):
        columns = [c.strip() for c in entry["column_expr"].split(",")]
        if len(columns) == 1:
            sortable[key] = columns[0]
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

    template_path = QUERIES_DIR / f"pivot_{q.grain}.sql"
    sql = template_path.read_text()
    sql = sql.replace("{{DIM_SELECT}}", dim_select)
    sql = sql.replace("{{MEASURE_SELECT}}", measure_select)
    sql = sql.replace("{{GROUP_BY}}", group_by)
    sql = sql.replace("{{FILTERS}}", filters_sql)
    sql = sql.replace("{{SORT}}", sort_sql)

    return sql, params
