import { describe, expect, it } from "vitest";
import { resolveRoutePair } from "@/lib/routePair";

describe("resolveRoutePair", () => {
  it("accepts an already-canonical pair", async () => {
    const r = await resolveRoutePair("JFK-LAX");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.canonical).toBe("JFK-LAX");
    expect(r.filterValue).toBe("12478-12892");
  });

  it("redirects a reversed pair to the alphabetical form", async () => {
    const r = await resolveRoutePair("LAX-JFK");
    expect(r).toEqual({ kind: "redirect", canonical: "JFK-LAX" });
  });

  it("redirects lowercase to uppercase", async () => {
    const r = await resolveRoutePair("jfk-lax");
    expect(r).toEqual({ kind: "redirect", canonical: "JFK-LAX" });
  });

  it("orders the filter value by ID even when that disagrees with the alphabet", async () => {
    // 154 of 22,950 routes have id order != alphabetical order. Verified: HPN is 12197 and
    // BNH is 16954, so id order is HPN-BNH while the alphabetical canonical is BNH-HPN.
    // The slug follows the alphabet; the filter value follows the ids. Pinned to the exact
    // expected string, not just an ordering check -- an ordering check alone would still
    // pass if the implementation used the (wrong) alphabetical order for filterValue, since
    // "BNH" < "HPN" alphabetically would coincidentally also put the smaller id first here
    // only if id order matched alphabetical order, which is exactly the case this route was
    // chosen to NOT be.
    const r = await resolveRoutePair("BNH-HPN");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.canonical).toBe("BNH-HPN");
    expect(r.filterValue).toBe("12197-16954");
    expect(Number(r.filterValue.split("-")[0])).toBeLessThan(
      Number(r.filterValue.split("-")[1]),
    );
  });

  it("404s an unknown code, naming it", async () => {
    const r = await resolveRoutePair("ZZZZ-LAX");
    expect(r.kind).toBe("notFound");
    if (r.kind !== "notFound") return;
    expect(r.reason).toContain("ZZZZ");
    expect(r.reason).toContain("unknown airport code");
  });

  it("404s a recognized-but-non-domestic code, distinguishing it from a typo", async () => {
    // LHR is a real airport in dim_airport's own reference table (BTS's master list is
    // global), but T-100 Segment is domestic-only (CLAUDE.md's "Segment only" rule) so it
    // never carries a fct_segment_month row and fails lookupAirportsByCode -- the same
    // failure mode as a genuine typo like ZZZZ, but a different fact. Fails if the
    // domestic-only branch is dropped (reason would read "unknown airport code 'LHR'"
    // instead) or if LHR ever gains domestic segment data (would then resolve, not 404 at
    // all) -- both are real, checkable regressions, not just a rephrasing.
    const r = await resolveRoutePair("JFK-LHR");
    expect(r.kind).toBe("notFound");
    if (r.kind !== "notFound") return;
    expect(r.reason).toContain("LHR");
    expect(r.reason).toContain("domestic-only");
    expect(r.reason).not.toContain("unknown airport code 'LHR'");
  });

  it("404s a slug that is not two codes", async () => {
    const r = await resolveRoutePair("JFK");
    expect(r.kind).toBe("notFound");
  });

  it("404s a route from an airport to itself", async () => {
    // Same-airport filings exist (12,738 across 530 airports) but they are not a route
    // between two places, and /route/XXX-XXX would render a page about a non-route. This is
    // checked before the lookup (rawA === rawB, both known or not), so it fails for the
    // self-route reason specifically -- confirmed by the "reason" text, not just kind, so a
    // future regression that instead 404s JFK-JFK because JFK failed to resolve wouldn't
    // slip past unnoticed with the same "notFound" kind.
    const r = await resolveRoutePair("JFK-JFK");
    expect(r.kind).toBe("notFound");
    if (r.kind !== "notFound") return;
    expect(r.reason).toContain("JFK");
    expect(r.reason).toContain("itself");
  });
});
