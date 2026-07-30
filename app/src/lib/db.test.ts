import { describe, expect, it } from "vitest";
import { loadAllowlist, runPivot } from "@/lib/db";

describe("the query layer runs against the real database", () => {
  it("loads the allowlist from the catalog views", async () => {
    const a = await loadAllowlist();
    expect(a.dims.get("op_airline_id")?.columnExpr).toBe("op_airline_id");
    expect(a.dims.get("route")?.columnExpr).toBe("route_key_low, route_key_high");
    expect(a.meas.get("load_factor")?.expr).toContain("NULLIF");
    expect(a.meas.get("load_factor")?.expr).not.toContain("AVG(");
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
    expect(typeof r.quarantinedRows).toBe("number");
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
    for (const row of r.rows) {
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe("bigint");
      }
    }
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("reads the freshness stamp", async () => {
    const { dataAsOf } = await import("@/lib/db");
    const asOf = await dataAsOf();
    expect(asOf).toMatch(/^\d{4}-\d{2}$/);
  });
});
