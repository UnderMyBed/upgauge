import { describe, expect, it } from "vitest";
import { connect, dataAsOf, demoteBigInts, loadAllowlist, runPivot } from "@/lib/db";

describe("the query layer runs against the real database", () => {
  it("loads the allowlist from the catalog views", async () => {
    const a = await loadAllowlist();
    expect(a.dims.get("op_airline_id")?.columnExpr).toBe("op_airline_id");
    expect(a.dims.get("route")?.columnExpr).toBe("route_key_low, route_key_high");
    expect(a.meas.get("load_factor")?.expr).toContain("NULLIF");
    expect(a.meas.get("load_factor")?.expr).not.toContain("AVG(");
  });

  it("does not memoize the allowlist across calls: each call re-reads the catalog", async () => {
    // A module-level cache here would let a stale allowlist survive a database rebuilt
    // mid-process. This can't observe the rebuild itself (that needs a second database, out
    // of scope for this layer), but it does pin that loadAllowlist() has no cache to defeat:
    // two calls must return two independently-constructed Maps, not the same object twice.
    const a1 = await loadAllowlist();
    const a2 = await loadAllowlist();
    expect(a1.dims).not.toBe(a2.dims);
    expect(a1.meas).not.toBe(a2.meas);
    expect(a1.dims.get("route")).toEqual(a2.dims.get("route"));
  });

  it("is genuinely read-only: DuckDB itself rejects a write on this connection", async () => {
    const con = await connect();
    await expect(
      con.run("CREATE TABLE db_test_should_never_be_created (i INTEGER)"),
    ).rejects.toThrow();
  });

  it("executes a pivot and returns rows", async () => {
    const r = await runPivot({
      grain: "segment",
      dimensions: ["op_airline_id"],
      measures: ["seats"],
      timeFrom: "2025-05",
      timeTo: "2026-04",
      filters: [],
      sort: "seats",
      sortDesc: true,
      limit: 5,
      grouping: "operating",
    });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(5);
    expect(r.columns).toContain("seats");
    expect(typeof r.quarantinedRowsOnPage).toBe("number");
  });

  it("returns JSON-serializable rows: no bigint reaches the caller", async () => {
    // quarantined_rows is BIGINT/HUGEINT at the SQL layer (COUNT at segment grain, SUM of a
    // BIGINT column at route grain) and comes back from the driver as JS `bigint`, which
    // JSON.stringify throws on. This is the exact landmine Task 8's Response.json() would
    // hit if runPivot did not downcast it.
    const r = await runPivot({
      grain: "route",
      dimensions: ["op_airline_id"],
      measures: ["seats"],
      timeFrom: "2025-05",
      timeTo: "2026-04",
      filters: [],
      sort: "seats",
      sortDesc: true,
      limit: 5,
      grouping: "operating",
    });
    expect(r.rows.length).toBeGreaterThan(0); // otherwise the loop below passes vacuously
    for (const row of r.rows) {
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe("bigint");
      }
    }
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("reads the freshness stamp", async () => {
    const asOf = await dataAsOf();
    expect(asOf).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("demoteBigInts", () => {
  it("downcasts an in-range bigint to number and leaves other values alone", () => {
    const out = demoteBigInts({ a: BigInt(5), b: "x", c: 1.5, d: null });
    expect(out).toEqual({ a: 5, b: "x", c: 1.5, d: null });
  });

  it("throws instead of silently losing precision above Number.MAX_SAFE_INTEGER", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    expect(() => demoteBigInts({ quarantined_rows: tooBig })).toThrow(/MAX_SAFE_INTEGER/);
  });
});
