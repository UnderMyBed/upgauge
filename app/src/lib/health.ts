import { catalogGaps, dataAsOf, type CatalogGap } from "@/lib/db";

export type { CatalogGap };
export type GapProbe = () => Promise<CatalogGap[]>;
export type AsOfFn = () => Promise<string>;

export interface HealthReport {
  status: "ok" | "degraded";
  build: { sha: string; warehouse: string };
  data: { asOf: string | null; missing: string[] };
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

/** Never throws. A broken data layer is a 503 with a named cause, not a rendered 500 -- a 500
 * tells a load balancer nothing the TCP connect did not already, which is the distinction this
 * endpoint exists to draw. That includes DuckDBInstance.create() rejecting outright on a
 * missing or invalid database file, which happens before any query runs. */
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
      data: { asOf: null, missing: [`catalog probe failed: ${(e as Error).message}`] },
    };
  }
  let stamp: string | null = null;
  try {
    stamp = await asOf();
  } catch {
    // dataAsOf() throws when max(year_month) is NULL. The catalog can be intact and the data
    // still absent -- an empty build. Degraded, and the null is the report.
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
    data: { asOf: stamp, missing },
  };
}
