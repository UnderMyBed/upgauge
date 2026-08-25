import { describe, expect, it } from "vitest";
import { pickerOptions } from "@/lib/map/picker";
import { dataAsOf, runPivot } from "@/lib/db";
import { resolutionKey, type Resolved } from "@/lib/resolve";

/**
 * PRODUCER-SHAPED, and that is the whole point of this helper rather than an object literal.
 * `PivotResult.resolved` is a `Map<string, Resolved>` keyed by `resolutionKey()` (`db.ts:259`,
 * `resolve.ts:402`) -- NOT a nested `{ [dim]: { [id]: label } }` object. A fixture in the
 * nested shape cannot express the bug: an implementation that indexes it as an object gets
 * `undefined` from a real Map, falls back to the raw id for EVERY row, and renders "673"
 * where the reader should see "CRJ-700" -- on both pages that mount a picker -- while every
 * assertion written against the object-shaped fixture stays green.
 */
function resolvedMap(dimKey: string, entries: Record<string, Resolved>): Map<string, Resolved> {
  return new Map(Object.entries(entries).map(([id, r]) => [resolutionKey(dimKey, id), r]));
}

const ROWS = [
  { aircraft_type: "631", seats: 10_000 },
  { aircraft_type: "673", seats: 90_000 },
  { aircraft_type: "629", seats: 50_000 },
];

// `code` is dim_aircraft_type.short_name, `name` the full designation -- resolve_aircraft_type.sql
// inverts the usual direction on purpose, and `displayValue` returns the code.
const RESOLVED = resolvedMap("aircraft_type", {
  "631": { code: "CRJ-200", name: "CANADAIR RJ-200ER /RJ-440" },
  "673": { code: "CRJ-700", name: "CANADAIR RJ-700" },
  "629": { code: "EMB-120", name: "EMBRAER-120 BRASILIA" },
});

/** Look one option up BY VALUE, never by position. Three assertions below are about a single
 *  option's fields, not about where it sits, and indexing `[0]` would make them fail under the
 *  dropped-sort mutant too -- collateral reds that make a mutant table say less than it looks
 *  like it says. */
function byValue(value: string, over: Partial<Parameters<typeof pickerOptions>[0]> = {}) {
  const hit = opts(over).find((o) => o.value === value);
  if (hit === undefined) throw new Error(`no option for ${value}`);
  return hit;
}

function opts(over: Partial<Parameters<typeof pickerOptions>[0]> = {}) {
  return pickerOptions({
    rows: ROWS,
    resolved: RESOLVED,
    dimKey: "aircraft_type",
    basePath: "/carrier/OO",
    filterKey: "type",
    selected: null,
    ...over,
  });
}

describe("pickerOptions", () => {
  it("orders by seats descending, not by the row order it was given", () => {
    // ORDERING is the property. Asserting the SET of values passes under a dropped sort -- the
    // same shape that let M4c's stack-order mutant survive.
    expect(opts().map((o) => o.value)).toEqual(["673", "629", "631"]);
  });

  it("breaks a seats tie on the value, so two loads of tied rows agree", () => {
    // The pivot's ORDER BY seats DESC carries no tiebreak column, so tied seats are
    // SQL-unspecified and two runs can list them differently (segmentMap.ts states the same
    // rule for node emission order). Fed in DESCENDING value order, a dropped tiebreak leaves
    // them there -- V8's sort is stable -- so only the SEQUENCE distinguishes correct here.
    const tied = pickerOptions({
      rows: [
        { aircraft_type: "673", seats: 1_000 },
        { aircraft_type: "631", seats: 1_000 },
        { aircraft_type: "629", seats: 1_000 },
      ],
      resolved: RESOLVED,
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      selected: null,
    });
    expect(tied.map((o) => o.value)).toEqual(["629", "631", "673"]);
  });

  it("builds an href on the base path with the filter key", () => {
    expect(byValue("673").href).toBe("/carrier/OO?type=673");
  });

  it("marks exactly the selected option, matching on the raw value not the label", () => {
    expect(
      opts({ selected: "629" })
        .filter((o) => o.selected)
        .map((o) => o.value),
    ).toEqual(["629"]);
  });

  it("does not match the selection against the label", () => {
    // Matching on `label` would make `?type=EMB-120` -- a value no href this module emits ever
    // carries -- select a row, and `?type=629` select nothing.
    expect(opts({ selected: "EMB-120" }).some((o) => o.selected)).toBe(false);
  });

  it("keeps a zero-padded code a string", () => {
    // AIRCRAFT_TYPE `079` becomes `79` if int-parsed and the join breaks silently (CLAUDE.md).
    const out = pickerOptions({
      rows: [{ aircraft_type: "079", seats: 1 }],
      resolved: resolvedMap("aircraft_type", { "079": { code: "C208", name: "CESSNA 208 CARAVAN" } }),
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      selected: null,
    });
    expect(out[0].value).toBe("079");
    expect(out[0].href).toBe("/carrier/OO?type=079");
  });

  it("reads the resolved Map by resolutionKey, so real labels reach the reader", () => {
    // THE STALE-CONTRACT MUTANT. An implementation indexing `resolved` as a nested object gets
    // `undefined` from a real Map and renders the raw BTS code on every option, on both pages.
    expect(opts().map((o) => [o.value, o.label])).toEqual(
      expect.arrayContaining([
        ["673", "CRJ-700"],
        ["629", "EMB-120"],
        ["631", "CRJ-200"],
      ]),
    );
  });

  it("renders the NAME when the dimension resolves with no code", () => {
    // `displayValue`'s three-way contract, which resolve.ts:38-52 forbids re-deriving locally:
    // absent -> raw id; resolved with `code: null` (dim_city_market) -> the NAME; otherwise the
    // code. A local `hit?.code ?? raw` collapses the first two and renders "30559" for Chicago.
    const out = pickerOptions({
      rows: [{ origin_city_market_id: 30559, seats: 5 }],
      resolved: resolvedMap("origin_city_market_id", {
        "30559": { code: null, name: "Chicago, IL" },
      }),
      dimKey: "origin_city_market_id",
      basePath: "/carrier/OO",
      filterKey: "market",
      selected: null,
    });
    expect(out[0].label).toBe("Chicago, IL");
  });

  it("falls back to the raw value when the dimension resolves no label", () => {
    const out = pickerOptions({
      rows: [{ aircraft_type: "999", seats: 1 }],
      resolved: new Map(),
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      selected: null,
    });
    expect(out[0].label).toBe("999");
    expect(out[0].title).toBeNull();
  });

  it("carries the full name as `title`, the <abbr> DataTable already gives a resolved id", () => {
    expect(byValue("673").title).toBe("CANADAIR RJ-700");
  });

  it("drops a row whose dimension value is absent rather than linking to an empty filter", () => {
    const out = pickerOptions({
      rows: [{ aircraft_type: null, seats: 9 }, { aircraft_type: "673", seats: 1 }],
      resolved: RESOLVED,
      dimKey: "aircraft_type",
      basePath: "/carrier/OO",
      filterKey: "type",
      selected: null,
    });
    expect(out.map((o) => o.value)).toEqual(["673"]);
  });

  it("percent-encodes a value that carries a reserved character", () => {
    // `CE-206/7` is a real short_name; an unencoded `/` in the query string would be a
    // different filter value on the way back in.
    const out = pickerOptions({
      rows: [{ op_airline_id: "A/B", seats: 1 }],
      resolved: new Map(),
      dimKey: "op_airline_id",
      basePath: "/aircraft/CRJ-700",
      filterKey: "carrier",
      selected: null,
    });
    expect(out[0].href).toBe("/aircraft/CRJ-700?carrier=A%2FB");
  });
});

/**
 * REAL, and named so it resists the drift this repo has already paid for (a BTS refresh renamed
 * aircraft type 699 out from under a whole fixture set). `/carrier/F4` -- Air Charter, Inc d/b/a
 * Air Flamenco, airline_id 21615 -- over the trailing 12 to 2026-05 returns exactly these three
 * rows from the page's own pivot, verified against `upgauge.duckdb`:
 *
 *     type=131  seats=24289  deps=2987  quarantined_rows=2
 *     type=489  seats=NULL   deps=NULL  quarantined_rows=5
 *     type=201  seats=NULL   deps=NULL  quarantined_rows=2
 *
 * `seats` is `SUM(seats) FILTER (WHERE NOT is_quarantined)`, so a group whose every filing was
 * quarantined sums to NULL. `render.ts` emits no `HAVING` and no `IS NOT NULL`, so they arrive.
 */
const F4_ROWS = [
  { aircraft_type: "131", seats: 24_289 },
  { aircraft_type: "489", seats: null },
  { aircraft_type: "201", seats: null },
];

describe("pickerOptions with an absent seat total", () => {
  it("keeps a NULL seat sum null instead of calling it zero", () => {
    // `format.ts:1`: null is absence, zero is a measurement, never render one as the other.
    // `?? 0` makes /carrier/F4 state a seat total of 0 for two types whose total is unknowable.
    const out = pickerOptions({
      rows: F4_ROWS, resolved: new Map(), dimKey: "aircraft_type",
      basePath: "/carrier/F4", filterKey: "type", selected: null,
    });
    expect(out.map((o) => [o.value, o.seats])).toEqual([
      ["131", 24_289],
      ["201", null],
      ["489", null],
    ]);
  });

  it("sorts an absent total AFTER a genuine zero, not alongside it", () => {
    // THE MUTANT-KILLING FIXTURE, and both halves are real cases this codebase documents:
    //   `650` -- DL x 650 over 2015, five pairs, every one zero seats on zero performed
    //            departures. FILED AND GENUINELY NOT FLOWN: 0 is a measurement.
    //   `489` -- F4 x 489, five filings, every one quarantined. UNKNOWABLE: null is absence.
    //
    // The order is what distinguishes them, and the values are chosen so it MOVES: under
    // `?? 0` both are 0, the tiebreak runs, and "489".localeCompare("650") puts the absent one
    // FIRST. A fixture using seats: 0 for both, or values sorting the other way, would produce
    // the identical array under the bug and prove nothing.
    const out = pickerOptions({
      rows: [
        { aircraft_type: "489", seats: null },
        { aircraft_type: "650", seats: 0 },
      ],
      resolved: new Map(), dimKey: "aircraft_type",
      basePath: "/carrier/F4", filterKey: "type", selected: null,
    });
    expect(out.map((o) => o.value)).toEqual(["650", "489"]);
    expect(out.map((o) => o.seats)).toEqual([0, null]);
  });

  it("orders two absent totals deterministically, so two loads agree", () => {
    // A NaN comparator is not merely wrong, it is INCONSISTENT -- the result can depend on the
    // engine's sort and on input order, against the byte-stability this repo rests on. Fed in
    // both orders, the output must be identical.
    const rows = [
      { aircraft_type: "489", seats: null },
      { aircraft_type: "201", seats: null },
    ];
    const args = { resolved: new Map(), dimKey: "aircraft_type", basePath: "/carrier/F4", filterKey: "type", selected: null };
    const forward = pickerOptions({ rows, ...args }).map((o) => o.value);
    const reversed = pickerOptions({ rows: [...rows].reverse(), ...args }).map((o) => o.value);
    expect(forward).toEqual(["201", "489"]);
    expect(reversed).toEqual(forward);
  });

  it("throws when the page's pivot never selected `seats`", () => {
    // `undefined` is a WIRING bug, not absence. Reading it as null would mark every option on
    // the page quarantined -- a louder lie than the one this guard exists to stop. Both page
    // pivots go through `trailing12Query`, whose measures always include `seats`.
    expect(() =>
      pickerOptions({
        rows: [{ aircraft_type: "673" }], resolved: new Map(), dimKey: "aircraft_type",
        basePath: "/carrier/OO", filterKey: "type", selected: null,
      }),
    ).toThrow(/no `seats` column/);
  });
});

describe("pickerOptions against a real pivot result", () => {
  it("resolves labels from the Map runPivot actually returns", async () => {
    // The shape assertion the hand-built fixture above cannot make: this takes `rows` and
    // `resolved` from the PRODUCER, unmodified. `/aircraft`'s picker is exactly this pivot
    // (page.tsx:139), so a shape drift in `PivotResult.resolved` fails here rather than
    // silently rendering airline ids to every reader.
    const asOf = await dataAsOf();
    const result = await runPivot({
      grain: "segment",
      dimensions: ["op_airline_id"],
      measures: ["seats"],
      timeFrom: "2025-01",
      timeTo: asOf,
      filters: [],
      sort: "seats",
      sortDesc: true,
      limit: 20,
      grouping: "operating",
    });
    const out = pickerOptions({
      rows: result.rows,
      resolved: result.resolved,
      dimKey: "op_airline_id",
      basePath: "/aircraft/B737-8",
      filterKey: "carrier",
      selected: null,
    });

    expect(out.length).toBeGreaterThan(0);
    // Every value is the numeric AIRLINE_ID; every label is the carrier CODE, never that id.
    // Under a nested-object read every label would equal its value and this goes red.
    for (const o of out) {
      expect(o.value).toMatch(/^\d+$/);
      expect(o.label).not.toBe(o.value);
      expect(o.label).toMatch(/^[A-Z0-9]{2}\b|^[A-Z0-9]{2,3}$/);
      expect(o.title).not.toBeNull();
    }
  });
});
