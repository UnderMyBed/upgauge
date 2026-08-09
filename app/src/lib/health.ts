import { catalogGaps, dataAsOf, type CatalogGap } from "@/lib/db";

export type { CatalogGap };
export type GapProbe = () => Promise<CatalogGap[]>;
export type AsOfFn = () => Promise<string>;

export interface HealthReport {
  status: "ok" | "degraded";
  build: { sha: string; warehouse: string };
  /** `error` is the `asOf` probe's own message, present only when that probe threw. The catalog
   * probe's message goes in `missing` instead (`make portability` negative 3 is its fixture);
   * these are two different breaks at two different layers and the report keeps them apart. */
  data: { asOf: string | null; missing: string[]; error?: string };
}

/** Baked from build args in the Dockerfile's runtime stage; `dev` under a local `next start`,
 * which is what keeps host-mode smoke and the unit tests working unchanged. Read per call, not
 * at module load, so a test can set them without re-importing the module. */
function identity(): HealthReport["build"] {
  return {
    sha: process.env.UPGAUGE_BUILD_SHA ?? "dev",
    warehouse: process.env.UPGAUGE_WAREHOUSE_TAG ?? "dev",
  };
}

/** Collapse gaps to names: a wholly-absent object appears once, by itself; a present object
 * missing a column appears as `object.column`. */
function names(gaps: CatalogGap[]): string[] {
  const absent = new Set<string>();
  const columns: string[] = [];
  for (const g of gaps) {
    if (g.objectColumns === 0) absent.add(g.object);
    else columns.push(`${g.object}.${g.column}`);
  }
  return [...absent, ...columns];
}

/** A thrown value's message, whatever it was thrown as. `(e as Error).message` reports
 * `undefined` for a non-Error rejection -- a cast is not a check, and the string it produces
 * ("catalog probe failed: undefined") is the no-named-cause failure this file exists to avoid. */
function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Never throws. A broken data layer is a 503 with a named cause, not a rendered 500 -- a 500
 * tells a load balancer nothing the TCP connect did not already, which is the distinction this
 * endpoint exists to draw. That includes DuckDBInstance.create() rejecting outright on a
 * missing or invalid database file, which happens before any query runs.
 *
 * "Named cause" is the whole contract, so EVERY degraded path names one: the catalog probe's in
 * `missing`, the freshness probe's in `error`. A degraded report with neither is a 503 an operator
 * has to leave the endpoint to diagnose. */
export async function healthReport(
  probe: GapProbe = catalogGaps,
  asOf: AsOfFn = dataAsOf,
): Promise<HealthReport> {
  const build = identity();
  let missing: string[];
  try {
    missing = names(await probe());
  } catch (e) {
    return {
      status: "degraded",
      build,
      data: { asOf: null, missing: [`catalog probe failed: ${message(e)}`] },
    };
  }
  let stamp: string | null = null;
  let asOfError: string | undefined;
  try {
    stamp = await asOf();
  } catch (e) {
    // dataAsOf() throws when max(year_month) is NULL, and -- the case that matters in production
    // -- when reading fct_segment_month raises at all, because it is the only Parquet-touching
    // probe this endpoint makes (db.ts's dataAsOf(), lib/db.ts). So this branch is where the most
    // likely container break lands: the data volume is not mounted, the catalog is intact,
    // missing[] is empty, and `asOf: null` alone says degraded. A bare `catch {}` here made the
    // report state THAT there was a failure without naming ONE, which sent the operator to the
    // container logs for the message the endpoint had in hand. Measured on `make portability`
    // negative 1: `IO Error: No files found that match the pattern
    // "data/parquet/t100_segment/**/*.parquet"`, now carried verbatim.
    asOfError = message(e);
  }
  // `stamp !== null` is NOT redundant with the missing[] check, and no unit test can show that.
  // Shadow data/parquet under a correct WORKDIR and the catalog is fully intact -- missing[] is
  // empty -- while every query fails. Mutant, measured: drop this clause and /api/health returns
  // 200 "ok" while /explore returns 500, i.e. Docker's HEALTHCHECK and any load balancer keep
  // sending traffic to a container that cannot answer anything. Only `make portability` negative 1
  // catches it (docs/architecture/hosting.md § "The test itself"); `make check` and `make
  // app-check` both stay green.
  return {
    status: missing.length === 0 && stamp !== null ? "ok" : "degraded",
    build,
    // Spread, not `error: asOfError`: an explicit `error: undefined` key serialises away in
    // Response.json() but is NOT absent to a structural comparison, so a healthy report would
    // stop being deep-equal to `{ asOf, missing }` in the tests that pin its exact shape.
    data: { asOf: stamp, missing, ...(asOfError !== undefined ? { error: asOfError } : {}) },
  };
}
