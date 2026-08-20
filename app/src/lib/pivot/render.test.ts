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
  it("has exactly 13 cases -- a reshaped fixture must not silently emit zero tests", () => {
    expect(goldens.cases).toHaveLength(13);
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
    // 'JFK-LAX' has two non-empty dash-separated parts, so it clears the arity check and is
    // caught by the per-part value rule -- which is why its message is the value one rather
    // than "two ids joined by". Without any per-part check it reaches a bound string param and
    // DuckDB throws "Conversion Error: Could not convert string 'JFK' to INT32" deep inside
    // runPivot(), which neither /explore nor /api/pivot was written to catch. Fails if the
    // per-part check is dropped from the pair branch.
    expect(() =>
      renderPivot({ ...BASE, filters: [["route", ["JFK-LAX"]]] }, FIXTURE),
    ).toThrow(PivotError);
    expect(() =>
      renderPivot({ ...BASE, filters: [["route", ["JFK-LAX"]]] }, FIXTURE),
    ).toThrow(/must be a plain whole number/);
  });

  it("rejects ASCII whitespace around each id instead of stripping it", () => {
    // Same fixture that used to pin the STRIP; it now pins the rejection. Stripping made
    // ' 12478 - 12892\t' render rows identical to '12478-12892' -- an unbounded family of
    // distinct CDN keys for one query, on the dimension every /route/ page links through.
    // Splitting and checking RAW is what closes it, and it also removes a latent
    // cross-language divergence: JS's trim() strips U+FEFF, Python's .strip() does not;
    // .strip() strips \x1c-\x1f, trim() does not. With no strip, no set to disagree about.
    expect(() =>
      renderPivot({ ...BASE, filters: [["route", [" 12478 - 12892\t"]]] }, FIXTURE),
    ).toThrow(/for 'route' must be a plain whole number/);
  });

  it("leaves the single-column filter path untouched", () => {
    const { sql, params } = renderPivot(
      { ...BASE, filters: [["origin_state", ["OR", "WA"]]] }, FIXTURE);
    expect(sql).toContain("origin_state IN ($f0_0, $f0_1)");
    expect(params.f0_0).toBe("OR");
  });
});

// M7 Task 2: endpoint_airport_id also spans two columns, but unlike route -- ONE route pair,
// least()/greatest() equality -- its two columns are ALTERNATIVES, compiled to an OR. filter_only
// is the other half of the same catalog row: accepted in a filter, rejected as a grouping
// dimension, since grouping by it would double-count every segment row into both its origin's
// group and its dest's group.
describe("either-mode filters (endpoint_airport_id)", () => {
  it("compiles an either-mode filter to an OR across both columns", () => {
    // Catches: compiling `either` through the single-column branch (origin only), which is
    // the SILENT half of an airport query -- SEA reads 26,708,918 seats instead of
    // 53,372,100 and every row still renders perfectly.
    const { sql } = renderPivot(q({ filters: [["endpoint_airport_id", ["14747"]]] }), FIXTURE);
    expect(sql).toContain("(origin_airport_id IN ($f0_0) OR dest_airport_id IN ($f0_0))");
  });

  it("ORs multiple values inside each side of an either filter", () => {
    const { sql, params } = renderPivot(
      q({ filters: [["endpoint_airport_id", ["14747", "13930"]]] }),
      FIXTURE,
    );
    expect(sql).toContain(
      "(origin_airport_id IN ($f0_0, $f0_1) OR dest_airport_id IN ($f0_0, $f0_1))",
    );
    expect(params).toMatchObject({ f0_0: "14747", f0_1: "13930" });
  });

  it("rejects a filter-only dimension used as a grouping dimension", () => {
    // Catches: allowing endpoint_airport_id in `d`, which double-counts every row.
    expect(() =>
      renderPivot(q({ dimensions: ["endpoint_airport_id"] }), FIXTURE),
    ).toThrow(/cannot be grouped by; it is filter-only/);
  });

  it("still compiles route as a least/greatest pair, not an OR", () => {
    // Catches: the new `either` branch swallowing `pair` -- which would make a route filter
    // match same-airport rows again (18,895 seats on JFK-LAX).
    const { sql } = renderPivot(q({ filters: [["route", ["12478-12892"]]] }), FIXTURE);
    expect(sql).toContain("least(route_key_low, route_key_high) = $f0_0a");
    expect(sql).not.toContain(" OR dest_airport_id IN ");
  });
});

// Issue #87. A filter value is bound as a VARCHAR parameter against the dimension's fact
// column, so an integer column handed a value it cannot cast throws a DuckDB Conversion Error
// at EXECUTION -- after proxy.ts has already resolved cacheability and written HTML_CACHE, so
// the 500 is held by the CDN for up to an hour at a cost of one attacker request. Rejecting at
// render time turns that into a PivotError the three call sites already handle (no-store from
// the proxy, 400 from /api/pivot, the named error page on /explore).
//
// The type is READ from the catalog (DimensionEntry.valueType), never inferred from the key
// name -- aircraft_type is VARCHAR carrying zero-padded codes ('079') and a numeric rule
// guessed from the name would corrupt it.
describe("filter values are type-checked against the dimension's column type", () => {
  it("rejects a non-numeric value on an INTEGER dimension", () => {
    // Catches: no check at all on the single-column branch. Measured against the real
    // warehouse at this base commit: op_airline_id='2T (1)' -> Conversion Error, INT32.
    expect(() => renderPivot(q({ filters: [["op_airline_id", ["2T (1)"]]] }), FIXTURE)).toThrow(
      PivotError,
    );
    expect(() => renderPivot(q({ filters: [["op_airline_id", ["2T (1)"]]] }), FIXTURE)).toThrow(
      /must be a plain whole number/,
    );
  });

  it("rejects an all-digits value that overflows SMALLINT", () => {
    // THE test that a digits-only check cannot pass. '99999' is every character a digit and
    // still throws (INT16 max is 32767) -- measured. A rule copied from the old route branch
    // (/^\d+$/) passes a test written with '2T (1)' and leaves this 500 live.
    expect(() => renderPivot(q({ filters: [["distance_group", ["99999"]]] }), FIXTURE)).toThrow(
      /must be a plain whole number/,
    );
  });

  it("rejects an all-digits value that overflows TINYINT", () => {
    // Same shape one width down: quarter is TINYINT, max 127, and '999' throws.
    expect(() => renderPivot(q({ filters: [["quarter", ["999"]]] }), FIXTURE)).toThrow(
      /must be a plain whole number/,
    );
  });

  it("accepts each integer type's exact maximum", () => {
    // The bound is inclusive. A rule written with `>=` instead of `>` would reject these four
    // legitimate values and 400 a permalink that works today.
    for (const [key, max] of [
      ["quarter", "127"],
      ["distance_group", "32767"],
      ["op_airline_id", "2147483647"],
      ["year", "9223372036854775807"],
    ] as const) {
      const { params } = renderPivot(q({ filters: [[key, [max]]] }), FIXTURE);
      expect(params.f0_0).toBe(max);
    }
  });

  it("rejects each integer type's maximum plus one", () => {
    // The BIGINT row is the one that needs BigInt rather than Number: measured,
    // Number('9223372036854775808') <= 9223372036854775807 is TRUE, because both sides round
    // to 2^63 as doubles. A Number-based bound leaves f=year:9223372036854775808 a live 500.
    for (const [key, over] of [
      ["quarter", "128"],
      ["distance_group", "32768"],
      ["op_airline_id", "2147483648"],
      ["year", "9223372036854775808"],
    ] as const) {
      expect(() => renderPivot(q({ filters: [[key, [over]]] }), FIXTURE)).toThrow(
        /must be a plain whole number/,
      );
    }
  });

  it("leaves a VARCHAR dimension unchecked, binding a zero-padded code verbatim", () => {
    // Catches: applying the integer rule to VARCHAR. aircraft_type '079' is a real code and
    // MUST survive as the string '079' -- int-parsing it to 79 breaks the join silently
    // (CLAUDE.md's zero-padding gotcha). This test is what proves the type is READ from the
    // catalog rather than guessed from the key name.
    const { sql, params } = renderPivot(q({ filters: [["aircraft_type", ["079"]]] }), FIXTURE);
    expect(sql).toContain("aircraft_type IN ($f0_0)");
    expect(params.f0_0).toBe("079");
  });

  it("leaves a VARCHAR dimension unchecked for arbitrary junk", () => {
    // origin_state='2T (1)' returns zero rows against the real warehouse -- the ordinary
    // no-match shape, not an error. Rejecting it would be inventing a constraint.
    const { params } = renderPivot(q({ filters: [["origin_state", ["2T (1)"]]] }), FIXTURE);
    expect(params.f0_0).toBe("2T (1)");
  });

  it("rejects non-canonical spellings that DuckDB would have cast happily", () => {
    // Measured against the real warehouse: every one of these renders the byte-identical
    // /carrier/DL page as canonical '19790', so each is a distinct CDN cache key for the same
    // bytes -- and the leading-zero and underscore families are UNBOUNDED, capped only by URL
    // length. This is the #52 spelling axis, and `f` is where it was left open.
    for (const spelling of [
      "0019790",
      "000000019790",
      "+19790",
      " 19790 ",
      "1.979e4",
      "19790.0",
      "19790.",
      "0x4D5E",
      "19_790",
      "1_9_7_9_0",
    ]) {
      expect(() => renderPivot(q({ filters: [["op_airline_id", [spelling]]] }), FIXTURE)).toThrow(
        /must be a plain whole number/,
      );
    }
  });

  it("rejects a value with a trailing newline", () => {
    // The anchor test, and it is a cross-language one. Python's `$` ALSO matches before a
    // trailing newline, so `^...$` there admits '19790\n' -- which DuckDB casts to 19790,
    // making it one more spelling of the same page. JS's `$` (no /m) does not. pipeline's
    // mirror of this rule must use \A...\Z or the pair silently diverges.
    expect(() => renderPivot(q({ filters: [["op_airline_id", ["19790\n"]]] }), FIXTURE)).toThrow(
      /must be a plain whole number/,
    );
  });

  it("rejects a negative value", () => {
    // '-1' casts fine and returns zero rows, so this is a cache-key argument, not a crash
    // one: an unbounded family of distinct keys for empty results. encode() never emits one.
    expect(() => renderPivot(q({ filters: [["op_airline_id", ["-1"]]] }), FIXTURE)).toThrow(
      /must be a plain whole number/,
    );
  });

  it("checks every value in the list, not just the first", () => {
    // Catches: validating values[0] and binding the rest unchecked -- which passes every
    // single-value test in this file and leaves the 500 reachable with one extra comma.
    expect(() =>
      renderPivot(q({ filters: [["op_airline_id", ["19790", "2T (1)"]]] }), FIXTURE),
    ).toThrow(/must be a plain whole number/);
  });

  it("names the offending value and the dimension key in the message", () => {
    // app/smoke.sh needles assert on the substring 'must be a plain whole number' plus the
    // dimension key, inside the /explore error page's role="alert" region. Both halves are
    // load-bearing; ASCII only, since a curly apostrophe is that file's self-defect #2.
    expect(() => renderPivot(q({ filters: [["op_airline_id", ["2T (1)"]]] }), FIXTURE)).toThrow(
      /filter value '2T \(1\)' for 'op_airline_id' must be a plain whole number from 0 to 2147483647/,
    );
  });

  it("rejects a digit string longer than any integer type can hold", () => {
    // 4301 nines. This is the length guard's own fixture, and the two runtimes differ in what
    // the guard BUYS: in Python int() raises ValueError above 4300 digits, so the guard is a
    // correctness bound there and its removal is caught. BigInt() has no such limit, so here
    // the guard is a parse-COST bound only and this test passes with or without it -- recorded
    // rather than implied, because a comment that claims test coverage it does not have is
    // worse than none. The rejection itself is pinned on both sides.
    expect(() => renderPivot(q({ filters: [["year", ["9".repeat(4301)]]] }), FIXTURE)).toThrow(
      /must be a plain whole number/,
    );
  });

  it("rejects a bad value through the either branch", () => {
    // Catches: the check wired into the single-column branch only. endpoint_airport_id is
    // 'either'-mode and takes its own code path, so it needs its own coverage.
    expect(() =>
      renderPivot(q({ filters: [["endpoint_airport_id", ["2T (1)"]]] }), FIXTURE),
    ).toThrow(/must be a plain whole number/);
  });

  it("still compiles a valid either filter to an OR across both columns", () => {
    const { sql, params } = renderPivot(
      q({ filters: [["endpoint_airport_id", ["14747"]]] }),
      FIXTURE,
    );
    expect(sql).toContain("(origin_airport_id IN ($f0_0) OR dest_airport_id IN ($f0_0))");
    expect(params.f0_0).toBe("14747");
  });

  it("rejects an overflowing id inside a composite route pair", () => {
    // The route branch's OLD check was /^\d+$/ per part, so this passed validation and threw
    // inside DuckDB -- a second live 500 of the same class, measured at this base commit.
    expect(() =>
      renderPivot(q({ filters: [["route", ["99999999999-99999999999"]]] }), FIXTURE),
    ).toThrow(/must be a plain whole number/);
  });

  it("rejects a composite pair whose SECOND part is bad", () => {
    // Catches: checking parts[0] only. The first id here is perfectly valid.
    expect(() =>
      renderPivot(q({ filters: [["route", ["12478-99999999999"]]] }), FIXTURE),
    ).toThrow(/must be a plain whole number/);
  });

  it("rejects a non-numeric composite pair through the value rule", () => {
    // 'JFK-LAX' has two non-empty parts, so it clears the arity check and is caught by the
    // per-part value rule instead -- which is why its message is now the value one.
    expect(() => renderPivot(q({ filters: [["route", ["JFK-LAX"]]] }), FIXTURE)).toThrow(
      PivotError,
    );
    expect(() => renderPivot(q({ filters: [["route", ["JFK-LAX"]]] }), FIXTURE)).toThrow(
      /must be a plain whole number/,
    );
  });

  it("keeps the arity error for a pair that is not two parts", () => {
    // Structure and value are different failures and keep different messages: '12478' is not
    // two ids at all, so the "two ids joined by '-'" promise is the right thing to state.
    expect(() => renderPivot(q({ filters: [["route", ["12478"]]] }), FIXTURE)).toThrow(
      /two ids joined by/,
    );
  });

  it("rejects every shape of whitespace inside a composite pair", () => {
    // The measured family, not one example of it: leading runs, trailing runs, and whitespace
    // around the separator each produced rows identical to 'route:12478-12892' while stripping
    // was in place. Unbounded, because the runs may be any length.
    for (const spelling of [
      "  12478-12892",
      "12478-12892\t",
      "\n\n 12478-12892 \t",
      "12478 - 12892",
      " 12478  -  12892 ",
    ]) {
      // The key is pinned as well as the message. Not because "some other error might fire"
      // -- a mistyped grain raises different text and would fail a message-only assertion too
      // -- but because a rejection naming a DIFFERENT dimension does match one: a query with
      // op_airline_id='2T (1)' alongside a valid route value raises "... for 'op_airline_id'
      // must be a plain whole number", which a message-only check reads as a pass for route.
      expect(() => renderPivot(q({ filters: [["route", [spelling]]] }), FIXTURE)).toThrow(
        /for 'route' must be a plain whole number/,
      );
    }
  });

  it("still accepts the canonical composite pair", () => {
    // The control that stops the whitespace rejections above being vacuous: same two ids, no
    // whitespace, still binds and still compiles to least()/greatest().
    const { sql, params } = renderPivot(q({ filters: [["route", ["12478-12892"]]] }), FIXTURE);
    expect(sql).toContain("least(route_key_low, route_key_high) = $f0_0a");
    expect(params.f0_0a).toBe("12478");
    expect(params.f0_0b).toBe("12892");
  });
});
