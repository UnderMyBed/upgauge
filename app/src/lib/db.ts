import { readFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { renderPivot } from "@/lib/pivot/render";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";

// Same anchor, same reason, as render.ts's QUERIES_DIR: process.cwd() is correct in
// production (docs/architecture/hosting.md's WORKDIR contract), but Vitest needs the
// override because `npm --prefix app test` starts Node already inside app/ rather than
// chdir-ing there from the repo root -- see render.ts's header comment for the full story.
// __dirname is NOT usable here for the same reason it isn't there: Turbopack inlines this
// module into a chunk under .next/server/ in production, where __dirname resolves to "/".
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();

// docs/architecture/hosting.md, "Portability test": the catalog is views over paths
// RELATIVE to the repo root, e.g. read_parquet('data/parquet/t100_segment/**/*.parquet').
// That resolution happens inside DuckDB's C layer against the process's actual OS working
// directory -- not anything JS-level, and NOT relative to the .duckdb file's own location.
// So an absolute DB_PATH alone does not fix a wrong cwd: opening upgauge.duckdb by absolute
// path from app/ still leaves every view's relative glob resolved against app/, and every
// query against a Parquet-backed view fails with `IO Error: No files found that match the
// pattern "data/parquet/...`" (confirmed by running exactly that repro while building this
// file). Production's cwd is already the repo root, so this is a no-op there; under Vitest
// it corrects the one process-wide fact DuckDB actually depends on, done once here at the
// single place the instance is opened, rather than pushed onto every caller.
if (process.cwd() !== ROOT) process.chdir(ROOT);

const DB_PATH = process.env.UPGAUGE_DB ?? path.join(ROOT, "upgauge.duckdb");
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

// This product never writes -- opened READ_ONLY always, no exceptions.
let instance: Promise<DuckDBInstance> | null = null;
function getInstance(): Promise<DuckDBInstance> {
  instance ??= DuckDBInstance.create(DB_PATH, { access_mode: "READ_ONLY" });
  return instance;
}

/** A fresh connection per operation, matching @duckdb/node-api's own documented lifecycle:
 * per its README, "Connections will be disconnected automatically soon after their
 * reference is dropped" via the native binding's own finalizer -- there is no explicit
 * `.close()` this layer is responsible for calling, and nothing here holds a connection
 * across requests for a leak to accumulate into. The DuckDBInstance itself IS memoized
 * (above): re-opening the database file per call, rather than per process, is what the
 * instance cache exists to avoid. */
async function connect(): Promise<DuckDBConnection> {
  return (await getInstance()).connect();
}

/** Every statement comes from a file -- the same files pipeline/pivot.py reads. No SQL in
 * a TS string literal, not even a one-line catalog read. */
function sql(name: string): string {
  return readFileSync(path.join(QUERIES_DIR, `${name}.sql`), "utf8");
}

/** DuckDB returns BIGINT/HUGEINT values (COUNT results, and SUM of a BIGINT column such as
 * fct_route_month.quarantined_rows) as JS `bigint`, never `number` -- confirmed by running
 * the real pivot templates against upgauge.duckdb while building this file:
 * `count(*) FILTER (WHERE is_quarantined)` (segment grain) and `sum(quarantined_rows)`
 * (route grain) both typed BIGINT/HUGEINT and came back as `bigint`. `seats`,
 * `departures_performed`, and `load_factor` did NOT: the fact tables store seats and
 * departures_performed as DOUBLE (not INTEGER) at rest, so their sums -- and every derived
 * ratio, which is already DOUBLE by construction -- come back as ordinary JS `number`.
 * `JSON.stringify` throws on `bigint`, which would break Task 8's `Response.json()`, so
 * every bigint is downcast to `number` here, the one place raw driver rows meet the rest of
 * the app. Safe at this dataset's scale: nowhere near Number.MAX_SAFE_INTEGER (2^53). */
function demoteBigInts(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out;
}

/** Read fresh on every call, never cached: a module-level cache would let a stale allowlist
 * survive a database rebuilt mid-process -- exactly what `make verify` does. */
export async function loadAllowlist(): Promise<Allowlist> {
  const con = await connect();
  const dimRows = await (await con.run(sql("catalog_dimensions"))).getRowObjects();
  const measRows = await (await con.run(sql("catalog_measures"))).getRowObjects();
  return {
    dims: new Map(
      dimRows.map((r) => [
        String(r.key),
        {
          key: String(r.key),
          label: String(r.label),
          columnExpr: String(r.column_expr),
          grain: String(r.grain),
          joinDim: r.join_dim === null ? null : String(r.join_dim),
          joinKey: r.join_key === null ? null : String(r.join_key),
        },
      ]),
    ),
    meas: new Map(
      measRows.map((r) => [
        String(r.key),
        {
          key: String(r.key),
          label: String(r.label),
          isAdditive: Boolean(r.is_additive),
          expr: String(r.expr),
        },
      ]),
    ),
  };
}

/** The freshness badge is read from the data, never configured. If it could be set by hand
 * it could disagree with what is served, and the lag is the product's credibility. */
export async function dataAsOf(): Promise<string> {
  const con = await connect();
  const rows = await (await con.run(sql("data_as_of"))).getRowObjects();
  return String(rows[0].data_as_of);
}

export interface PivotResult {
  columns: string[];
  rows: Record<string, unknown>[];
  quarantinedRows: number;
}

export async function runPivot(q: PivotQuery): Promise<PivotResult> {
  const allowlist = await loadAllowlist();
  const { sql: statement, params } = renderPivot(q, allowlist);
  const con = await connect();
  const prepared = await con.prepare(statement);
  // By-name binding via `bind()`, which resolves each key to its parameter index
  // internally (`bindInteger`/`bindVarchar` take a numeric *index*, not a name -- `params`
  // here is keyed by name, e.g. "time_from", "f0_0"). Types are inferred per value
  // (`number` -> INTEGER/DOUBLE, `string` -> VARCHAR), which is exact for this template's
  // params (time_from/time_to/filter values are always strings, limit is always an
  // integer). Never interpolated into the SQL string -- the whole {{TOKEN}}/$param split in
  // renderPivot exists to keep every value on this bound path.
  prepared.bind(params);
  const result = await prepared.run();
  const rows = (await result.getRowObjects()) as Record<string, unknown>[];
  const converted = rows.map(demoteBigInts);
  return {
    columns: result.columnNames(),
    rows: converted,
    quarantinedRows: converted.reduce((a, r) => a + Number(r.quarantined_rows ?? 0), 0),
  };
}
