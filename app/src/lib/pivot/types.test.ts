import { describe, expect, it } from "vitest";
import { normalizeQuery, queryFromJsonable } from "@/lib/pivot/types";

describe("normalizeQuery mirrors PivotQuery.__post_init__", () => {
  it("forces sortDesc true when sort is null", () => {
    // Python normalizes this because `sort=None, sort_desc=False` has no
    // representation in the URL format -- a direction is only ever emitted
    // alongside a sort key. Golden: no_sort_key_ignores_sort_desc.
    const q = normalizeQuery({
      grain: "segment", dimensions: ["year_month"], measures: ["seats"],
      timeFrom: "2015-01", timeTo: "2015-12", filters: [],
      sort: null, sortDesc: false, limit: 100, grouping: "operating",
    });
    expect(q.sortDesc).toBe(true);
  });

  it("leaves sortDesc alone when a sort key is present", () => {
    const q = normalizeQuery({
      grain: "segment", dimensions: ["year_month"], measures: ["seats"],
      timeFrom: "2015-01", timeTo: "2015-12", filters: [],
      sort: "seats", sortDesc: false, limit: 100, grouping: "operating",
    });
    expect(q.sortDesc).toBe(false);
  });
});

describe("queryFromJsonable reads the goldens' snake_case shape", () => {
  it("maps every field", () => {
    const q = queryFromJsonable({
      grain: "route", dimensions: ["route"], measures: ["seats"],
      time_from: "2015-01", time_to: "2015-12",
      filters: [["origin_airport_id", ["14057"]]],
      sort: "seats", sort_desc: true, limit: 25, grouping: "mainline",
    });
    expect(q.grain).toBe("route");
    expect(q.timeFrom).toBe("2015-01");
    expect(q.filters).toEqual([["origin_airport_id", ["14057"]]]);
    expect(q.sortDesc).toBe(true);
    expect(q.grouping).toBe("mainline");
  });
});
