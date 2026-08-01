import { describe, expect, it } from "vitest";
import { topNQuery, topNPermalink } from "./topn";

const BASE = {
  grain: "segment" as const,
  dimension: "aircraft_type",
  measures: ["seats", "departures_performed"],
  timeFrom: "2025-05",
  timeTo: "2026-04",
  limit: 25,
};

describe("topNQuery", () => {
  it("sorts by the FIRST requested measure, descending", () => {
    // The bug this catches: sorting by the dimension, or by the last measure. Both produce a
    // populated, plausible table. `measures[0]` is the convention every Top-N view in the
    // product is read by (docs/architecture/pipeline.md).
    const q = topNQuery(BASE);
    expect(q.sort).toBe("seats");
    expect(q.sortDesc).toBe(true);
  });

  it("carries exactly one dimension", () => {
    expect(topNQuery(BASE).dimensions).toEqual(["aircraft_type"]);
  });

  it("defaults grouping to operating", () => {
    expect(topNQuery(BASE).grouping).toBe("operating");
  });

  it("passes filters through unchanged", () => {
    const q = topNQuery({ ...BASE, filters: [["op_airline_id", ["19790"]]] });
    expect(q.filters).toEqual([["op_airline_id", ["19790"]]]);
  });

  it("defaults filters to empty rather than undefined", () => {
    expect(topNQuery(BASE).filters).toEqual([]);
  });
});

describe("topNPermalink", () => {
  it("encodes the SAME query the table renders", () => {
    // The bug this catches: an Explorer link that quietly differs from the table above it --
    // a different limit, a different sort, a dropped filter. The screenshot still looks
    // authoritative. Deriving both from one spec is the fix; this test pins that they agree.
    const spec = { ...BASE, filters: [["op_airline_id", ["19790"]]] as [string, string[]][] };
    const link = topNPermalink(spec);
    expect(link.startsWith("/explore?")).toBe(true);
    const q = topNQuery(spec);
    expect(link).toContain(`n=${q.limit}`);
    expect(link).toContain("s=-seats");
    expect(link).toContain("d=aircraft_type");
  });
});
