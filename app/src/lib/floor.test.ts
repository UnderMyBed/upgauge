import { describe, expect, it } from "vitest";
import { DEPARTURE_FLOOR, belowFloor } from "@/lib/floor";

// THE FIXTURE THAT DISCRIMINATES, and the reason this file exists (#134).
//
// The floor is MONTHLY -- 30 departures per month FLOWN -- so the two rows below must land on
// OPPOSITE sides of it. Under the shipped bug (a twelve-month SUM compared against 30) they
// land on the SAME side, both scored, which is why a fixture carrying only one of them proves
// nothing: it passes under the bug and under the fix alike.
//
//   SPARSE_BUT_LONG   12 months x 2.5/mo  =    30 departures -> BELOW floor, and the defect:
//                                                              the raw sum clears 30 exactly.
//   BRIEF_BUT_DENSE    3 months x 40/mo   =   120 departures -> SCORED, and the guard against
//                                                              "fixing" the bug with a flat 360.
const SPARSE_BUT_LONG = { departures: 30, activeMonths: 12 };
const BRIEF_BUT_DENSE = { departures: 120, activeMonths: 3 };

describe("the departure floor is per month FLOWN, not per window", () => {
  it("is 30", () => {
    expect(DEPARTURE_FLOOR).toBe(30);
  });

  it("marks a route that flew twelve months at 2.5 departures/month BELOW floor", () => {
    // Dies to: `departures < DEPARTURE_FLOOR` (the shipped bug -- 30 is not < 30, so this
    // row read as scored on /carrier, /route, /aircraft and the maps).
    expect(belowFloor(SPARSE_BUT_LONG.departures, SPARSE_BUT_LONG.activeMonths)).toBe(true);
  });

  it("leaves a route that flew three months at 40 departures/month SCORED", () => {
    // Dies to: dividing by the WINDOW length instead of the months that flew (the "flat 360"
    // fix) -- 120/12 = 10, which would mark this row below floor.
    expect(belowFloor(BRIEF_BUT_DENSE.departures, BRIEF_BUT_DENSE.activeMonths)).toBe(false);
  });

  it("puts exactly 30 departures per flown month ON the floor, not below it", () => {
    // Dies to: `<=` for `<`. The rule is a MINIMUM -- 30 a month is the lowest rate that
    // qualifies, not the first one that fails.
    expect(belowFloor(360, 12)).toBe(false);
    expect(belowFloor(359, 12)).toBe(true);
  });

  it("marks a group that flew in no month at all below floor", () => {
    // Filed and never flown. The rate is 0/0, which is not a number -- but "it flew in zero
    // months" is the sparsest a row can be, and this is what the pre-#134 rule said too
    // (0 < 30), so the zero-departure row keeps its mark rather than silently losing it.
    expect(belowFloor(0, 0)).toBe(true);
  });
});

describe("absence makes no claim about the floor, in either direction", () => {
  // lib/format.ts's opening rule: null is absence, zero is a measurement. The pivot templates
  // emit only the measures a query selected, so a permalink that did not ask for
  // `departures_performed` has no departure count at all -- reading that as 0 marked 100% of
  // those rows below floor (app/smoke.sh pins the served form of this).
  it("makes no claim when the departure count was never queried", () => {
    expect(belowFloor(undefined, 12)).toBe(false);
  });

  it("makes no claim when the departure count is unknowable", () => {
    // A wholly-quarantined group sums to NULL, not 0.
    expect(belowFloor(null, 12)).toBe(false);
  });

  it("makes no claim when the active-month count is absent", () => {
    // NOT /watch any more (#148): mart_route_health carries `t12_months_flown` and the presets
    // alias it, so their rows divide for real. This branch guards any OTHER producer that hands
    // over a departure count with no month count beside it.
    expect(belowFloor(30, undefined)).toBe(false);
    expect(belowFloor(30, null)).toBe(false);
  });
});
