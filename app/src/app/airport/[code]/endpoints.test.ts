import { describe, expect, it } from "vitest";
import {
  airportTotals,
  carrierRows,
  fetchAirportMix,
  inclusionExclusion,
  unionMix,
  unionSides,
  type EndpointRow,
} from "@/app/airport/[code]/endpoints";
import { dataAsOf } from "@/lib/db";
import type { MixRow } from "@/lib/chart/aircraftMix";

/** SEA. Resolved, never hard-coded, everywhere it matters -- pinned here only because these
 * are synthetic rows with no database behind them. */
const SEA = 14747;
const PDX = 14057;
const LAX = 12892;

function row(p: Partial<EndpointRow> & { carrierId: number; endpointId: number }): EndpointRow {
  return {
    seats: 0,
    passengers: 0,
    departures: 0,
    quarantinedRows: 0,
    ...p,
  };
}

// The bug this whole module exists to exclude: an airport is BOTH endpoints. A page built
// from `origin_airport_id = X` alone renders every stat, every carrier and every chart band
// plausibly, and is silently about half the airport. Each test below varies the input in the
// one way that distinguishes the two implementations -- a row that exists only on the
// arrival side, and a row that exists on both.
describe("origin-OR-dest, as inclusion-exclusion", () => {
  it("counts an arrival-only filing that an origin-only query never sees", () => {
    // LAX -> SEA with no SEA -> LAX counterpart in the window. Under `origin = SEA` this row
    // does not exist at all, so the union must be 15, not 10.
    const union = unionSides(
      [row({ carrierId: 19930, endpointId: PDX, seats: 10 })],
      [row({ carrierId: 19930, endpointId: LAX, seats: 5 })],
      [],
    );
    expect(union.reduce((a, r) => a + r.seats, 0)).toBe(15);
    expect(union.length).toBe(2);
  });

  it("sums the two directions of one route rather than keeping the larger", () => {
    // SEA->PDX and PDX->SEA are two different filings of the same route. Keyed on
    // (carrier, endpoint) they collide, so an implementation that Map.set()s instead of
    // accumulating silently drops one direction -- and still passes the test above.
    const union = unionSides(
      [row({ carrierId: 19930, endpointId: PDX, seats: 10 })],
      [row({ carrierId: 19930, endpointId: PDX, seats: 7 })],
      [],
    );
    expect(union.length).toBe(1);
    expect(union[0].seats).toBe(17);
  });

  it("counts a same-airport filing ONCE, not twice", () => {
    // Measured, and the reason this third query exists at all: fct_segment_month really does
    // carry origin = dest rows -- 3,187 of them over the trailing 12 months across 359
    // airports (601,573 seats), 18 at SEA alone (12,646 seats). They satisfy `origin = SEA`
    // AND `dest = SEA`, so origin + dest double-counts them: SEA's real 53,373,806 seats
    // becomes 53,386,452. The design spec asserts these rows "do not exist"; they do.
    const union = unionSides(
      [
        row({ carrierId: 19930, endpointId: PDX, seats: 10 }),
        row({ carrierId: 20304, endpointId: SEA, seats: 7 }),
      ],
      [row({ carrierId: 20304, endpointId: SEA, seats: 7 })],
      [row({ carrierId: 20304, endpointId: SEA, seats: 7 })],
    );
    expect(union.reduce((a, r) => a + r.seats, 0)).toBe(17);
    expect(union.find((r) => r.carrierId === 20304)?.seats).toBe(7);
  });

  it("refuses an overlap row it never saw on either side", () => {
    // `both` is by construction a subset of origin AND of dest. If it ever isn't, the
    // arithmetic below zero is silent: a negative seat count formats as a perfectly ordinary
    // number under a DATA AS OF badge. Fail loudly instead.
    expect(() =>
      inclusionExclusion(
        { origin: [], dest: [], both: [row({ carrierId: 20304, endpointId: SEA, seats: 7 })] },
        (r) => `${r.carrierId}\u0000${r.endpointId}`,
        ["seats"],
      ),
    ).toThrow(/overlap row/i);
  });

  it("skips an overlap row a truncated side no longer carries, rather than 500ing", () => {
    // Each side is a LIMIT-ed pivot, so a truncated side really can drop a row the overlap
    // query still returns -- found by the /airport truncation test, which threw here before
    // `partial` existed. Under truncation the row was counted at most ONCE, so the answer is
    // 7, not 0: subtracting anyway would show an empty carrier row on a page that is already
    // disclosing that its totals are partial.
    const union = unionSides(
      [row({ carrierId: 20304, endpointId: SEA, seats: 7 })],
      [],
      [row({ carrierId: 20304, endpointId: SEA, seats: 7 })],
      { partial: true },
    );
    expect(union.length).toBe(1);
    expect(union[0].seats).toBe(7);
  });

  it("still subtracts a full overlap row when nothing was truncated", () => {
    // `partial` must not become a blanket "skip the third term": with both sides intact the
    // subtraction is exactly what stops the double count.
    const union = unionSides(
      [row({ carrierId: 20304, endpointId: SEA, seats: 7 })],
      [row({ carrierId: 20304, endpointId: SEA, seats: 7 })],
      [row({ carrierId: 20304, endpointId: SEA, seats: 7 })],
      { partial: true },
    );
    expect(union[0].seats).toBe(7);
  });

  it("applies the same arithmetic to the chart's (month, type) cells", () => {
    // The chart is the same union at a different grain. A mix built from origin alone draws
    // a plausible stacked area that is half the airport, which no eye can catch.
    const mix = (p: Partial<MixRow> & { month: string; code: string }): MixRow => ({
      label: p.code,
      seats: 0,
      departures: 0,
      ...p,
    });
    const union = unionMix(
      [mix({ month: "2025-05", code: "614", seats: 100, departures: 1 })],
      [
        mix({ month: "2025-05", code: "614", seats: 90, departures: 1 }),
        mix({ month: "2025-05", code: "888", seats: 50, departures: 1 }),
      ],
      [mix({ month: "2025-05", code: "614", seats: 10, departures: 1 })],
    );
    const byCode = new Map(union.map((r) => [r.code, r]));
    expect(byCode.get("614")?.seats).toBe(180);
    expect(byCode.get("614")?.departures).toBe(1);
    expect(byCode.get("888")?.seats).toBe(50);
  });
});

// The chart's union is a SECOND call site of the same arithmetic, fed by three different
// queries at a different grain, and nothing about the rendered chart can see a 35,088-seat
// error in a 545-million-seat total. So it is checked here, against the warehouse, where the
// exact figure is available. Measured for SEA (14747) over 2015-01..2026-04:
//
//   seats   origin OR dest 545,623,424   origin only 272,924,959   naive origin + dest 545,658,512
//   cells   2,886 distinct (month, aircraft type) groups
//
// A live-database test rather than a fixture, for the reason lib/resolve.ts's header gives:
// this codebase has no mocks, and the property being checked IS the relationship between three
// real query results.
describe("the chart's union, against the warehouse", () => {
  it("totals both endpoints, with same-airport filings counted once", async () => {
    const asOf = await dataAsOf();
    const mix = await fetchAirportMix(14747, "2015-01", asOf);
    expect(mix.reduce((a, r) => a + r.seats, 0)).toBe(545623424);
    expect(mix.reduce((a, r) => a + r.departures, 0)).toBe(3916501);
    expect(mix.length).toBe(2886);
  });
});

describe("aggregating the union", () => {
  // Ratios of sums, never averages of rows (CLAUDE.md's #1 rule). The fixture is chosen so
  // the two answers are far apart: per-endpoint load factors 0.90 and 0.50 average to 0.70,
  // while the honest 540/1000 is 0.54. An implementation that averaged would show 70%.
  const twoEndpoints = [
    row({ carrierId: 19930, endpointId: PDX, seats: 100, passengers: 90, departures: 1 }),
    row({ carrierId: 19930, endpointId: LAX, seats: 900, passengers: 450, departures: 9 }),
  ];

  it("computes a carrier's load factor from summed passengers and seats", () => {
    const rows = carrierRows(twoEndpoints);
    expect(rows.length).toBe(1);
    expect(rows[0].load_factor).toBeCloseTo(0.54, 10);
    expect(rows[0].avg_gauge).toBeCloseTo(100, 10);
    expect(rows[0].seats).toBe(1000);
  });

  it("computes the airport's load factor from summed passengers and seats", () => {
    const totals = airportTotals(twoEndpoints, SEA);
    expect(totals.loadFactor).toBeCloseTo(0.54, 10);
    expect(totals.avgGauge).toBeCloseTo(100, 10);
  });

  it("orders the carriers table by seats, descending", () => {
    const rows = carrierRows([
      row({ carrierId: 20304, endpointId: PDX, seats: 5 }),
      row({ carrierId: 19930, endpointId: PDX, seats: 50 }),
    ]);
    expect(rows.map((r) => r.op_airline_id)).toEqual([19930, 20304]);
  });

  it("leaves a derived measure null rather than reporting zero when the denominator is zero", () => {
    // Absence is not a measurement of zero (lib/format.ts's opening rule). A carrier that
    // filed no performed departures has an UNKNOWN gauge; 0.0 would be a claim about metal.
    const rows = carrierRows([row({ carrierId: 19930, endpointId: PDX, seats: 0, departures: 0 })]);
    expect(rows[0].load_factor).toBeNull();
    expect(rows[0].avg_gauge).toBeNull();
  });

  it("counts destinations as the OTHER endpoints, excluding the airport itself", () => {
    // The 18 same-airport filings at SEA are real activity and belong in the seat total, but
    // SEA is not one of its own destinations. Measured at SEA over the trailing 12 months:
    // 144 distinct other-endpoint ids including itself, 143 excluding it.
    const totals = airportTotals(
      [
        row({ carrierId: 19930, endpointId: PDX, seats: 1 }),
        row({ carrierId: 19930, endpointId: LAX, seats: 1 }),
        row({ carrierId: 20304, endpointId: PDX, seats: 1 }),
        row({ carrierId: 20304, endpointId: SEA, seats: 1 }),
      ],
      SEA,
    );
    expect(totals.destinations).toBe(2);
    expect(totals.carriers).toBe(2);
  });
});
