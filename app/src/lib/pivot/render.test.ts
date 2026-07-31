import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderPivot } from "@/lib/pivot/render";
import { PivotError, queryFromJsonable, type PivotQuery } from "@/lib/pivot/types";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";

const REPO = path.resolve(__dirname, "../../../..");
const goldens = JSON.parse(
  readFileSync(path.join(REPO, "sql/03_queries/goldens/pivot.json"), "utf8"),
);

// The symmetric guard to urlstate.test.ts's. Without it this file's `for (const c of
// goldens.cases)` emits zero tests -- and therefore passes -- if pivot.json is ever truncated
// or reshaped. A suite that cannot fail is worse than no suite: it reports green.
describe("golden fixture sanity", () => {
  it("has exactly 11 cases -- a reshaped fixture must not silently emit zero tests", () => {
    expect(goldens.cases).toHaveLength(11);
  });
});

describe("renderPivot reproduces every pinned golden byte-for-byte", () => {
  for (const c of goldens.cases) {
    it(c.name, () => {
      const { sql, params } = renderPivot(queryFromJsonable(c.query), FIXTURE);
      expect(sql).toBe(c.sql);
      expect(params).toEqual(c.params);
    });
  }
});

/** Base valid query, overridable per test -- mirrors pipeline/tests/test_pivot.py's `q()`. */
function q(overrides: Partial<PivotQuery> = {}): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats"],
    timeFrom: "2015-01",
    timeTo: "2015-12",
    filters: [],
    sort: null,
    sortDesc: true,
    limit: 100,
    grouping: "operating",
    ...overrides,
  };
}

// Ported from pipeline/tests/test_pivot.py -- render_pivot is the module's whole security
// boundary (only allowlist-validated identifiers ever reach a substitution slot), so its
// rejection paths need the same coverage as its happy path, not just the 9 goldens.
describe("renderPivot rejects malformed and malicious requests", () => {
  it("rejects an unknown dimension", () => {
    expect(() => renderPivot(q({ dimensions: ["not_a_dimension"] }), FIXTURE)).toThrow(
      PivotError,
    );
    expect(() => renderPivot(q({ dimensions: ["not_a_dimension"] }), FIXTURE)).toThrow(
      /dimension/,
    );
  });

  it("rejects an unknown measure", () => {
    expect(() => renderPivot(q({ measures: ["profit"] }), FIXTURE)).toThrow(PivotError);
    expect(() => renderPivot(q({ measures: ["profit"] }), FIXTURE)).toThrow(/measure/);
  });

  it("rejects a SQL-injection payload as a dimension key rather than substituting it", () => {
    expect(() =>
      renderPivot(
        q({ dimensions: ["op_airline_id; DROP TABLE fct_segment_month--"] }),
        FIXTURE,
      ),
    ).toThrow(PivotError);
  });

  it("rejects a SQL-injection payload as a sort key", () => {
    expect(() =>
      renderPivot(q({ sort: "seats; DELETE FROM dim_carrier--" }), FIXTURE),
    ).toThrow(PivotError);
    expect(() =>
      renderPivot(q({ sort: "seats; DELETE FROM dim_carrier--" }), FIXTURE),
    ).toThrow(/sort/);
  });

  it("rejects a SQL-injection payload as a filter key rather than substituting it", () => {
    expect(() =>
      renderPivot(
        q({ filters: [["op_airline_id; DROP TABLE fct_segment_month--", ["x"]]] }),
        FIXTURE,
      ),
    ).toThrow(PivotError);
  });

  it("rejects an unknown filter key through the same gate as an unknown dimension", () => {
    expect(() =>
      renderPivot(q({ filters: [["not_a_dimension", ["x"]]] }), FIXTURE),
    ).toThrow(PivotError);
    expect(() =>
      renderPivot(q({ filters: [["not_a_dimension", ["x"]]] }), FIXTURE),
    ).toThrow(/dimension/);
  });

  it("rejects a segment-only dimension requested at route grain", () => {
    expect(() =>
      renderPivot(q({ grain: "route", dimensions: ["aircraft_type"] }), FIXTURE),
    ).toThrow(PivotError);
    expect(() =>
      renderPivot(q({ grain: "route", dimensions: ["aircraft_type"] }), FIXTURE),
    ).toThrow(/grain/);
  });

  it("rejects an empty dimension list", () => {
    expect(() => renderPivot(q({ dimensions: [] }), FIXTURE)).toThrow(PivotError);
    expect(() => renderPivot(q({ dimensions: [] }), FIXTURE)).toThrow(/dimension/);
  });

  it("rejects an empty measure list", () => {
    expect(() => renderPivot(q({ measures: [] }), FIXTURE)).toThrow(PivotError);
    expect(() => renderPivot(q({ measures: [] }), FIXTURE)).toThrow(/measure/);
  });

  it("rejects a non-integer limit", () => {
    expect(() => renderPivot(q({ limit: 1.5 }), FIXTURE)).toThrow(PivotError);
    expect(() => renderPivot(q({ limit: 1.5 }), FIXTURE)).toThrow(/limit/);
  });

  it("rejects a negative limit", () => {
    expect(() => renderPivot(q({ limit: -1 }), FIXTURE)).toThrow(PivotError);
    expect(() => renderPivot(q({ limit: -1 }), FIXTURE)).toThrow(/limit/);
  });

  it("rejects a zero limit", () => {
    expect(() => renderPivot(q({ limit: 0 }), FIXTURE)).toThrow(PivotError);
    expect(() => renderPivot(q({ limit: 0 }), FIXTURE)).toThrow(/limit/);
  });

  it("rejects a filter with no values", () => {
    expect(() =>
      renderPivot(q({ filters: [["op_airline_id", []]] }), FIXTURE),
    ).toThrow(PivotError);
    expect(() =>
      renderPivot(q({ filters: [["op_airline_id", []]] }), FIXTURE),
    ).toThrow(/filter/);
  });

  it("rejects an unknown sort key", () => {
    expect(() => renderPivot(q({ sort: "not_a_column" }), FIXTURE)).toThrow(PivotError);
    expect(() => renderPivot(q({ sort: "not_a_column" }), FIXTURE)).toThrow(/sort/);
  });

  it("rejects an unknown grain", () => {
    expect(() =>
      renderPivot(q({ grain: "Segment" as PivotQuery["grain"] }), FIXTURE),
    ).toThrow(PivotError);
  });

  it("rejects an unknown grouping rather than silently falling back to operating", () => {
    expect(() =>
      renderPivot(q({ grouping: "Mainline" as PivotQuery["grouping"] }), FIXTURE),
    ).toThrow(PivotError);
    expect(() =>
      renderPivot(q({ grouping: "Mainline" as PivotQuery["grouping"] }), FIXTURE),
    ).toThrow(/grouping/);
  });
});

describe("composite-dimension filters", () => {
  const BASE = {
    grain: "segment", dimensions: ["op_airline_id"], measures: ["seats"],
    timeFrom: "2025-05", timeTo: "2026-04", sort: null, sortDesc: true,
    limit: 50, grouping: "operating",
  } as unknown as PivotQuery;

  it("emits least/greatest over both key columns", () => {
    const { sql, params } = renderPivot(
      { ...BASE, filters: [["route", ["12478-12892"]]] }, FIXTURE);
    expect(sql).toContain(
      "(least(route_key_low, route_key_high) = $f0_0a " +
        "AND greatest(route_key_low, route_key_high) = $f0_0b)",
    );
    expect(params.f0_0a).toBe("12478");
    expect(params.f0_0b).toBe("12892");
  });

  it("OR-joins multiple routes, keeping IN-list semantics", () => {
    const { sql, params } = renderPivot(
      { ...BASE, filters: [["route", ["12478-12892", "10140-14747"]]] }, FIXTURE);
    expect(sql).toContain(" OR ");
    expect(sql).toContain("$f0_1a");
    expect(sql).toContain("$f0_1b");
    expect(params.f0_1a).toBe("10140");
    expect(params.f0_1b).toBe("14747");
  });

  it("rejects a malformed pair with a named error", () => {
    expect(() =>
      renderPivot({ ...BASE, filters: [["route", ["12478"]]] }, FIXTURE),
    ).toThrow(/two ids joined by/);
  });

  it("rejects a non-numeric pair with a named PivotError instead of reaching DuckDB", () => {
    // Important 4, final whole-branch review: 'JFK-LAX' has two non-empty dash-separated
    // parts, so the OLD check (length === 2, both non-empty) passed it straight through to
    // a bound string param -- DuckDB then threw an unhandled "Conversion Error: Could not
    // convert string 'JFK' to INT32" deep inside runPivot(), which decode()'s own PivotError
    // guard never saw. Verified against a running build before this fix. Fails if the digit
    // check is dropped, or narrowed to reject only non-ASCII digits.
    expect(() =>
      renderPivot({ ...BASE, filters: [["route", ["JFK-LAX"]]] }, FIXTURE),
    ).toThrow(PivotError);
    expect(() =>
      renderPivot({ ...BASE, filters: [["route", ["JFK-LAX"]]] }, FIXTURE),
    ).toThrow(/two ids joined by/);
  });

  it("strips ASCII whitespace around each id, matching pipeline/pivot.py's strip set", () => {
    // Not `.trim()`/`.strip()` directly (JS and Python disagree on non-ASCII whitespace --
    // see stripAsciiWhitespace's header comment) -- this pins the ASCII case both language's
    // explicit sets agree on, so a regression to either language's native trim/strip would
    // still pass this specific test (by design: the divergence is in the NON-ASCII set,
    // which no golden exercises either -- documented as a known gap, not asserted here).
    const { params } = renderPivot(
      { ...BASE, filters: [["route", [" 12478 - 12892\t"]]] },
      FIXTURE,
    );
    expect(params.f0_0a).toBe("12478");
    expect(params.f0_0b).toBe("12892");
  });

  it("leaves the single-column filter path untouched", () => {
    const { sql, params } = renderPivot(
      { ...BASE, filters: [["origin_state", ["OR", "WA"]]] }, FIXTURE);
    expect(sql).toContain("origin_state IN ($f0_0, $f0_1)");
    expect(params.f0_0).toBe("OR");
  });
});
