import { describe, expect, it } from "vitest";
import { resolveAirportCode } from "@/app/airport/[code]/resolveAirport";

// Real database, no mocks (lib/resolve.ts's header comment): every case below is a live
// lookup_airport_by_code.sql run against upgauge.duckdb.
describe("resolveAirportCode", () => {
  it("resolves a real code to its id and name", async () => {
    // SEA is airport_id 14747 -- NOT 13830, which is Kahului (OGG). The id is asserted here
    // precisely because it is the thing nothing else on the page can check: every stat would
    // render just as plausibly for the wrong airport.
    const r = await resolveAirportCode("SEA");
    if (r.kind !== "ok") throw new Error(`expected SEA to resolve, got ${r.kind}`);
    expect(r.airport.id).toBe(14747);
    expect(r.airport.code).toBe("SEA");
    expect(r.airport.name).toMatch(/Seattle/);
  });

  it("redirects a lowercase slug to the canonical uppercase URL", async () => {
    // The lookup is case-insensitive, so `sea` RESOLVES -- which is exactly why the canonical
    // form has to be computed separately and redirected to, or /airport/sea and /airport/SEA
    // become two URLs for one page with two cache entries.
    const r = await resolveAirportCode("sea");
    expect(r).toEqual({ kind: "redirect", canonical: "SEA" });
  });

  it("names an unknown code rather than 404ing anonymously", async () => {
    const r = await resolveAirportCode("ZZZZ");
    if (r.kind !== "notFound") throw new Error("expected ZZZZ to 404");
    expect(r.reason).toMatch(/unknown airport code 'ZZZZ'/);
    expect(r.reason).not.toMatch(/domestic-only/);
  });

  it("distinguishes a real airport this domestic-only dataset has no rows for", async () => {
    // LHR is in dim_airport's global master roster (BTS ships the world) and carries no
    // fct_segment_month row, so lookup_airport_by_code.sql's fact-presence filter rejects it
    // for the same reason a typo is rejected. Without the second check both render the
    // identical "unknown code" 404, which is wrong about the data.
    const r = await resolveAirportCode("LHR");
    if (r.kind !== "notFound") throw new Error("expected LHR to 404");
    expect(r.reason).toMatch(/'LHR' is a recognized airport code/);
    expect(r.reason).toMatch(/domestic-only/);
    expect(r.reason).not.toMatch(/unknown airport code/);
  });

  it("rejects a blank slug without querying for it", async () => {
    // `/airport/%20` reaches the page with a whitespace-only param. An empty IN-list is the
    // failure runSlugLookup's own early return exists to avoid; this keeps it from getting
    // there and names what was wrong.
    const r = await resolveAirportCode("  ");
    if (r.kind !== "notFound") throw new Error("expected a blank slug to 404");
    expect(r.reason).toMatch(/expected an airport code/);
  });
});
