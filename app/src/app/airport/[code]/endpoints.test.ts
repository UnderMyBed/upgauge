import { describe, expect, it } from "vitest";
import { addSum } from "@/lib/nullSum";
import {
  airportCarrierMonthsQuery,
  airportTotals,
  airportTrafficQuery,
  carrierRows,
  fetchAirportMix,
  toEndpointRows,
  type EndpointRow,
} from "@/app/airport/[code]/endpoints";
import { belowFloor } from "@/lib/floor";
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
    quarantineReasons: null,
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
    // Per row, not summed: the claim is that this function does NOT fold the two directions,
    // and a total of 17 is also what a folding implementation returning one row would give.
    expect(rows.map((r) => r.seats)).toEqual([10, 7]);
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
// nothing about the rendered chart can see a 35,754-seat error in a 550-million-seat total. So
// it is checked here, against the warehouse, where the exact figure is available. Measured for
// SEA (14747) over 2015-01..2026-05:
//
//   seats   origin OR dest 550,395,521   origin only 275,312,624   naive origin + dest 550,431,275
//   cells   2,910 distinct (month, aircraft type) groups
//
// THE MEASURES ARE QUARANTINE-FILTERED AND THE GROUPING IS NOT, and the two must not be
// conflated: every meta_pivot_measures expression carries `FILTER (WHERE NOT is_quarantined)`,
// while the GROUP BY sees every row -- so a (month, type) pair that exists only in quarantined
// rows is still a returned row, contributing nothing to any total. That is the fact view's
// "retain the row, flag it" rule reaching the pivot, not an inconsistency.
//
// At SEA it is measurable in both directions: 13 quarantined rows carry 16 departures and ZERO
// seats, so the departures total is 3,949,177 rather than the raw 3,949,193 while seats are
// identical either way, and the cell count is 2,910 rather than the 2,904 a quarantine-filtered
// grouping would give. A re-derivation that applies the filter to both, or to neither, agrees
// with this fixture on seats and disagrees on one of the other two. ORD (4,150) and ATL (3,619)
// are identical under both filters, so only a SEA fixture can catch it.
//
// These figures are unmoved from the M4d-era three-pivot union: the (month, aircraft type)
// grain never carried a direction, so collapsing three pivots into one changes nothing about
// what this grain counts. A live-database test rather than a fixture, for the reason
// lib/resolve.ts's header gives: this codebase has no mocks.
describe("the chart's mix, against the warehouse", () => {
  it("totals both endpoints, with same-airport filings counted once", async () => {
    const asOf = await dataAsOf();
    const mix = await fetchAirportMix(14747, "2015-01", asOf);
    // SUM semantics (#121): `MixRow.seats` is nullable, and `+` would coerce a NULL back to 0.
    expect(mix.rows.reduce<number | null>((a, r) => addSum(a, r.seats), null)).toBe(550395521);
    expect(mix.rows.reduce<number | null>((a, r) => addSum(a, r.departures), null)).toBe(3949177);
    expect(mix.rows.length).toBe(2910);
    expect(mix.truncated).toBe(false);
  });

  it("survives a truncated result rather than 500ing under a 30-day cache", async () => {
    // The real limit is 10,000 and the measured worst case is 4,150 (ORD, below), so this
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
    // ATL: measured (month, aircraft type) group count over 2015-01..2026-05 is 4,150 at ORD,
    // against ATL's 3,619 and SEA's 2,910 -- checked against the 25 busiest airports by
    // trailing-12 segment-row count (M7 Task 3), not assumed from ORD alone.
    const asOf = await dataAsOf();
    const mix = await fetchAirportMix(13930, "2015-01", asOf);
    expect(mix.truncated).toBe(false);
    expect(mix.rows.length).toBe(4150);
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
    const rows = carrierRows(twoEndpoints, new Map());
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
    ],
    new Map(),);
    expect(rows.map((r) => r.op_airline_id)).toEqual([19930, 20304]);
  });

  it("leaves a derived measure null rather than reporting zero when the denominator is zero", () => {
    // Absence is not a measurement of zero (lib/format.ts's opening rule). A carrier that
    // filed no performed departures has an UNKNOWN gauge; 0.0 would be a claim about metal.
    const rows = carrierRows([row({ carrierId: 19930, endpointId: PDX, seats: 0, departures: 0 })], new Map());
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

// ---------------------------------------------------------------------------------------
// Issue #118: a wholly-quarantined group sums to NULL, and NULL is not zero.
//
// Every measure in meta_pivot_measures is `SUM(x) FILTER (WHERE NOT is_quarantined)`
// (sql/02_marts/301_meta_pivot_measures.sql:21-32), and a SUM over zero passing rows returns
// NULL. So a (carrier, origin, dest) group whose every filing was quarantined arrives here
// with NULL measures meaning "nothing filed here can be trusted" -- never "nothing flew".
//
// THE SECOND COERCION IS THE ONE THAT HIDES. Deleting `?? 0` from toEndpointRows is not the
// fix on its own: `carrierRows` and `airportTotals` FOLD these values, and JS `+` coerces
// null to 0 (`null + 5` is 5; `[null].reduce((a, b) => a + b, 0)` is 0). A fold left on `+`
// silently reinstates the defect while a test on the mapper alone stays green -- which is why
// "keeps the NULL" below is followed by tests that go through the fold.
//
// THE FOLD'S SEMANTIC IS SUM()'s, mirroring the aggregate these values came from: a NULL
// contributes nothing, and the sum of NO known values is NULL. Poisoning a carrier's whole row
// because one of its thirty groups was quarantined would be the opposite error, and the page
// already discloses the excluded rows by count and reason.
//
// Measured 2026-08-27 against upgauge.duckdb at max(year_month) = 2026-05, trailing 12
// (2025-06..2026-05), at the segment grain this page queries: 21 wholly-quarantined
// (carrier x origin x dest) groups, 0 partially NULL. Folded to the grain the table actually
// RENDERS -- one row per operating carrier -- that is 5 unknowable rows on 5 pages (A18, JZM,
// OQZ, STT, STX), and on A18, JZM and OQZ it is the airport's entire window, so the stat strip
// is unknowable too. docs/data/invariants.md carries the rule and the figures.
describe("an unknowable sum is not a zero", () => {
  it("keeps a NULL measure NULL rather than coercing it to 0", () => {
    // MUTANT: restore `Number(r.seats ?? 0)` in toEndpointRows -> this test goes red.
    const rows = toEndpointRows(
      [
        {
          op_airline_id: 20333,
          origin_airport_id: LAX,
          dest_airport_id: SEA,
          seats: null,
          passengers: null,
          departures_performed: null,
          quarantined_rows: 1,
        },
      ],
      String(SEA),
    );
    expect(rows[0].seats).toBeNull();
    expect(rows[0].passengers).toBeNull();
    expect(rows[0].departures).toBeNull();
    // A COUNT is not a measure. `count(*) FILTER (WHERE is_quarantined)`
    // (sql/03_queries/pivot_segment.sql:20) cannot return NULL, and 0 there means "none were
    // quarantined" -- a real measurement, not an absence. It keeps its `?? 0` deliberately.
    expect(rows[0].quarantinedRows).toBe(1);
  });

  it("sums a carrier whose every group was quarantined to NULL, not to 0", () => {
    // THE BUG THIS EXISTS TO CATCH, and the one the mapper test above cannot see: the fold.
    // MUTANT: replace addSum's null handling with plain `a + b` -> this goes red while
    // "keeps a NULL measure NULL" stays green, which is the whole point of having both.
    const rows = carrierRows([
      row({ carrierId: 20333, endpointId: LAX, seats: null, passengers: null, departures: null }),
      row({ carrierId: 20333, endpointId: PDX, seats: null, passengers: null, departures: null }),
    ],
    new Map(),);
    expect(rows.length).toBe(1);
    expect(rows[0].seats).toBeNull();
    expect(rows[0].passengers).toBeNull();
    expect(rows[0].departures_performed).toBeNull();
  });

  it("reports the KNOWN sum for a carrier with one unknowable group among several", () => {
    // The over-correction guard. SQL NULL-poisoning semantics (`NULL + 5 = NULL`) would erase
    // 24 of the 29 affected pages' real figures; SUM() semantics keep them, and the excluded
    // filings are disclosed by the gutter and the foot's quarantined count instead.
    // MUTANT: make addSum return null when EITHER side is null -> this goes red.
    const rows = carrierRows([
      row({ carrierId: 19930, endpointId: PDX, seats: 100, passengers: 90, departures: 4 }),
      row({ carrierId: 19930, endpointId: LAX, seats: null, passengers: null, departures: null }),
    ],
    new Map(),);
    expect(rows[0].seats).toBe(100);
    expect(rows[0].passengers).toBe(90);
    expect(rows[0].departures_performed).toBe(4);
  });

  it("leaves the airport's totals unknowable when every row it has is unknowable", () => {
    // A18, JZM and OQZ, measured: one pivot row each, wholly quarantined. The stat strip is
    // fed by this function, so under the bug the whole page reads 0 seats / 0 departures.
    // MUTANT: restore `rows.reduce((a, r) => a + r.seats, 0)` -> this goes red.
    const totals = airportTotals(
      [
        row({
          carrierId: 20333,
          endpointId: LAX,
          seats: null,
          passengers: null,
          departures: null,
          quarantinedRows: 1,
        }),
      ],
      SEA,
    );
    expect(totals.seats).toBeNull();
    expect(totals.passengers).toBeNull();
    expect(totals.departures).toBeNull();
    // The counts are still real facts about what was FILED: one carrier filed one route.
    expect(totals.carriers).toBe(1);
    expect(totals.destinations).toBe(1);
    expect(totals.quarantinedRows).toBe(1);
  });

  it("totals the known rows when only some of the airport's rows are unknowable", () => {
    // MUTANT: make addSum return null when either side is null -> this goes red.
    const totals = airportTotals(
      [
        row({ carrierId: 19930, endpointId: PDX, seats: 100, passengers: 90, departures: 4 }),
        row({ carrierId: 20333, endpointId: LAX, seats: null, passengers: null, departures: null }),
      ],
      SEA,
    );
    expect(totals.seats).toBe(100);
    expect(totals.passengers).toBe(90);
    expect(totals.departures).toBe(4);
  });

  it("sorts an unknowable carrier BELOW one that measurably flew nothing", () => {
    // THE FIXTURE HAS TO CARRY BOTH KINDS OR IT CANNOT FAIL. A genuine 0 (the carrier filed,
    // and carried nothing) and an unknowable NULL are different findings, and `?? 0` in the
    // comparator collapses them into a tie whose winner is then decided by insertion order --
    // the "right answer by accident of row order" trap CLAUDE.md names. With only a NULL
    // carrier in the fixture, every comparator agrees and the test is worthless.
    // Mirrors DuckDB's own DESC ordering, which places NULLS LAST.
    // MUTANT: `(b.seats ?? 0) - (a.seats ?? 0)` -> ties 20333 with 19930, order becomes
    // insertion order, and this goes red.
    const rows = carrierRows([
      row({ carrierId: 20333, endpointId: LAX, seats: null }),
      row({ carrierId: 19930, endpointId: PDX, seats: 0 }),
      row({ carrierId: 20304, endpointId: PDX, seats: 50 }),
    ],
    new Map(),);
    expect(rows.map((r) => r.op_airline_id)).toEqual([20304, 19930, 20333]);
  });

  it("leaves a derived measure null rather than NaN when its inputs are unknowable", () => {
    // `ratio()` typed to `number` reads `null === 0` as false and returns `null / null` --
    // NaN, which formatGauge renders as the string "NaN" on a page under a DATA AS OF badge.
    // MUTANT: drop the null guard from ratio() -> this goes red with NaN, not with a number.
    const rows = carrierRows([
      row({ carrierId: 20333, endpointId: LAX, seats: null, passengers: null, departures: null }),
    ],
    new Map(),);
    expect(rows[0].load_factor).toBeNull();
    expect(rows[0].avg_gauge).toBeNull();
    const totals = airportTotals(
      [row({ carrierId: 20333, endpointId: LAX, seats: null, passengers: null, departures: null })],
      SEA,
    );
    expect(totals.loadFactor).toBeNull();
    expect(totals.avgGauge).toBeNull();
  });

  it("carries each row's quarantine reason through the fold, de-duplicated", () => {
    // The em dash says "we cannot say"; the gutter says WHY. /explore and the other three
    // entity pages hand DataTable raw pivot rows, so `quarantine_reasons` reaches ReasonCode's
    // `detail` and the glyph's title reads "Quarantined -- failed an invariant: zero_seats".
    // /airport is the one page that rebuilds its rows in TypeScript, so anything this function
    // does not carry is dropped. Folding several groups into one carrier row means unioning
    // their reasons, matching the `string_agg(DISTINCT quarantine_reason, ',')` they came from
    // (sql/03_queries/pivot_segment.sql:21-22).
    // MUTANT: drop quarantine_reasons from carrierRows' output -> this goes red.
    const rows = carrierRows([
      row({ carrierId: 20333, endpointId: LAX, seats: null, quarantineReasons: "zero_seats" }),
      row({ carrierId: 20333, endpointId: PDX, seats: null, quarantineReasons: "load_factor_gt_1" }),
      row({ carrierId: 20333, endpointId: SEA, seats: null, quarantineReasons: "zero_seats" }),
    ],
    new Map(),);
    expect(rows[0].quarantine_reasons).toBe("zero_seats,load_factor_gt_1");
  });

  it("reads the reason off the pivot row rather than inventing one", () => {
    // MUTANT: drop quarantineReasons from toEndpointRows -> this goes red.
    const rows = toEndpointRows(
      [
        {
          op_airline_id: 20333,
          origin_airport_id: LAX,
          dest_airport_id: SEA,
          seats: null,
          quarantined_rows: 1,
          quarantine_reasons: "zero_seats",
        },
      ],
      String(SEA),
    );
    expect(rows[0].quarantineReasons).toBe("zero_seats");
  });
});

// ---------------------------------------------------------------------------------------
// THE FLOOR'S DENOMINATOR ON A FOLDED ROW (#134).
//
// `carrierRows` folds many (carrier, origin, dest) pivot groups into ONE carrier row.
// Departures fold by SUM; a DISTINCT-MONTH COUNT DOES NOT FOLD AT ALL. The truth for the
// folded row is the UNION of the groups' month sets, and neither `max()` (a lower bound) nor
// `sum()` (a wild overcount) recovers it.
//
// Measured across every /airport page in the trailing 12 (3,457 folded carrier rows):
// max() gives the wrong month count on 342 of them and the WRONG BELOW-FLOOR VERDICT on 18;
// sum() flips 1,186. So the count comes from a SECOND pivot grouped by carrier alone, where
// SQL does the DISTINCT over the union directly, and these tests are what refuse the folds.
// ---------------------------------------------------------------------------------------
describe("the active-month count a folded carrier row carries", () => {
  it("takes the carrier's own count, never a fold of its endpoints'", () => {
    // THE DISCRIMINATING FIXTURE. One carrier, two endpoints, DISJOINT month sets: six months
    // each, twelve between them. 360 departures over twelve months is exactly 30/month --
    // ON the floor, so scored.
    //   max()  -> 360/6  = 60/mo   scored (right answer, wrong reason -- see the second test)
    //   sum()  -> 360/12 ... equals the union here by coincidence of 6+6, so this fixture is
    //            deliberately paired with the next one, where the two diverge.
    const rows = [
      row({ carrierId: 19930, endpointId: PDX, seats: 6000, departures: 180 }),
      row({ carrierId: 19930, endpointId: LAX, seats: 6000, departures: 180 }),
    ];
    const out = carrierRows(rows, new Map([["19930", 12]]));
    expect(out).toHaveLength(1);
    expect(out[0].departures_performed).toBe(360);
    expect(out[0].active_months).toBe(12);
  });

  it("is the union, so a carrier flying two half-years reads as twelve months, not six", () => {
    // The verdict-flipping shape, in miniature: 300 departures.
    //   union 12 months -> 25.0/mo -> BELOW FLOOR
    //   max()  6 months -> 50.0/mo -> scored     <- the wrong answer 18 real rows would get
    const rows = [
      row({ carrierId: 20304, endpointId: PDX, seats: 5000, departures: 150 }),
      row({ carrierId: 20304, endpointId: LAX, seats: 5000, departures: 150 }),
    ];
    const out = carrierRows(rows, new Map([["20304", 12]]));
    expect(out[0].departures_performed).toBe(300);
    expect(out[0].active_months).toBe(12);
    // Stated as the verdict, not just the inputs -- this is the fact the page renders.
    expect(belowFloor(out[0].departures_performed as number, out[0].active_months as number)).toBe(true);
  });

  it("makes no claim for a carrier the count query did not return", () => {
    // Absence stays absence rather than becoming a fabricated denominator: a carrier with no
    // entry gets no `active_months`, and `DataTable` then marks nothing about the floor.
    const out = carrierRows([row({ carrierId: 19790, endpointId: PDX, departures: 5 })], new Map());
    expect(out[0].active_months).toBeUndefined();
    expect(belowFloor(out[0].departures_performed as number, out[0].active_months as number)).toBe(false);
  });
});

describe("the carrier-months query", () => {
  it("asks the same question of the same rows as the traffic query, grouped only by carrier", () => {
    // THE DENOMINATOR MUST DESCRIBE THE SAME QUERY AS THE NUMERATOR. A different window or a
    // different filter here would divide one query's departures by another query's months --
    // a ratio of two different populations, which is the failure `sumTotals`' ratio-of-sums
    // rule exists to prevent one level up. Asserted field by field against the real traffic
    // query rather than restated as literals.
    const traffic = airportTrafficQuery(SEA, "2025-06", "2026-05", 5000);
    const months = airportCarrierMonthsQuery(SEA, "2025-06", "2026-05");
    expect(months.filters).toEqual(traffic.filters);
    expect(months.timeFrom).toBe(traffic.timeFrom);
    expect(months.timeTo).toBe(traffic.timeTo);
    expect(months.grain).toBe(traffic.grain);
    expect(months.grouping).toBe(traffic.grouping);
    // ...and differs on exactly one axis: it groups by carrier ALONE, which is what makes the
    // DISTINCT month count the union over that carrier's endpoints rather than a per-pair one.
    expect(months.dimensions).toEqual(["op_airline_id"]);
  });
});
