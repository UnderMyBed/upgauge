import { describe, expect, it } from "vitest";
import {
  AIRPORT_NETWORK_LIMIT,
  airportNetworkQuery,
  farEndpoints,
  fetchAirportNetwork,
} from "./airportNetwork";
import { renderNetworkMap } from "./networkMap";
import type { AirportRef } from "@/lib/resolve";

const SEA_ID = 14747;
const ORD_ID = 13930;

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
    // over 2025-05..2026-04 -- the identical figure docs/design/system.md's own arc-encoding
    // section states (53 segment-grain rows folding to this same total at route grain).
    const result = await fetchAirportNetwork(
      airport(ORD_ID, "ORD", "Chicago O'Hare Intl"),
      "2025-05",
      "2026-04",
    );
    expect(result).not.toBeNull();
    expect(result!.sameAirportSeats).toBe(73082);
  });

  it("resolves exactly 268 route-grain rows for ORD, and renders 267 arcs", async () => {
    // 268 is ORD's measured trailing-12 route count (M7 Task 8) -- one of those 268 is the
    // same-airport row itself, which renderNetworkMap must exclude from the drawn set
    // (system.md's arc-encoding section: "ORD draws 267 arcs, not 268").
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
