"""Generated reference values -- the artifact that makes upstream data drift legible.

The 2026-08-07 BTS refresh renamed aircraft type 699 'A321/LR' -> 'A321nXLR'. That moved NO
underlying number and still reddened 17 assertions and one smoke needle across six files,
because every value was hand-pinned. This module emits those values as one committed,
diff-gated artifact instead, the same shape as app/src/lib/map/basemapPaths.generated.ts --
a pattern `make verify` already gates and which has never drifted.

Query logic lives in sql/03_queries/stats_reference.sql and stats_counts.sql, per CLAUDE.md's
hard rule.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import duckdb

_SQL_DIR = Path(__file__).parents[1] / "sql" / "03_queries"
# Two files, one namespace. stats_reference.sql holds WAREHOUSE-shape figures; stats_counts.sql
# holds PAGE-cardinality ones (#91). They are merged rather than nested so the artifact stays
# one flat `measures` map -- callers should not need to know which file a measure came from --
# and a name colliding ACROSS the two is rejected, not silently resolved by file order.
SQL_PATHS = (_SQL_DIR / "stats_reference.sql", _SQL_DIR / "stats_counts.sql")
STATS_PATH = Path(__file__).parent / "reference" / "stats.generated.json"
DB_PATH = Path("upgauge.duckdb")

_NAME = re.compile(r"^--\s*name:\s*(\w+)\s*$", re.MULTILINE)

# Measures returning one row of one column collapse to a scalar; everything else becomes a
# list of dicts. Keeping this explicit rather than inferring from the result shape means a
# measure that starts returning two rows fails loudly instead of silently changing type.
_SCALAR = frozenset(
    {
        "max_year_month",
        "fact_rows",
        "quarantined_rows",
        "dim_airport_current",
        "dim_carrier_rows",
        "dim_aircraft_type_rows",
        "city_markets",
        "fact_present_aircraft_codes",
        # Page cardinality (#91). Every one of these was stated in prose and generated nowhere.
        "sitemap_routes",
        "same_airport_pairs",
        "same_airport_filings",
        "route_pairs_with_same_airport",
        "sitemap_airports",
        "sitemap_carriers",
        "sitemap_aircraft",
        "route_order_disagreeing_pairs",
        "route_order_agreeing_pairs",
        "route_pairs_with_a_gap_month",
        "route_pairs_stale_vs_trailing_12",
        # mart_route_health cardinality (#146, #148). The grain is a carrier-route PAIR,
        # which is why rows and pairs are both here and are different numbers.
        "route_health_rows",
        "route_health_pairs",
        "route_health_scored",
        "route_health_with_prior_window",
        "route_health_null_score",
        "route_health_no_prior_window",
        "route_health_no_schedule",
        "route_health_null_overlap",
        "route_health_same_airport_rows",
    }
)


def measures_sql(path: Path) -> dict[str, str]:
    """Split ONE SQL file into {measure name: statement} on its `-- name:` markers.

    Two authoring mistakes are rejected rather than silently swallowed:

    - A repeated `-- name:` marker. The naive version of this loop lets the second block
      overwrite the first in `out`, so a copy-pasted template block that keeps the old name
      loses a measure with zero signal.
    - A `;` still present after the single trailing one is stripped. Confirmed against DuckDB:
      `con.execute("SELECT 1; SELECT 2;").fetchall()` returns `[(2,)]` -- a stray second
      statement executes silently and its result is reported under the first statement's name.
      `collect()`'s `_SCALAR` guard only checks the returned SHAPE, and a second
      `count(...)`-shaped statement passes that check, so this is the only line of defense.
    """
    parts = _NAME.split(path.read_text())
    # parts[0] is the header comment; then alternating name, body.
    out: dict[str, str] = {}
    for name, body in zip(parts[1::2], parts[2::2], strict=True):
        statement = body.strip()
        if statement.endswith(";"):
            statement = statement[:-1].strip()
        if not statement:
            continue
        if ";" in statement:
            raise ValueError(
                f"{name}: statement body contains an embedded ';' after the trailing one was "
                "stripped -- a measure must be exactly one statement"
            )
        if name in out:
            raise ValueError(f"{name}: duplicate '-- name:' marker")
        out[name] = statement
    return out


def all_measures_sql(paths: tuple[Path, ...] = SQL_PATHS) -> dict[str, str]:
    """Merge every measure file into one flat namespace.

    A name colliding ACROSS the two files is rejected rather than resolved by file order --
    `measures_sql` can only see duplicates within its own file, so without this check a measure
    copy-pasted from stats_reference.sql into stats_counts.sql would silently shadow the
    original and one of the two would vanish from the artifact with no signal.
    """
    out: dict[str, str] = {}
    for path in paths:
        for name, statement in measures_sql(path).items():
            if name in out:
                raise ValueError(
                    f"{name}: duplicate '-- name:' marker across {', '.join(q.name for q in paths)}"
                )
            out[name] = statement
    return out


def _derive(measures: dict[str, Any]) -> None:
    """Totals that are ARITHMETIC over other measures, not queries of their own.

    Derived here rather than as more SQL so each is a sum of the SAME values the artifact
    reports beside it. A separate `count(*)` could legitimately return a different number from
    the measures it sits next to -- a slightly different join, a filter that drifted -- and
    nothing would notice, which is the failure mode this whole module exists to remove.

    `+ 5` is /watch and its four presets: entity pages that appear in the sitemap but have no OG
    card, and therefore the one asymmetry between the two totals.

    Nothing else belongs here. `route_order_agreeing_pairs` was derived this way and had to be
    moved back into SQL: computing it as `sitemap_routes - disagreeing` made the identity that
    checks the pair vacuous, and reversing the comparison in the disagreeing measure left every
    test green. If a value can be measured, measure it -- a derived value cannot cross-check
    the thing it was derived from.
    """
    entity = sum(
        measures[k]
        for k in ("sitemap_routes", "sitemap_airports", "sitemap_carriers", "sitemap_aircraft")
    )
    measures["sitemap_entity_urls"] = entity
    measures["sitemap_urls_total"] = entity + 5
    measures["sitemap_route_and_airport_urls"] = (
        measures["sitemap_routes"] + measures["sitemap_airports"]
    )


def collect(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Run every measure and return a JSON-ready dict."""
    measures: dict[str, Any] = {}
    for name, statement in all_measures_sql().items():
        cur = con.execute(statement)
        rows = cur.fetchall()
        if name in _SCALAR:
            if len(rows) != 1 or len(rows[0]) != 1:
                raise ValueError(f"{name}: declared scalar but returned {len(rows)} rows")
            measures[name] = rows[0][0]
        else:
            columns = [d[0] for d in cur.description]
            measures[name] = [dict(zip(columns, row, strict=True)) for row in rows]

    # Derived from aircraft_short_names rather than measured separately: the separator
    # distribution is what the /aircraft slug transform depends on, and it moved on the
    # 2026-08-07 refresh (36/65/10 -> 37/64/10) purely because of a rename.
    counts: dict[str, int] = {}
    for row in measures["aircraft_short_names"]:
        n = sum(row["short_name"].count(c) for c in ("/", " "))
        counts[str(n)] = counts.get(str(n), 0) + 1
    measures["aircraft_slug_separators"] = dict(sorted(counts.items()))
    _derive(measures)
    return {"measures": measures}


def write_stats(db_path: Path = DB_PATH, out: Path = STATS_PATH) -> None:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        payload = collect(con)
    finally:
        con.close()
    payload["_generated"] = (
        "GENERATED by `make stats` from sql/03_queries/stats_reference.sql and "
        "stats_counts.sql. Do not hand-edit. "
        "A diff here means the upstream BTS dataset moved -- read it, then re-pin whatever "
        "depended on the old value in the SAME commit."
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def main(argv: list[str] | None = None) -> int:
    """`make stats`."""
    import argparse

    parser = argparse.ArgumentParser(description="Regenerate the reference-values artifact.")
    parser.add_argument("--write", action="store_true", help=f"Regenerate {STATS_PATH}")
    args = parser.parse_args(argv)
    if not args.write:
        parser.error("nothing to do -- pass --write")
    write_stats()
    print(f"wrote {STATS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
