import { describe, expect, it } from "vitest";
import {
  rowNote,
  rowSteps,
  stepPhrase,
  stepsApply,
  stepsBySubject,
  type MainlineStep,
} from "@/lib/pivot/compositionSteps";
import type { PivotQuery } from "@/lib/pivot/types";

const AS = 19930;
const VX = 21171;
const DL = 19790;

const VX_JOINS: MainlineStep = {
  subjectAirlineId: AS, month: "2016-12", otherAirlineId: VX, otherCode: "VX", kind: "joins",
};

function q(over: Partial<PivotQuery>): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["year_month", "op_airline_id"],
    measures: ["seats"],
    timeFrom: "2016-06",
    timeTo: "2017-06",
    filters: [],
    sort: "seats",
    sortDesc: true,
    limit: 100,
    grouping: "mainline",
    ...over,
  };
}

// Every month 2016-06..2017-06 for AS: the boundary sits MID-series, never at an edge, so an
// implementation that marks the first or last row cannot pass.
const MONTHS = [
  "2016-06", "2016-07", "2016-08", "2016-09", "2016-10", "2016-11", "2016-12",
  "2017-01", "2017-02", "2017-03", "2017-04", "2017-05", "2017-06",
];
const AS_MONTHLY = MONTHS.map((m) => ({ year_month: m, op_airline_id: AS, seats: 1 }));

describe("stepsApply -- two operands", () => {
  it("applies to a mainline view grouped by carrier", () => {
    expect(stepsApply(q({}))).toBe(true);
  });
  it("does not apply to an operating view, even grouped by carrier", () => {
    // Catches: gating on the carrier dimension alone.
    expect(stepsApply(q({ grouping: "operating" }))).toBe(false);
  });
  it("does not apply to a mainline view without the carrier dimension", () => {
    // Catches: gating on the grouping alone -- totals there equal the operating view's.
    expect(stepsApply(q({ dimensions: ["year_month"] }))).toBe(false);
  });
});

describe("rowSteps -- the bucket rule", () => {
  it("marks only the month the step takes effect, mid-series", () => {
    // Catches: ignoring the time bucket (every AS row would be marked).
    const marked = AS_MONTHLY.filter((r) => rowSteps(q({}), r, [VX_JOINS]).length > 0);
    expect(marked.map((r) => r.year_month)).toEqual(["2016-12"]);
  });
  it("matches the subject only", () => {
    // Catches: ignoring the subject (a DL row in the step's month would be marked).
    expect(rowSteps(q({}), { year_month: "2016-12", op_airline_id: DL }, [VX_JOINS])).toEqual([]);
  });
  it("compares op_airline_id numerically", () => {
    // DuckDB INTEGER arrives as number, but a row may carry it as a string after resolution.
    expect(rowSteps(q({}), { year_month: "2016-12", op_airline_id: String(AS) }, [VX_JOINS]))
      .toEqual([VX_JOINS]);
  });
  it("marks the YEAR bucket that holds the step at year grain", () => {
    // Catches: a year bucket compared against the full month string.
    const yq = q({ dimensions: ["year", "op_airline_id"] });
    expect(rowSteps(yq, { year: 2016, op_airline_id: AS }, [VX_JOINS])).toEqual([VX_JOINS]);
    expect(rowSteps(yq, { year: 2017, op_airline_id: AS }, [VX_JOINS])).toEqual([]);
  });
  it("marks the quarter-of-year bucket that holds the step", () => {
    // Catches: quarter derived with floor instead of ceil (December is Q4, not Q3/Q5).
    const qq = q({ dimensions: ["quarter", "op_airline_id"] });
    expect(rowSteps(qq, { quarter: 4, op_airline_id: AS }, [VX_JOINS])).toEqual([VX_JOINS]);
    expect(rowSteps(qq, { quarter: 3, op_airline_id: AS }, [VX_JOINS])).toEqual([]);
  });
  it("derives the quarter by ceil for a month that is not a quarter's last", () => {
    // Catches: floor instead of ceil -- December divides evenly (12/3), so the case above cannot
    // tell them apart; November (11/3) is Q4 by ceil, Q3 by floor.
    const nov: MainlineStep = { ...VX_JOINS, month: "2016-11" };
    const qq = q({ dimensions: ["quarter", "op_airline_id"] });
    expect(rowSteps(qq, { quarter: 4, op_airline_id: AS }, [nov])).toEqual([nov]);
    expect(rowSteps(qq, { quarter: 3, op_airline_id: AS }, [nov])).toEqual([]);
  });
  it("requires every present time dimension to match", () => {
    // Catches: OR-ing the time dimensions -- year 2017 + quarter 4 is not 2016-12.
    const yqq = q({ dimensions: ["year", "quarter", "op_airline_id"] });
    expect(rowSteps(yqq, { year: 2017, quarter: 4, op_airline_id: AS }, [VX_JOINS])).toEqual([]);
    expect(rowSteps(yqq, { year: 2016, quarter: 4, op_airline_id: AS }, [VX_JOINS]))
      .toEqual([VX_JOINS]);
  });
  it("marks every row of the subject when there is no time dimension", () => {
    const nq = q({ dimensions: ["op_airline_id", "origin_airport_id"] });
    expect(rowSteps(nq, { op_airline_id: AS, origin_airport_id: 1 }, [VX_JOINS])).toEqual([
      VX_JOINS,
    ]);
    expect(rowSteps(nq, { op_airline_id: DL, origin_airport_id: 1 }, [VX_JOINS])).toEqual([]);
  });
  it("marks nothing on an operating view", () => {
    // Catches: rowSteps not consulting stepsApply (pinned at the call the page makes).
    expect(rowSteps(q({ grouping: "operating" }), AS_MONTHLY[6], [VX_JOINS])).toEqual([]);
  });
});

describe("stepPhrase", () => {
  const base = { subjectAirlineId: VX, month: "2016-12", otherAirlineId: AS, otherCode: "AS" };
  it.each([
    ["joins", { ...VX_JOINS }, "VX joins 2016-12"],
    ["leaves", { ...VX_JOINS, month: "2018-04", kind: "leaves" as const }, "VX leaves 2018-04"],
    ["rolls_up", { ...base, kind: "rolls_up" as const }, "counted under AS from 2016-12"],
    [
      "rolls_out",
      { ...base, month: "2018-04", kind: "rolls_out" as const },
      "counted as itself from 2018-04",
    ],
  ])("%s", (_k, step, phrase) => {
    expect(stepPhrase(step as MainlineStep)).toBe(phrase);
  });
  it("falls back to the airline id when the code is unresolved -- never a dash", () => {
    expect(stepPhrase({ ...VX_JOINS, otherCode: null })).toBe(`${VX} joins 2016-12`);
  });
});

describe("rowNote", () => {
  it("joins every matching step into one label", () => {
    const leaves: MainlineStep = {
      ...VX_JOINS,
      otherAirlineId: 1,
      otherCode: "ZZ",
      kind: "leaves",
    };
    expect(rowNote(q({}), AS_MONTHLY[6], [VX_JOINS, leaves])).toBe(
      "Group composition changes: VX joins 2016-12; ZZ leaves 2016-12",
    );
  });
  it("is null for an unmarked row", () => {
    expect(rowNote(q({}), AS_MONTHLY[0], [VX_JOINS])).toBeNull();
  });
});

describe("stepsBySubject -- the foot list", () => {
  const DL_STEP: MainlineStep = { ...VX_JOINS, subjectAirlineId: DL, otherCode: "XX" };
  it("lists steps only for subjects present in the result", () => {
    // Catches: listing every step in the window (DL is not in these rows).
    expect(stepsBySubject(q({}), AS_MONTHLY, [VX_JOINS, DL_STEP])).toEqual([
      { subjectAirlineId: AS, phrases: ["VX joins 2016-12"] },
    ]);
  });
  it("merges one subject's consecutive steps into one entry, in the query's order", () => {
    // Catches: pushing a new entry per step (AS would appear twice) and any reordering.
    const as_leaves: MainlineStep = { ...VX_JOINS, month: "2018-04", kind: "leaves" };
    const rows = [...AS_MONTHLY, { year_month: "2016-12", op_airline_id: DL, seats: 1 }];
    expect(stepsBySubject(q({}), rows, [VX_JOINS, as_leaves, DL_STEP])).toEqual([
      { subjectAirlineId: AS, phrases: ["VX joins 2016-12", "VX leaves 2018-04"] },
      { subjectAirlineId: DL, phrases: ["XX joins 2016-12"] },
    ]);
  });
  it("lists steps regardless of the time bucket (a no-time view needs them most)", () => {
    expect(stepsBySubject(q({}), [AS_MONTHLY[0]], [VX_JOINS])).toEqual([
      { subjectAirlineId: AS, phrases: ["VX joins 2016-12"] },
    ]);
  });
  it("is empty when steps do not apply", () => {
    expect(stepsBySubject(q({ grouping: "operating" }), AS_MONTHLY, [VX_JOINS])).toEqual([]);
  });
});
