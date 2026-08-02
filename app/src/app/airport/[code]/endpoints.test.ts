import { describe, expect, it } from "vitest";
import {
  airportTotals,
  airportTrafficQuery,
  carrierRows,
  fetchAirportMix,
  toEndpointRows,
  type EndpointRow,
} from "@/app/airport/[code]/endpoints";
import { dataAsOf } from "@/lib/db";

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
// plausibly, and is silently about half the airport.
//
// Through M6 the OR was assembled in TypeScript, as inclusion-exclusion over three pivots, and
// this file's tests exercised that arithmetic directly (a row seen only on the arrival side, a
// row seen on both). M7 Task 3 replaced it with the first-class `endpoint_airport_id` filter
// (M7 Tasks 1-2): the OR, and the same-airport de-duplication, now happen in SQL, on ONE pivot.
// What TypeScript still has to do is recover, per returned row, WHICH end is the airport and
// which is "the other one" -- `otherEndpoint`/`toEndpointRows` -- since the vocabulary has no
// CASE-shaped "other endpoint" column. These tests are that function's replacement for the old
// inclusion-exclusion suite: same bug class (an airport is both endpoints), tested at the new
// locus of the logic.
describe("the other-endpoint airport, derived per row", () => {
  it("reads the destination as the other endpoint on a departure", () => {
    // SEA -> PDX: origin is the subject airport, so the other endpoint is the destination.
    const rows = toEndpointRows(
      [{ op_airline_id: 19930, origin_airport_id: SEA, dest_airport_id: PDX, seats: 10 }],
      String(SEA),
    );
    expect(rows[0].endpointId).toBe(PDX);
    expect(rows[0].seats).toBe(10);
  });

  it("reads the origin as the other endpoint on an arrival", () => {
    // LAX -> SEA: dest is the subject airport, so the other endpoint is the origin -- an
    // origin-only reading of this exact row would miss it (and this repo's whole reason for
    // being both endpoints) entirely.
    const rows = toEndpointRows(
      [{ op_airline_id: 19930, origin_airport_id: LAX, dest_airport_id: SEA, seats: 5 }],
      String(SEA),
    );
    expect(rows[0].endpointId).toBe(LAX);
  });

  it("reads the airport itself as the other endpoint on a same-airport filing", () => {
    // Measured: fct_segment_month really carries origin = dest rows -- 18 at SEA alone over
    // the trailing 12 months, 12,646 seats (docs/data/invariants.md § Route identity has the
    // full window x quarantine table). Both columns equal the subject airport, so either
    // branch of `otherEndpoint` must return it, not throw and not return undefined.
    const rows = toEndpointRows(
      [{ op_airline_id: 20304, origin_airport_id: SEA, dest_airport_id: SEA, seats: 7 }],
      String(SEA),
    );
    expect(rows[0].endpointId).toBe(SEA);
  });

  it("leaves both directions of a route as separate rows for the caller to sum", () => {
    // The old union collapsed SEA->PDX and PDX->SEA into one row by summing at the union
    // step. There is no union step now: the pivot's own GROUP BY (carrier, origin, dest) keeps
    // them as two rows sharing one endpointId, and carrierRows/airportTotals do the summing
    // (see the "aggregating" describe below) -- so this function must NOT try to fold them.
    const rows = toEndpointRows(
      [
        { op_airline_id: 19930, origin_airport_id: SEA, dest_airport_id: PDX, seats: 10 },
        { op_airline_id: 19930, origin_airport_id: PDX, dest_airport_id: SEA, seats: 7 },
      ],
      String(SEA),
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.endpointId === PDX)).toBe(true);
    expect(rows.reduce((a, r) => a + r.seats, 0)).toBe(17);
  });
});

describe("the traffic query", () => {
  it("filters on endpoint_airport_id, not on a single direction", () => {
    // The mutant this guards: swapping the filter to origin_airport_id (or dest_airport_id)
    // reads half the airport, and every OTHER assertion in this file still passes because
    // nothing else here touches the query shape -- only the warehouse test and page.test.tsx's
    // full render exercise the actual number.
    const q = airportTrafficQuery(SEA, "2025-05", "2026-04", 5000);
    expect(q.filters).toEqual([["endpoint_airport_id", [String(SEA)]]]);
    expect(q.dimensions).toEqual(["op_airline_id", "origin_airport_id", "dest_airport_id"]);
  });
});

// fetchAirportMix is ONE `endpoint_airport_id`-filtered pivot as of M7 Task 3 (no union), and
// nothing about the rendered chart can see a 35,088-seat error in a 545-million-seat total. So
// it is checked here, against the warehouse, where the exact figure is available. Measured for
// SEA (14747) over 2015-01..2026-04:
//
//   seats   origin OR dest 545,623,424   origin only 272,924,959   naive origin + dest 545,658,512
//   cells   2,886 distinct (month, aircraft type) groups
//
// These figures are unmoved from the M4d-era three-pivot union: the (month, aircraft type)
// grain never carried a direction, so collapsing three pivots into one changes nothing about
// what this grain counts. A live-database test rather than a fixture, for the reason
// lib/resolve.ts's header gives: this codebase has no mocks.
describe("the chart's mix, against the warehouse", () => {
  it("totals both endpoints, with same-airport filings counted once", async () => {
    const asOf = await dataAsOf();
    const mix = await fetchAirportMix(14747, "2015-01", asOf);
    expect(mix.rows.reduce((a, r) => a + r.seats, 0)).toBe(545623424);
    expect(mix.rows.reduce((a, r) => a + r.departures, 0)).toBe(3916501);
    expect(mix.rows.length).toBe(2886);
    expect(mix.truncated).toBe(false);
  });

  it("survives a truncated result rather than 500ing under a 30-day cache", async () => {
    // The real limit is 10,000 and the measured worst case is 4,118 (ORD, below), so this
    // branch is unreachable from production data -- which is exactly why the limit is an
    // argument.
    const asOf = await dataAsOf();
    const mix = await fetchAirportMix(14747, "2015-01", asOf, 5);
    expect(mix.truncated).toBe(true);
    expect(mix.rows.length).toBeGreaterThan(0);
  });

  it("leaves the WORST case in the database inside the row limit", async () => {
    // The headroom assertion, so a BTS refresh that approaches the bound fails a TEST rather
    // than degrading a page -- the treatment MAX_SLUG_SEPARATORS already gets. ORD (13930), not
    // ATL: measured (month, aircraft type) group count over 2015-01..2026-04 is 4,118 at ORD,
    // against ATL's 3,592 and SEA's 2,886 -- checked against the 25 busiest airports by
    // trailing-12 segment-row count (M7 Task 3), not assumed from ORD alone.
    const asOf = await dataAsOf();
    const mix = await fetchAirportMix(13930, "2015-01", asOf);
    expect(mix.truncated).toBe(false);
    expect(mix.rows.length).toBe(4118);
  });
});

describe("aggregating the traffic rows", () => {
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
