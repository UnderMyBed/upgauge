import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { catalogGaps } from "@/lib/db";
import { healthReport, type CatalogGap } from "@/lib/health";

const QUERIES = path.resolve(__dirname, "../../../sql/03_queries");

/** Objects a .sql file reads, with comments stripped and CTE names removed.
 *
 * Comment stripping is not cosmetic: a naive FROM/JOIN scan over these files returns prose
 * ("...aggregates FROM the segment grain..."), because every query here carries a long
 * comment header. CTE subtraction matters for the same reason -- `WITH derived AS (...)`
 * followed by `FROM derived` is not a catalog object.
 *
 * This is NOT a SQL parser, and does not try to be -- it understands exactly the constructs
 * `sql/03_queries/*.sql` uses today: a bare or double-quoted, optionally aliased identifier
 * after FROM/JOIN, and `WITH [RECURSIVE] name AS (` for CTEs (including double-quoted CTE
 * names and the comma-joined multi-CTE form). Anything this function does NOT reason about --
 * a schema-qualified reference (`FROM main.dim_airport`) or what reads like a table function
 * call (`FROM read_parquet(...)`) -- throws instead of silently under-matching, naming the
 * file and the construct: a drift test that goes quiet on a construct it cannot classify is
 * exactly the failure class it exists to prevent (a real object reference vanishing from
 * `referencedObjects()`'s output is indistinguishable from that object simply not being
 * referenced). `file` is caller-supplied purely for that error message. */
function referencedObjects(sqlText: string, file: string): Set<string> {
  const bare = sqlText.replace(/--[^\n]*/g, "");

  const ctes = new Set<string>();
  for (const m of bare.matchAll(
    /(?:WITH(?:\s+RECURSIVE)?|,)\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s+AS\s*\(/gi,
  )) {
    ctes.add((m[1] ?? m[2]).toLowerCase());
  }

  const refs = new Set<string>();
  for (const m of bare.matchAll(/\b(?:FROM|JOIN)\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))/gi)) {
    const name = (m[1] ?? m[2]).toLowerCase();
    const rest = bare.slice(m.index + m[0].length);
    if (/^\s*\./.test(rest)) {
      throw new Error(
        `${file}: drift parser cannot vouch for this file -- "${m[0].trim()}." is a ` +
          "schema-qualified reference after FROM/JOIN, which referencedObjects() does not " +
          "understand. Extend the parser (or the manifest, if it's a new catalog object) " +
          "before trusting this file's drift check.",
      );
    }
    if (/^\s*\(/.test(rest)) {
      throw new Error(
        `${file}: drift parser cannot vouch for this file -- "${m[0].trim()}(" after ` +
          "FROM/JOIN reads like a table function call, not a plain relation reference, " +
          "which referencedObjects() does not understand. Extend the parser before " +
          "trusting this file's drift check.",
      );
    }
    if (!ctes.has(name)) refs.add(name);
  }
  return refs;
}

function manifestObjects(): Set<string> {
  const text = readFileSync(path.join(QUERIES, "health_catalog.sql"), "utf8");
  const block = text.slice(text.indexOf("VALUES"), text.indexOf("FROM required"));
  const objs = new Set<string>();
  for (const m of block.matchAll(/\(\s*'([a-z_][a-z0-9_]*)'\s*,/g)) objs.add(m[1]);
  return objs;
}

describe("the health manifest cannot fall behind the served queries", () => {
  it("parses a non-empty manifest", () => {
    // Anti-vacuity: a broken slice would make the drift test below pass by comparing nothing.
    const objs = manifestObjects();
    expect(objs.size).toBeGreaterThanOrEqual(10);
    expect(objs.has("dim_airport")).toBe(true);
    expect(objs.has("mart_route_health")).toBe(true);
  });

  it("declares every object the served queries read", () => {
    const manifest = manifestObjects();
    const missing: string[] = [];
    const files = readdirSync(QUERIES).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(20); // anti-vacuity: the glob still finds the corpus
    for (const file of files) {
      if (file === "health_catalog.sql") continue;
      const text = readFileSync(path.join(QUERIES, file), "utf8");
      for (const obj of referencedObjects(text, file)) {
        if (!manifest.has(obj)) missing.push(`${file} reads ${obj}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("referencedObjects handles the constructs the corpus uses, and refuses the rest", () => {
  it("recognizes a double-quoted identifier after FROM/JOIN", () => {
    expect(referencedObjects('SELECT * FROM "dim_airport" a', "fixture.sql")).toEqual(
      new Set(["dim_airport"]),
    );
  });

  it("excludes a double-quoted CTE name from the reference set", () => {
    const sql = 'WITH "recent" AS (SELECT 1) SELECT * FROM "recent" JOIN dim_airport a ON true';
    expect(referencedObjects(sql, "fixture.sql")).toEqual(new Set(["dim_airport"]));
  });

  it("excludes a WITH RECURSIVE CTE name from the reference set", () => {
    const sql = "WITH RECURSIVE ladder AS (SELECT 1) SELECT * FROM ladder JOIN dim_airport a ON true";
    expect(referencedObjects(sql, "fixture.sql")).toEqual(new Set(["dim_airport"]));
  });

  it("refuses to vouch for a schema-qualified reference, naming the file and the construct", () => {
    expect(() => referencedObjects("SELECT * FROM main.dim_airport", "fixture.sql")).toThrow(
      /fixture\.sql.*cannot vouch.*schema-qualified/,
    );
  });

  it("refuses to vouch for what reads like a table function call", () => {
    expect(() => referencedObjects("SELECT * FROM read_parquet('x.parquet')", "fixture.sql")).toThrow(
      /fixture\.sql.*cannot vouch.*table function call/,
    );
  });
});

describe("healthReport shapes gaps into a report", () => {
  const build = { sha: "abc1234", warehouse: "warehouse-2026.04" };

  it("is ok with no gaps", async () => {
    const r = await healthReport(async () => [], async () => "2026-04");
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ asOf: "2026-04", missing: [] });
  });

  it("names a missing OBJECT without its columns", async () => {
    const gaps: CatalogGap[] = [
      { object: "mart_route_health", column: "op_airline_id", objectColumns: 0 },
      { object: "mart_route_health", column: "health_score", objectColumns: 0 },
    ];
    const r = await healthReport(async () => gaps, async () => "2026-04");
    expect(r.status).toBe("degraded");
    // Asserted as the exact list, not `toContain`: the object must appear ONCE, collapsed.
    // `toContain` would pass on ["mart_route_health", "mart_route_health.health_score"].
    expect(r.data.missing).toEqual(["mart_route_health"]);
  });

  it("names a missing COLUMN on a present object", async () => {
    const gaps: CatalogGap[] = [
      { object: "dim_airport", column: "lat", objectColumns: 13 },
      { object: "dim_airport", column: "lon", objectColumns: 13 },
    ];
    const r = await healthReport(async () => gaps, async () => "2026-04");
    expect(r.status).toBe("degraded");
    expect(r.data.missing).toEqual(["dim_airport.lat", "dim_airport.lon"]);
  });

  it("is degraded, not thrown, when the probe itself fails", async () => {
    const r = await healthReport(
      async () => { throw new Error("IO Error: No files found"); },
      async () => "2026-04",
    );
    expect(r.status).toBe("degraded");
    expect(r.data.missing.join(" ")).toContain("IO Error");
  });

  it("is degraded when asOf fails but the catalog is intact", async () => {
    const r = await healthReport(async () => [], async () => { throw new Error("empty"); });
    expect(r.status).toBe("degraded");
    expect(r.data.asOf).toBeNull();
  });

  it("re-probes on every call and never memoizes", async () => {
    // The bug: a globalThis memo (correct for isDataLayerHealthy, wrong here) would make the
    // second call report the first call's answer, so a healthcheck keeps saying ok after the
    // data layer breaks. Two calls, two different probe results.
    let call = 0;
    const probe = async (): Promise<CatalogGap[]> =>
      ++call === 1 ? [] : [{ object: "mart_route_health", column: "op_airline_id", objectColumns: 0 }];
    expect((await healthReport(probe, async () => "2026-04")).status).toBe("ok");
    expect((await healthReport(probe, async () => "2026-04")).status).toBe("degraded");
    expect(call).toBe(2);
  });

  it("reports the baked identity, and dev when the build args are unset", async () => {
    // Set and cleared explicitly rather than relying on the ambient environment: an assertion
    // that only holds because the runner happens not to export these proves nothing about
    // health.ts, and would flip to green-for-the-wrong-reason inside the container.
    delete process.env.UPGAUGE_BUILD_SHA;
    delete process.env.UPGAUGE_WAREHOUSE_TAG;
    let r = await healthReport(async () => [], async () => "2026-04");
    expect(r.build).toEqual({ sha: "dev", warehouse: "dev" });

    process.env.UPGAUGE_BUILD_SHA = build.sha;
    process.env.UPGAUGE_WAREHOUSE_TAG = build.warehouse;
    r = await healthReport(async () => [], async () => "2026-04");
    expect(r.build).toEqual(build);
    delete process.env.UPGAUGE_BUILD_SHA;
    delete process.env.UPGAUGE_WAREHOUSE_TAG;
  });
});

describe("catalogGaps runs against the real database", () => {
  it("finds no gaps in a correctly built warehouse", async () => {
    expect(await catalogGaps()).toEqual([]);
  });
});
