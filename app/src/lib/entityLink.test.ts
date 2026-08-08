import { describe, expect, it } from "vitest";
import { entityHref, routeHrefFromCodes } from "@/lib/entityLink";
import type { Resolved } from "@/lib/resolve";

function resolved(code: string | null, name: string | null = null): Resolved {
  return { code, name };
}

describe("entityHref", () => {
  it("links a resolved airport dimension to /airport/<code>", () => {
    expect(entityHref("origin_airport_id", resolved("SEA", "Seattle-Tacoma Intl"))).toBe(
      "/airport/SEA",
    );
    expect(entityHref("dest_airport_id", resolved("LAX", "Los Angeles Intl"))).toBe(
      "/airport/LAX",
    );
  });

  it("links a resolved carrier dimension to /carrier/<code>", () => {
    expect(entityHref("op_airline_id", resolved("DL", "Delta Air Lines"))).toBe("/carrier/DL");
  });

  // (a) The map must key on the dimension's own `key`, not on `join_dim`. Read from the built
  // catalog, `route`, `origin_airport_id` and `dest_airport_id` all carry join_dim = dim_airport,
  // and both city-market dimensions carry a join_dim with no page behind it. A join_dim-keyed
  // map would send route cells to /airport/ and city-market cells to a page that does not
  // exist -- pin every dimension that has no page of its own, including `route`, which is
  // absent from the map on purpose (use routeHrefFromCodes for it).
  it("returns null for city-market dimensions -- they share dim_city_market's join_dim with no page behind it", () => {
    expect(entityHref("origin_city_market_id", resolved("Seattle, WA"))).toBeNull();
    expect(entityHref("dest_city_market_id", resolved("Los Angeles, CA"))).toBeNull();
  });

  it("returns null for route -- its cell is not a single-id DimensionCell", () => {
    expect(entityHref("route", resolved("SEA-LAX"))).toBeNull();
  });

  it("returns null for every dimension with no entity page", () => {
    for (const dimKey of [
      "year_month",
      "quarter",
      "year",
      "origin_state",
      "dest_state",
      "distance_group",
      "aircraft_group",
    ]) {
      expect(entityHref(dimKey, resolved("2024-01"))).toBeNull();
    }
  });

  // (b) An aircraft href must go through slugFor(). resolve_aircraft_type.sql selects
  // short_name AS code, and 15 of 112 fact-present short names carry a `/` or a space --
  // AIRCRAFT_PREFIX + hit.code alone yields /aircraft/A320-1/2, two path segments, unroutable.
  it("slugifies an aircraft short name that contains a slash", () => {
    expect(entityHref("aircraft_type", resolved("A320-1/2", "AIRBUS INDUSTRIE A320-100/200"))).toBe(
      "/aircraft/A320-1-2",
    );
  });

  it("passes through an aircraft short name that is already a single path segment", () => {
    expect(entityHref("aircraft_type", resolved("B737-8", "Boeing 737-8"))).toBe(
      "/aircraft/B737-8",
    );
  });

  // (c) A hit with code === null never links -- city markets resolve to a name with no code,
  // and there is no /city-market/ page. Nor does an unresolved id (hit === undefined), which
  // renders the bare id.
  it("returns null when the resolution has no code", () => {
    expect(entityHref("origin_airport_id", resolved(null, "Some Name"))).toBeNull();
  });

  it("returns null when the id did not resolve at all", () => {
    expect(entityHref("origin_airport_id", undefined)).toBeNull();
  });

  // (d) CE-180 DOES link, deliberately. It is the one aircraft slug two fact-present codes map
  // to (030 Cessna 180, 031 Cessna 180A/B), so /aircraft/CE-180 is a 404 -- but M4d built that
  // 404 to name and link both airframes, which beats an inert text cell, and the 404 is
  // no-store so nothing pins it. Pin the link so nobody "fixes" it into a suppression.
  it("still links CE-180, whose slug is ambiguous, rather than suppressing it", () => {
    expect(entityHref("aircraft_type", resolved("CE-180", "Cessna 180"))).toBe(
      "/aircraft/CE-180",
    );
  });
});

describe("routeHrefFromCodes", () => {
  it("orders the pair alphabetically by code regardless of input order", () => {
    expect(routeHrefFromCodes("JFK", "LAX")).toBe("/route/JFK-LAX");
    // Out-of-order input: the whole reason this function exists rather than a template
    // literal at the call site is that callers must not be trusted to pass codes in
    // alphabetical order already.
    expect(routeHrefFromCodes("LAX", "JFK")).toBe("/route/JFK-LAX");
  });

  it("is idempotent when the pair is already alphabetical", () => {
    expect(routeHrefFromCodes("ATL", "SEA")).toBe("/route/ATL-SEA");
  });
});
