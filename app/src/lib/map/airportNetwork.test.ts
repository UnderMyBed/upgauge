import { describe, expect, it } from "vitest";
import {
  AIRPORT_NETWORK_LIMIT,
  airportNetworkQuery,
  classifyRouteRows,
  farEndpoints,
  fetchAirportNetwork,
} from "./airportNetwork";
import { renderNetworkMap } from "./networkMap";
import type { AirportRef } from "@/lib/resolve";

const SEA_ID = 14747;
const ORD_ID = 13930;

// #114's subjects. Bettles, Venetie and Kantishna are small Alaskan airports, which is why
// nobody noticed the map claiming their service flew nothing.
const BTT_ID = 10783; // Bettles -- 16 route-grain rows, one of them the wholly-quarantined BTT-UMT
const VEE_ID = 15581; // Venetie -- the ONE airport carrying both kinds of quarantined pair
const A18_ID = 10031; // Kantishna -- whose whole trailing-12 network is one quarantined pair
const FAI_ID = 11630; // Fairbanks -- quarantined ROWS on its pairs, but no wholly-quarantined PAIR

/** The trailing 12 as of this warehouse's own `max(year_month)` (2026-05), written as a FIXED
 *  window for the reason every other figure in this file is: `trailing12From(asOf)` moves with
 *  the dataset, and a test whose window moves cannot pin a count. */
const T12_FROM = "2025-06";
const T12_TO = "2026-05";

function airport(id: number, code: string, name: string): AirportRef {
  return { id, code, name };
}

describe("farEndpoints", () => {
  it("derives the far endpoint from whichever key is not the subject", () => {
    // Catches: assuming the subject is always route_key_low. Route keys are ordered by
    // airport ID, so the subject is the LOW key for some routes and the HIGH key for
    // others -- a fixture where it is always low cannot fail this.
    const rows = [
      { route_key_low: 14747, route_key_high: 99999, seats: 10 },
      { route_key_low: 100, route_key_high: 14747, seats: 20 },
    ];
    expect(farEndpoints(rows, 14747)).toEqual([99999, 100]);
  });

  it("returns the subject itself for a same-airport row", () => {
    // Both keys equal the subject on a same-airport filing -- the far endpoint of such a row
    // IS the airport itself, matching networkMap.ts's own `a.code !== origin.code` exclusion,
    // which needs a real, comparable value here rather than undefined or NaN.
    const rows = [{ route_key_low: 13930, route_key_high: 13930, seats: 5 }];
    expect(farEndpoints(rows, 13930)).toEqual([13930]);
  });
});

describe("airportNetworkQuery", () => {
  it("filters on endpoint_airport_id and groups by the route dimension alone", () => {
    // The mutant this guards: swapping the filter to origin_airport_id (or dest_airport_id)
    // reads half the airport, exactly as endpoints.test.ts's equivalent test guards.
    const q = airportNetworkQuery(SEA_ID, "2025-05", "2026-04", AIRPORT_NETWORK_LIMIT);
    expect(q.filters).toEqual([["endpoint_airport_id", [String(SEA_ID)]]]);
    expect(q.dimensions).toEqual(["route"]);
    expect(q.grain).toBe("route");
  });
});

// Live-database tests, not fixtures, for the reason lib/resolve.ts's header gives: this
// codebase has no mocks. Figures below are measured directly against fct_route_month
// (M7 Task 8), not assumed -- see the task report for the queries that produced them.
describe("fetchAirportNetwork, against the warehouse", () => {
  it("returns null when the airport filed nothing in the window", async () => {
    // A window before the dataset's own start (2015-01) guarantees zero route-grain rows
    // without fabricating an airport_id -- SEA is real and fact-present; only the window is
    // empty. Mirrors /route's rule: a subject with nothing in the window gets no chart, never
    // a second empty-state panel.
    const result = await fetchAirportNetwork(
      airport(SEA_ID, "SEA", "Seattle-Tacoma Intl"),
      "2014-01",
      "2014-01",
    );
    expect(result).toBeNull();
  });

  it("passes the same-airport seat total through rather than discarding it", async () => {
    // Measured directly against fct_route_month: ORD's same-airport rows sum to 73,082 seats
    // over 2025-05..2026-04, the FIXED window this test queries. docs/design/system.md and
    // docs/data/invariants.md state 76,236 for the trailing 12 (2025-06..2026-05) -- a
    // different window, not a different answer. A re-pin sweep once updated this comment to
    // the trailing-12 figure while leaving the assertion on its own fixed window, which is how
    // a green test came to be documented by a number it does not assert.
    const result = await fetchAirportNetwork(
      airport(ORD_ID, "ORD", "Chicago O'Hare Intl"),
      "2025-05",
      "2026-04",
    );
    expect(result).not.toBeNull();
    expect(result!.sameAirportSeats).toBe(73082);
  });

  it("resolves exactly 268 route-grain rows for ORD, and renders 267 arcs", async () => {
    // 268 is ORD's route count over 2025-05..2026-04, the FIXED window this test queries --
    // not the trailing 12, which is 274 far-endpoints and 273 drawable (docs/data/invariants.md
    // § Route identity). One of the 268 is the same-airport row itself, which renderNetworkMap
    // must exclude from the drawn set (system.md's arc-encoding section states the same rule
    // against this same fixed window).
    const result = await fetchAirportNetwork(
      airport(ORD_ID, "ORD", "Chicago O'Hare Intl"),
      "2025-05",
      "2026-04",
    );
    expect(result!.arcs.length).toBe(268);
    const svg = renderNetworkMap(result!);
    const polylines = svg.match(/<polyline/g) ?? [];
    expect(polylines).toHaveLength(267);
  });

  it("resolves the origin's own coordinates, not only the destinations'", async () => {
    // AirportRef carries no lat/lon of its own -- fetchAirportNetwork must look the origin's
    // coordinates up exactly like every far endpoint's, or the origin marker and every arc's
    // projected start point would be [0, 0].
    const result = await fetchAirportNetwork(
      airport(ORD_ID, "ORD", "Chicago O'Hare Intl"),
      "2025-05",
      "2026-04",
    );
    expect(result!.origin.code).toBe("ORD");
    expect(result!.origin.lat).toBeCloseTo(41.98, 1);
    expect(result!.origin.lon).toBeCloseTo(-87.9, 1);
  });

  it("computes each arc's load factor from that row's own passengers and seats, never averaged", async () => {
    // The route-grain pivot already sums every carrier and month in the window into one row
    // per route, so this is the row's OWN ratio, not a further average across rows -- but the
    // computation must still be ratio-of-sums, never AVG(load_factor) (CLAUDE.md's rule,
    // enforced structurally by fct_route_month carrying no such column to average in the
    // first place).
    const result = await fetchAirportNetwork(
      airport(ORD_ID, "ORD", "Chicago O'Hare Intl"),
      "2025-05",
      "2026-04",
    );
    for (const arc of result!.arcs) {
      if (arc.departures > 0 && arc.seats > 0) {
        expect(arc.loadFactor).not.toBeNull();
        expect(arc.loadFactor).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// #114. Every measure in `meta_pivot_measures` is `SUM(x) FILTER (WHERE NOT is_quarantined)`, so
// a route pair whose every filing was quarantined sums to NULL -- "nothing here can be trusted",
// not "nothing flew". `?? 0` used to turn that into an ordinary arc reading 0 seats and 0
// departures, drawn below DEPARTURE_FLOOR as dotted and muted: "barely flown", about a pair the
// data cannot describe at all. Measured over 2025-06..2026-05: 11 such pairs, all `zero_seats`,
// every one of which PERFORMED a departure -- so the "0 departures" the map drew was not merely
// unknowable, it was contradicted by the filing behind it.
describe("classifyRouteRows", () => {
  it("throws on a partially null measure sum rather than half-counting it", () => {
    // Catches: the three measures ceasing to share ONE quarantine FILTER. If that ever happens,
    // a group with (say) real seats and a null departure count would otherwise be silently
    // counted as quarantined -- or, worse, drawn with a fabricated denominator -- instead of
    // stopping the render. Unreachable from the warehouse (0 partially-null pairs over the
    // trailing 12, measured), so only a synthetic row can prove the guard fires at all, which
    // is exactly why `classifyRouteRows` is exported.
    const rows = [{ route_key_low: 1, route_key_high: 2, seats: 100, passengers: null, departures_performed: null }];
    expect(() => classifyRouteRows(rows, [2], 1)).toThrow(/PARTIALLY null measure sum/);
  });

  it("counts a wholly-null pair as quarantined instead of drawing it", () => {
    const rows = [
      { route_key_low: 1, route_key_high: 2, seats: null, passengers: null, departures_performed: null },
      { route_key_low: 1, route_key_high: 3, seats: 90, passengers: 60, departures_performed: 5 },
    ];
    const out = classifyRouteRows(rows, [2, 3], 1);
    expect(out.quarantinedRoutes).toBe(1);
    expect(out.drawable).toEqual([{ farId: 3, seats: 90, passengers: 60, departures: 5 }]);
  });

  it("does not count a wholly-null SAME-AIRPORT filing as a route pair", () => {
    // The ordering mutant, stated as a unit: a same-airport filing is not a route the airport
    // served, whatever its quarantine state, so testing null-ness before same-airport-ness
    // inflates a count that feeds a sentence about route PAIRS.
    const rows = [
      { route_key_low: 7, route_key_high: 7, seats: null, passengers: null, departures_performed: null },
    ];
    const out = classifyRouteRows(rows, [7], 7);
    expect(out.quarantinedRoutes).toBe(0);
    expect(out.drawable).toEqual([]);
    expect(out.sameAirportSeats).toBe(0);
  });

  it("keeps a same-airport row with real numbers in the drawable set, seats and all", () => {
    // Not a filter: `renderNetworkMap` owns the same-airport exclusion (drawableSegments), and
    // `networkMap.ts`'s contract permits the caller to pass such a row through. Removing it here
    // would silently change the node/point set the golden fixture pins.
    const rows = [{ route_key_low: 7, route_key_high: 7, seats: 40, passengers: 30, departures_performed: 2 }];
    const out = classifyRouteRows(rows, [7], 7);
    expect(out.sameAirportSeats).toBe(40);
    expect(out.drawable).toHaveLength(1);
  });

  it("preserves the caller's row order across the filter", () => {
    // ORDER, asserted as order. `renderNetworkMap` emits destination nodes in the caller's own
    // array order and `networkGolden.fixture.ts` pins those bytes, so a classifier that sorted
    // or partitioned its output would move the rendered SVG without changing any COUNT -- and a
    // test asserting only the surviving SET would pass under it.
    //
    // THE SEATS RUN DESCENDING IN CALLER ORDER, DELIBERATELY. A first version of this test put
    // them ascending (10, null, 99) and asserted [5, 4] -- which is what a seats-ASCENDING sort
    // also returns, so the mutant it exists to catch survived it green. That is the exact shape
    // CLAUDE.md records M4c paying for four times: asserting an outcome the buggy implementation
    // also produces, instead of varying the input that distinguishes correct from buggy. With
    // 99 first, caller order gives [5, 4] and any seats sort gives [4, 5].
    const rows = [
      { route_key_low: 1, route_key_high: 5, seats: 99, passengers: 50, departures_performed: 9 },
      { route_key_low: 1, route_key_high: 6, seats: null, passengers: null, departures_performed: null },
      { route_key_low: 1, route_key_high: 4, seats: 10, passengers: 5, departures_performed: 1 },
    ];
    expect(classifyRouteRows(rows, [5, 6, 4], 1).drawable.map((r) => r.farId)).toEqual([5, 4]);
  });
});

describe("fetchAirportNetwork, quarantine-only pairs (#114)", () => {
  it("counts BTT-UMT as quarantined rather than drawing it as zero", async () => {
    // THE DEFECT, on the page the issue reported. Before #114 this returned 16 arcs, one of
    // them `{ code: "UMT", seats: 0, departures: 0 }` -- a drawn claim of no service on a pair
    // whose sole filing (8V, 2025-10, aircraft type 416) PERFORMED one departure and was
    // quarantined `zero_seats`.
    //
    // All three clauses matter and the count is EXACT. A "some arc has seats > 0" assertion
    // passes under the bug, and so does a `>= 15`: only naming the absent code AND pinning the
    // exact arc count distinguishes "the pair was excluded" from "the pair was drawn as zero".
    const result = await fetchAirportNetwork(
      airport(BTT_ID, "BTT", "Bettles Airport"),
      T12_FROM,
      T12_TO,
    );
    expect(result).not.toBeNull();
    expect(result!.quarantinedRoutes).toBe(1);
    expect(result!.arcs.map((a) => a.code)).not.toContain("UMT");
    expect(result!.arcs).toHaveLength(15);
  });

  it("does not count VEE's same-airport quarantined filing as a route pair", async () => {
    // THE ONLY FIXTURE IN THE DATASET THAT CAN FAIL THIS WAY. Venetie carries BOTH a
    // wholly-quarantined route pair (BTI-VEE) and a wholly-quarantined same-airport pair
    // (VEE-VEE) inside this window; every other one of the 19 affected airports reports the
    // same number whichever branch runs first, so a fixture drawn from any of them would be
    // green under the bug. Hoisting the null check above the same-airport check yields 2.
    const result = await fetchAirportNetwork(
      airport(VEE_ID, "VEE", "Venetie Airport"),
      T12_FROM,
      T12_TO,
    );
    expect(result!.quarantinedRoutes).toBe(1);
  });

  it("keeps the map for an airport whose whole network is one quarantined pair", async () => {
    // Kantishna's only trailing-12 filing is the wholly-quarantined A18-LMA. Dropping the arc
    // is right; dropping the MAP with it would leave no trace on the page that anything was
    // filed -- the "no trace" failure this count exists to prevent, and the rule DiffMap
    // already follows for a carrier with no drawable arc (#105's F4 x 489).
    //
    // A18 is not hypothetical: `sitemap.test.ts` pins it as one of four airports that resolve
    // ONLY because quarantined rows are counted, so /airport/A18 is a live, sitemap-listed page.
    const result = await fetchAirportNetwork(
      airport(A18_ID, "A18", "Kantishna Airport"),
      T12_FROM,
      T12_TO,
    );
    expect(result).not.toBeNull();
    expect(result!.arcs).toHaveLength(0);
    expect(result!.quarantinedRoutes).toBe(1);
  });

  it("counts pairs whose SUMS are null, not pairs that merely contain a quarantined row", async () => {
    // THE SUBJECT IS CHOSEN TO SEPARATE TWO COUNTING RULES, because most airports cannot.
    // Fairbanks carries quarantined rows on its pairs in this window and has NOT ONE wholly
    // quarantined pair -- every one of them still has a trustworthy sum from its other filings.
    // So the correct rule answers 0 while "count the pairs carrying any quarantined row"
    // answers a large number, and this is red under that mutant while every assertion above it
    // stays green. An airport with no quarantined rows at all (ORD, which has zero in this
    // window -- measured) answers 0 under BOTH rules and would prove nothing here.
    const result = await fetchAirportNetwork(
      airport(FAI_ID, "FAI", "Fairbanks Intl"),
      T12_FROM,
      T12_TO,
    );
    expect(result!.quarantinedRoutes).toBe(0);
    // Guards the guard: if a refresh ever leaves FAI with no quarantined rows on its pairs, the
    // assertion above silently stops distinguishing the two rules. Its arcs must still be there.
    expect(result!.arcs.length).toBeGreaterThan(0);
  });
});
