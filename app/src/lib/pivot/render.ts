import { readFileSync } from "node:fs";
import path from "node:path";
import { PivotError, type PivotQuery } from "@/lib/pivot/types";
import type { Allowlist, DimensionEntry } from "@/lib/pivot/allowlist";

// process.cwd() is the correct anchor: docs/architecture/hosting.md requires WORKDIR to be
// the directory containing data/ (so the DuckDB catalog's relative Parquet paths resolve),
// which is the repo root -- the same directory that contains sql/. __dirname is NOT usable
// here: Turbopack inlines this module into a chunk under .next/server/ in a production
// build, where __dirname resolves to "/", so a "../../../../sql/03_queries" walk has no
// correct anchor and 404s every request (verified: `next start` throws ENOENT on
// '/sql/03_queries/pivot_segment.sql').
//
// UPGAUGE_ROOT overrides cwd() for Vitest only: vitest chdirs to its own root (app/), not
// the repo root npm was invoked from, so app/vitest.config.ts sets UPGAUGE_ROOT to the repo
// root for the test process. Production never sets it, so it falls through to cwd(), which
// hosting.md already pins correctly.
const QUERIES_DIR = path.join(process.env.UPGAUGE_ROOT ?? process.cwd(), "sql", "03_queries");
const MAINLINE_CARRIER_EXPR = "coalesce(m.parent_airline_id, f.op_airline_id)";

// Minor, final whole-branch review: JS's `String.trim()` and Python's `str.strip()` are NOT
// the same whitespace set -- `trim()` strips U+FEFF (ZWNBSP/BOM, added to the WhiteSpace
// production in ES2015), which Python's `.strip()` does not; `.strip()` strips \x1c-\x1f
// (the Unicode "File/Group/Record/Unit Separator" control codes, category Cc but treated as
// space-adjacent by Python's `str.isspace()`), which JS's `\s`/`trim()` does not. No golden
// exercises either edge, so this was free to silently diverge between the two composite-
// filter-value implementations. An explicit ASCII whitespace set is the only strip both
// languages can express identically -- mirrored in pipeline/pivot.py as `_ASCII_WS`.
const ASCII_WHITESPACE_RE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
function stripAsciiWhitespace(s: string): string {
  return s.replace(ASCII_WHITESPACE_RE, "");
}

function validateDimension(
  key: string,
  a: Allowlist,
  grain: string,
  forGrouping = false,
): DimensionEntry {
  const entry = a.dims.get(key);
  if (!entry) throw new PivotError(`unknown dimension '${key}'`);
  if (forGrouping && entry.filterOnly) {
    throw new PivotError(`dimension '${key}' cannot be grouped by; it is filter-only`);
  }
  if (entry.grain !== "both" && entry.grain !== grain) {
    throw new PivotError(
      `dimension '${key}' is '${entry.grain}'-grain, not offered at '${grain}' grain`,
    );
  }
  return entry;
}

/** `route` is the one dimension spanning two columns. */
function dimensionColumns(e: DimensionEntry): string[] {
  return e.columnExpr.split(",").map((c) => c.trim());
}

/** Returns [selectExpr, groupByExpr, sortableName]. Only op_airline_id under mainline
 * grouping differs: aliased back to its own key so ORDER BY names the same thing in both
 * modes, while GROUP BY uses the raw expression (never an output alias). */
function dimRender(key: string, e: DimensionEntry, grouping: string): [string, string, string] {
  if (grouping === "mainline" && key === "op_airline_id") {
    return [`${MAINLINE_CARRIER_EXPR} AS op_airline_id`, MAINLINE_CARRIER_EXPR, "op_airline_id"];
  }
  return [e.columnExpr, e.columnExpr, e.columnExpr];
}

export function renderPivot(
  q: PivotQuery,
  a: Allowlist,
): { sql: string; params: Record<string, string | number> } {
  if (q.grain !== "segment" && q.grain !== "route") {
    throw new PivotError(`unknown grain '${q.grain}'`);
  }
  if (q.grouping !== "operating" && q.grouping !== "mainline") {
    throw new PivotError(`unknown grouping '${q.grouping}'`);
  }
  if (q.dimensions.length === 0) throw new PivotError("at least one dimension is required");
  if (q.measures.length === 0) throw new PivotError("at least one measure is required");
  if (!Number.isInteger(q.limit) || q.limit <= 0) {
    throw new PivotError(`limit must be a positive integer, got ${q.limit}`);
  }
  for (const [key, values] of q.filters) {
    if (values.length === 0) throw new PivotError(`filter '${key}' has no values`);
  }

  const dimEntries = q.dimensions.map((k) => validateDimension(k, a, q.grain, true));
  const measureEntries = q.measures.map((k) => {
    const e = a.meas.get(k);
    if (!e) throw new PivotError(`unknown measure '${k}'`);
    return e;
  });

  const dimRenders = q.dimensions.map((k, i) => dimRender(k, dimEntries[i], q.grouping));
  const dimSelect = dimRenders.map((r) => r[0]).join(", ");
  const groupBy = dimRenders.map((r) => r[1]).join(", ");
  const measureSelect = q.measures
    .map((k, i) => `${measureEntries[i].expr} AS ${k}`)
    .join(", ");

  const params: Record<string, string | number> = {
    time_from: q.timeFrom,
    time_to: q.timeTo,
    limit: q.limit,
  };

  const filterClauses: string[] = [];
  q.filters.forEach(([key, values], i) => {
    const entry = validateDimension(key, a, q.grain);
    const columns = dimensionColumns(entry);
    if (columns.length === 1) {
      const placeholders = values.map((value, j) => {
        const pname = `f${i}_${j}`;
        params[pname] = value;
        return `$${pname}`;
      });
      filterClauses.push(`${columns[0]} IN (${placeholders.join(", ")})`);
      return;
    }

    // An `either` dimension's two columns are ALTERNATIVES, not a pair: the value list is
    // shared by both sides, so one parameter per value serves both IN-lists. This is what
    // lets ONE pivot express `origin = X OR dest = X` -- the OR /airport used to assemble
    // arithmetically from three pivots (inclusion-exclusion), and which no AND-ed filter can
    // express. Same-airport rows satisfy both sides and are counted ONCE by the OR, which is
    // exactly what the third inclusion-exclusion term existed to achieve.
    //
    // Branch on filterMode, not on column count: `route` also spans two columns but means the
    // OPPOSITE thing (one route pair, least()/greatest() equality) -- if an `either` OR ever
    // swallowed `route`'s filter, same-airport rows would match again and reopen the measured
    // 18,895-seat inflation on JFK-LAX this file's `pair` branch exists to prevent.
    if (entry.filterMode === "either") {
      if (columns.length !== 2) {
        throw new PivotError(
          `dimension '${key}' is 'either'-mode but spans ${columns.length} columns`,
        );
      }
      const placeholders = values.map((value, j) => {
        const pname = `f${i}_${j}`;
        params[pname] = value;
        return `$${pname}`;
      });
      const list = placeholders.join(", ");
      filterClauses.push(`(${columns[0]} IN (${list}) OR ${columns[1]} IN (${list}))`);
      return;
    }

    // A composite dimension names more than one key column -- `route` is
    // (route_key_low, route_key_high). One filter VALUE encodes one whole route as
    // "<low>-<high>", so multiple values stay OR'd exactly like every other dimension's
    // IN-list rather than inventing a positional pair convention that would make "a,b,c"
    // meaningless.
    //
    // least()/greatest() rather than trusting stored column order: the filter must be
    // correct however the fact row was written. Filtering the underlying columns separately
    // -- what this branch used to tell callers to do -- is NOT equivalent and is silently
    // wrong: `origin IN (a,b) AND dest IN (a,b)` also matches a->a and b->b, and 12,738 such
    // (full window 2015-01..2026-04, quarantined included -- matching is what a filter does,
    // and quarantine does not change it; invariants.md § Route identity)
    // same-airport filings exist across 530 airports. On JFK-LAX that inflates seats by
    // 18,895 (docs/data/invariants.md).
    //
    // This must stay byte-identical to pipeline/pivot.py's emission -- the goldens are what
    // prove it, and a divergence here is exactly the two-implementation drift M3a exists to
    // prevent.
    if (columns.length !== 2) {
      throw new PivotError(
        `dimension '${key}' spans ${columns.length} columns; only two are supported`,
      );
    }
    const pairClauses = values.map((value, j) => {
      // ASCII-only strip, not `.trim()`: JS's `trim()` and Python's `.strip()` disagree on
      // which characters count as whitespace (JS strips U+FEFF ZWNBSP; Python's `.strip()`
      // additionally strips \x1c-\x1f). An explicit ASCII whitespace set is the only strip
      // both languages can implement identically -- see stripAsciiWhitespace's own comment.
      const parts = value.split("-").map(stripAsciiWhitespace);
      // Every composite dimension in the catalog today (just `route`) resolves through an
      // INTEGER id column (route_key_low/high -> AIRPORT_ID -- CLAUDE.md's "Key on
      // AIRLINE_ID and AIRPORT_ID" rule), and the error message below has always promised
      // "must be two ids". Requiring digits is enforcing that promise, not duplicating
      // DuckDB's type system (pipeline/pivot.py's module docstring draws that line at
      // value-DOMAIN mismatches, e.g. an id that is well-typed but doesn't exist -- this is
      // a structural format check, cheap and allowlist-adjacent, exactly what render_pivot
      // already rejects elsewhere). Closes a real gap: 'route:JFK-LAX' used to pass this
      // check (two non-empty parts) and only fail deep inside DuckDB with a raw "Conversion
      // Error: Could not convert string 'JFK' to INT32" that neither /explore nor /api/pivot
      // handled (Important 4, final whole-branch review) -- verified against a running
      // build before this fix.
      const isIntegerPair = parts.length === 2 && parts.every((p) => /^\d+$/.test(p));
      if (!isIntegerPair) {
        throw new PivotError(
          `filter value '${value}' for composite dimension '${key}' must be ` +
            "two ids joined by '-', e.g. '12478-12892'",
        );
      }
      const loName = `f${i}_${j}a`;
      const hiName = `f${i}_${j}b`;
      params[loName] = parts[0];
      params[hiName] = parts[1];
      return (
        `(least(${columns[0]}, ${columns[1]}) = $${loName} ` +
        `AND greatest(${columns[0]}, ${columns[1]}) = $${hiName})`
      );
    });
    filterClauses.push(`(${pairClauses.join(" OR ")})`);
  });
  const filtersSql = filterClauses.length ? filterClauses.join(" AND ") : "TRUE";

  const sortable = new Map<string, string>();
  q.dimensions.forEach((k, i) => {
    if (dimensionColumns(dimEntries[i]).length === 1) sortable.set(k, dimRenders[i][2]);
  });
  for (const k of q.measures) sortable.set(k, k);

  // Default points at the first requested measure, so a sort default always names a value
  // column rather than a dimension.
  const sortKey = q.sort ?? q.measures[0];
  const resolved = sortable.get(sortKey);
  if (!resolved) {
    throw new PivotError(
      `unknown sort key '${sortKey}': must be one of the selected dimensions or measures ` +
        `(${[...sortable.keys()].sort().join(", ")})`,
    );
  }
  const sortSql = `${resolved} ${q.sortDesc ? "DESC" : "ASC"}`;

  const mainlineJoin =
    q.grouping === "mainline"
      ? "\n" +
        readFileSync(path.join(QUERIES_DIR, "pivot_mainline_join.sql"), "utf8").replace(/\n+$/, "")
      : "";

  // Each replacement uses the FUNCTION form, not a plain string, even though the search
  // pattern is a string (which only replaces the first occurrence -- correct, since every
  // token appears once). A string REPLACEMENT interprets `$&`, `` $` ``, `$'`, `$$`, `$n`,
  // `$<name>` as substitution patterns; a function replacement disables that interpretation
  // entirely, matching Python's str.replace exactly. No catalog expr contains `$` today, but
  // a future one that does must not silently diverge from the reference implementation in
  // the one place divergence is SQL-injection-shaped.
  let sql = readFileSync(path.join(QUERIES_DIR, `pivot_${q.grain}.sql`), "utf8");
  sql = sql.replace("{{DIM_SELECT}}", () => dimSelect);
  sql = sql.replace("{{MEASURE_SELECT}}", () => measureSelect);
  sql = sql.replace("{{GROUP_BY}}", () => groupBy);
  sql = sql.replace("{{FILTERS}}", () => filtersSql);
  sql = sql.replace("{{SORT}}", () => sortSql);
  sql = sql.replace("{{MAINLINE_JOIN}}", () => mainlineJoin);
  return { sql, params };
}
