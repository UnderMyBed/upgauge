import { readFileSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { renderPivot } from "@/lib/pivot/render";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import { resolveRows, type Resolved } from "@/lib/resolve";

// Same anchor, same reason, as render.ts's QUERIES_DIR: process.cwd() is correct in
// production (docs/architecture/hosting.md's WORKDIR contract), but Vitest needs the
// override because `npm --prefix app test` starts Node already inside app/ rather than
// chdir-ing there from the repo root -- see render.ts's header comment for the full story.
// __dirname is NOT usable here for the same reason it isn't there: Turbopack inlines this
// module into a chunk under .next/server/ in production, where __dirname resolves to "/".
//
// Env-var contract: UPGAUGE_ROOT and UPGAUGE_DB, documented in
// docs/architecture/hosting.md alongside the rest of the deploy's env vars.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();

const DB_PATH = process.env.UPGAUGE_DB ?? path.join(ROOT, "upgauge.duckdb");
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

// This product never writes -- opened READ_ONLY always, no exceptions.
//
// docs/architecture/hosting.md, "Portability test": the catalog is views over paths
// RELATIVE to the repo root, e.g. read_parquet('data/parquet/t100_segment/**/*.parquet').
// That resolution happens inside DuckDB's C layer against a search path, and by default
// that search path IS the process's actual OS working directory -- not anything JS-level,
// and NOT relative to the .duckdb file's own location. An absolute DB_PATH alone does not
// fix a wrong cwd: opening upgauge.duckdb by absolute path from app/ still leaves every
// view's relative glob resolved against app/, and every query against a Parquet-backed view
// fails with `IO Error: No files found that match the pattern "data/parquet/..."` (confirmed
// by running exactly that repro while building this file). `process.chdir()` was tried and
// rejected: it is dead code whenever production's contract (UPGAUGE_ROOT unset) holds, it
// would silently repoint the whole Next server process's relative-path resolution the moment
// an operator DOES set UPGAUGE_ROOT, and it throws ERR_WORKER_UNSUPPORTED_OPERATION inside a
// Node worker thread -- latent today (Next 16 defaults experimental.workerThreads: false)
// but a module-load crash waiting for that flag to flip. `file_search_path` is DuckDB's own,
// additive answer to the same problem -- createConfig() forwards any option name straight to
// duckdb_set_config, so this is a config value, not a SQL string, and it does not touch
// process.cwd() at all: confirmed empirically (see task-7-report.md) that a query against a
// Parquet-backed view succeeds with cwd left at app/ once file_search_path: ROOT is set.
// Vitest gets a belt-and-braces process.chdir() of its own in vitest.config.ts's
// setupFiles -- safe there only because Vitest 4's default pool is forks (main thread).

// The memo lives on `globalThis`, NOT in a module-level `let`, and that is not a style
// choice -- a module-level `let` here was measurably THREE memos, not one.
//
// Turbopack emits this module into a separate server chunk per entry graph, and each chunk
// carries its own copy of the module's state. Measured against `next build` output at
// 6a6b11c: `access_mode` (a string that occurs only in this function) appears in three
// emitted chunks -- `chunks/[root-of-the-server]__*.js` (the proxy, loaded by
// `.next/server/middleware.js`), `chunks/ssr/src_lib_*.js` (page SSR) and
// `chunks/node_modules_next_dist_esm_build_templates_app-route_*.js` (route handlers). All
// three run in ONE `next start` process (verified: one `next-server` pid), and open fds on
// `upgauge.duckdb` in that pid climbed 1 -> 2 -> 3 as `/`, then `/route/JFK-LAX`, then
// `/api/pivot` were each hit for the first time. Three DuckDBInstances, three buffer pools
// each defaulting to ~80% of system RAM, on an 8 GB box.
//
// Worse than the memory: they are opened at three DIFFERENT moments, so they can hold three
// different snapshots of the file. `proxy.ts` decides `/route/<pair>` cacheability from ITS
// instance and the page 404s from the SSR one; if the database were replaced between those
// two opens, a pair present in the proxy's snapshot and absent from the page's would get
// `public, s-maxage=2592000` on a 404 -- exactly the bug fix wave 2 removed
// (docs/architecture/hosting.md § Cache-Control lives here).
//
// `globalThis` is shared across the three chunks because they are plain `require`s in one
// Node process, not vm contexts -- which is a claim, so it is measured: with this slot the
// same fd count stays at 1 after all three entry points are hit, and `app/smoke.sh` asserts
// that against a served build. If a future Next ever DOES isolate the proxy into its own
// realm or process, this degrades to precisely today's behaviour (one memo per realm) rather
// than breaking; the smoke check is what would tell us.
interface InstanceSlot {
  __upgaugeDuckDBInstance?: Promise<DuckDBInstance> | null;
}
const slot = globalThis as unknown as InstanceSlot;

function getInstance(): Promise<DuckDBInstance> {
  const existing = slot.__upgaugeDuckDBInstance;
  if (existing) return existing;
  const created = DuckDBInstance.create(DB_PATH, {
    access_mode: "READ_ONLY",
    file_search_path: ROOT,
  }).catch((e: unknown) => {
    // Memoizing a REJECTED promise would replay a transient open failure (volume not yet
    // mounted, mid-rebuild EIO) for the rest of the process's life on an always-on box that
    // otherwise has no restart trigger. Clear it so the next call retries from scratch --
    // but only if nothing has replaced it since, or a concurrent successful open would be
    // discarded by a straggler rejection.
    if (slot.__upgaugeDuckDBInstance === created) slot.__upgaugeDuckDBInstance = null;
    throw e;
  });
  slot.__upgaugeDuckDBInstance = created;
  return created;
}

/** A fresh connection per operation, matching @duckdb/node-api's own documented lifecycle:
 * per its README, "Connections will be disconnected automatically soon after their
 * reference is dropped" via the native binding's own finalizer -- there is no explicit
 * `.close()` this layer is responsible for calling, and nothing here holds a connection
 * across requests for a leak to accumulate into. The DuckDBInstance itself IS memoized
 * (above): re-opening the database file per call, rather than per process, is what the
 * instance cache exists to avoid.
 *
 * Exported (only) so db.test.ts can pin the read-only invariant -- that this specific
 * connection setup rejects a write -- without db.ts growing a route-handler-facing "give me
 * a raw connection" API. loadAllowlist/dataAsOf/runPivot remain the surface Task 8 uses. */
export async function connect(): Promise<DuckDBConnection> {
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
 * the app. Safe at this dataset's scale -- current values are nowhere near
 * Number.MAX_SAFE_INTEGER (2^53) -- but this function is deliberately generic (any future
 * BIGINT/HUGEINT-typed column goes through it too), so the scale argument isn't a proof.
 * Throw instead of silently losing precision above the safe-integer bound. Exported for a
 * direct unit test of the overflow guard -- runPivot() only ever hits it through real query
 * results, which don't reach 2^53 at this dataset's scale, so the guard itself needs a
 * synthetic row to exercise. */
export function demoteBigInts(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error(
          `column '${key}' value ${value} exceeds Number.MAX_SAFE_INTEGER; ` +
            "downcasting bigint -> number would silently lose precision",
        );
      }
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Read fresh on every call, never cached at the module level: avoids an in-process cache
 * disagreeing with what `getInstance()` currently has open. This does NOT make a rebuilt
 * `upgauge.duckdb` visible mid-process -- `getInstance()`'s DuckDBInstance is memoized, so a
 * rebuild that replaces the file (unlink + create) leaves this process holding the old inode
 * and every fresh read (allowlist or otherwise) keeps returning data from it. Picking up a
 * replaced database requires a process restart, which this project's container-rebake
 * deploy model provides on every release. */
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
          filterOnly: Boolean(r.filter_only),
          filterMode: (r.filter_mode as "pair" | "either" | null) ?? null,
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
 * it could disagree with what is served, and the lag is the product's credibility.
 *
 * **DO NOT MEMOIZE THIS.** It is also `/api/health`'s only Parquet-touching probe -- the other
 * one, `catalogGaps()`, answers out of `duckdb_columns()` and never opens a Parquet file -- so
 * this query failing is the ONLY thing that makes a container with an unmounted or shadowed
 * `data/parquet/` report degraded (`lib/health.ts`; `make portability` negative 1 measures it).
 * Caching the result is the obvious optimisation, since every page renders `DATA AS OF` from it,
 * and it would silently blind the healthcheck to that entire class of break: the memo would keep
 * answering with the stamp read before the volume went away. Neither `make check` nor
 * `make app-check` can see it -- `make portability` is the only gate that would go red. */
export async function dataAsOf(): Promise<string> {
  const con = await connect();
  const rows = await (await con.run(sql("data_as_of"))).getRowObjects();
  // `max(year_month)` over an empty fct_segment_month returns one NULL row, not zero rows,
  // so `rows[0]` always exists -- the failure mode is `data_as_of` being null. Fail loudly
  // and specifically: this is the freshness stamp the project explicitly wants a silent
  // failure to never hide behind (CLAUDE.md: "the cron must fail loudly").
  const value = rows[0]?.data_as_of;
  if (value === null || value === undefined) {
    throw new Error(
      "dataAsOf(): fct_segment_month has no rows -- max(year_month) is NULL, so the " +
        "freshness stamp cannot be computed. Is upgauge.duckdb built from an empty dataset?",
    );
  }
  return String(value);
}

/** One row per required (object, column) pair that the catalog does NOT have.
 *
 * `object_columns` is that object's total column count, so 0 means the object itself is absent
 * -- health.ts collapses an all-columns-missing object to the object's own name rather than
 * listing every column of something that does not exist.
 *
 * Deliberately NOT memoized, unlike proxy.ts's isDataLayerHealthy(): that answers a
 * cacheability question cheaply and per-build, this answers "is the data layer serving right
 * now". A healthcheck that caches its answer reports healthy after the data layer breaks. */
export interface CatalogGap {
  object: string;
  column: string;
  objectColumns: number;
}

export async function catalogGaps(): Promise<CatalogGap[]> {
  const con = await connect();
  const rows = await (await con.run(sql("health_catalog"))).getRowObjects();
  return rows.map((r) => ({
    object: String(r.object_name),
    column: String(r.column_name),
    objectColumns: Number(r.object_columns),
  }));
}

export interface PivotResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Quarantined rows within the returned page only -- rows past `LIMIT $limit` are not
   * counted, so this under-reports whenever the result is truncated. A query-scope total
   * would need its own aggregate query (no LIMIT); this layer does not run one. */
  quarantinedRowsOnPage: number;
  /** Display values for the ids on these rows, keyed by resolutionKey(). Additive and
   * display-only: `rows` still carry ids, and sorting, filtering and the permalink all
   * continue to use them. An absent key means unresolved -- render the raw id, never a
   * dash (lib/format.ts: "Null is absence, zero is a measurement"). */
  resolved: Map<string, Resolved>;
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
  const resolved = await resolveRows(converted, allowlist);
  return {
    columns: result.columnNames(),
    rows: converted,
    quarantinedRowsOnPage: converted.reduce((a, r) => a + Number(r.quarantined_rows ?? 0), 0),
    resolved,
  };
}
