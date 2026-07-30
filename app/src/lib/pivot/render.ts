import { readFileSync } from "node:fs";
import path from "node:path";
import { PivotError, type PivotQuery } from "@/lib/pivot/types";
import type { Allowlist, DimensionEntry } from "@/lib/pivot/allowlist";

// Resolved relative to this module's own location, NOT process.cwd() -- vitest runs with
// cwd() == app/, where "sql/03_queries" would resolve to app/sql/03_queries (doesn't exist).
// __dirname is app/src/lib/pivot at both test-time and (once Task 7 imports this module from
// a route handler) at server run-time, so walking up four levels always lands on the repo
// root regardless of what invoked the process -- the same resolution render.test.ts's own
// REPO constant uses. process.cwd() is left alone everywhere else: the DuckDB catalog
// (Task 7) depends on cwd() being the directory containing data/, per docs/architecture/hosting.md.
const QUERIES_DIR = path.resolve(__dirname, "../../../../sql/03_queries");
const MAINLINE_CARRIER_EXPR = "coalesce(m.parent_airline_id, f.op_airline_id)";

function validateDimension(key: string, a: Allowlist, grain: string): DimensionEntry {
  const entry = a.dims.get(key);
  if (!entry) throw new PivotError(`unknown dimension '${key}'`);
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

  const dimEntries = q.dimensions.map((k) => validateDimension(k, a, q.grain));
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
    if (columns.length !== 1) {
      throw new PivotError(
        `dimension '${key}' spans multiple columns (${entry.columnExpr}); ` +
          "filter on the underlying columns directly, not the composite dimension",
      );
    }
    const placeholders = values.map((value, j) => {
      const pname = `f${i}_${j}`;
      params[pname] = value;
      return `$${pname}`;
    });
    filterClauses.push(`${columns[0]} IN (${placeholders.join(", ")})`);
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

  let sql = readFileSync(path.join(QUERIES_DIR, `pivot_${q.grain}.sql`), "utf8");
  sql = sql.replace("{{DIM_SELECT}}", dimSelect);
  sql = sql.replace("{{MEASURE_SELECT}}", measureSelect);
  sql = sql.replace("{{GROUP_BY}}", groupBy);
  sql = sql.replace("{{FILTERS}}", filtersSql);
  sql = sql.replace("{{SORT}}", sortSql);
  sql = sql.replace("{{MAINLINE_JOIN}}", mainlineJoin);
  return { sql, params };
}
