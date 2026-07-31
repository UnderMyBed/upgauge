import { describe, expect, it } from "vitest";
import { carrierSlugFromPath, resolveCarrier } from "@/lib/carrier";

// No mocks, no fixtures: every case below runs the real lookup against the real
// upgauge.duckdb, exactly as routePair.test.ts does. The three carriers used are chosen
// because they sit on DIFFERENT sides of the fact-presence filter that makes a carrier_code a
// key at all (lookup_carrier_by_code.sql's header), which is the property these tests exist
// to hold:
//
//   DL -- airline_id 19790, Delta Air Lines Inc., 3.36 M-row-scale filer. Fact-present.
//   PA -- Pan American World Airways. THREE rows in dim_carrier (20384, 20386, and 20389
//         "Florida Coastal Airlines"), none of which has ever filed a T-100 Segment row in
//         this window. Recognized by BTS, absent from the facts.
//   ZZ -- 0 rows in dim_carrier at all (measured).
//
// PA and ZZ are both 404s and that is the point: 1,543 of dim_carrier's 1,776 codes have no
// fact-present holder (measured), so the "recognized but never filed" case is the COMMON 404
// here, not the exotic one, and the reason sentence has to be true of it.

describe("resolveCarrier", () => {
  it("resolves a real code to its airline, keyed on the id", async () => {
    const r = await resolveCarrier("DL");
    if (r.kind !== "ok") throw new Error(`expected DL to resolve, got ${r.kind}`);
    expect(r.carrier.id).toBe(19790);
    expect(r.carrier.code).toBe("DL");
    expect(r.carrier.name).toBe("Delta Air Lines Inc.");
  });

  it("filters on the AIRLINE ID, never on the letter code", async () => {
    // CLAUDE.md's hard rule, and the one mistake here that would still render a
    // plausible-looking page: `op_airline_id` is an integer column, so filtering it by the
    // string 'DL' returns zero rows and the page would show a confident, fully-formatted
    // empty state for the largest carrier in the dataset. Asserting the value directly (and
    // that it is NOT the code) distinguishes the two; asserting only "the page renders" would
    // not.
    const r = await resolveCarrier("DL");
    if (r.kind !== "ok") throw new Error("expected DL to resolve");
    expect(r.filterValue).toBe("19790");
    expect(r.filterValue).not.toBe("DL");
  });

  it("canonicalises a lower-case code rather than serving two URLs for one carrier", async () => {
    const r = await resolveCarrier("dl");
    expect(r.kind).toBe("redirect");
    if (r.kind !== "redirect") throw new Error("unreachable");
    expect(r.canonical).toBe("DL");
  });

  it("does not redirect a code that is already canonical", async () => {
    // The pair to the test above: a resolver that redirected unconditionally would satisfy
    // that one and put /carrier/DL into an infinite redirect loop.
    expect((await resolveCarrier("DL")).kind).toBe("ok");
  });

  it("404s a code that appears nowhere in dim_carrier, naming it", async () => {
    const r = await resolveCarrier("ZZ");
    if (r.kind !== "notFound") throw new Error(`expected ZZ to 404, got ${r.kind}`);
    expect(r.reason).toContain("'ZZ'");
  });

  it("404s a recognized code that has never filed, and says that, rather than calling it unknown", async () => {
    // PA is a REAL carrier code -- three airlines in dim_carrier carry it -- with zero T-100
    // Segment rows. A reason reading "unknown carrier code 'PA'" would be a false statement
    // about the data, which is the failure this project's 404s already refuse for airports
    // (routePair.ts splits "unknown code" from "domestic-only"). The sentence shipped here is
    // deliberately one that is true of BOTH this case and ZZ above: it talks about FILINGS,
    // not about recognition.
    //
    // Falsifiable in the direction that matters: it fails if the reason ever claims the code
    // itself is unrecognized, which is exactly the wording a copy-paste from routePair.ts
    // would produce.
    const r = await resolveCarrier("PA");
    if (r.kind !== "notFound") throw new Error(`expected PA to 404, got ${r.kind}`);
    expect(r.reason).toContain("'PA'");
    expect(r.reason).toMatch(/filed|filing/i);
    expect(r.reason).not.toMatch(/unknown|unrecognized|no such/i);
  });

  it("404s an empty slug without asking the database", async () => {
    const r = await resolveCarrier("   ");
    expect(r.kind).toBe("notFound");
  });

  it("is case-insensitive on the way in", async () => {
    // Lower-case redirects (above); mixed case must resolve to the same airline rather than
    // 404, so the redirect target is always a real page.
    const r = await resolveCarrier("Dl");
    expect(r.kind).toBe("redirect");
  });
});

describe("carrierSlugFromPath", () => {
  it("reads the code out of a carrier pathname", () => {
    expect(carrierSlugFromPath("/carrier/DL")).toBe("DL");
  });

  it("returns null for a pathname that is not a carrier page", () => {
    // proxy.ts and not-found.tsx both branch on this null (the same contract
    // routeSlugFromPath holds for /route), so a prefix test that matched /route or / would
    // send the wrong resolver at the wrong slug.
    expect(carrierSlugFromPath("/route/JFK-LAX")).toBeNull();
    expect(carrierSlugFromPath("/explore")).toBeNull();
    expect(carrierSlugFromPath("/carrierless")).toBeNull();
  });

  it("decodes a percent-encoded slug, matching what the page receives in params", () => {
    expect(carrierSlugFromPath("/carrier/%39E")).toBe("9E");
  });

  it("falls back to the raw text on a malformed escape instead of throwing", () => {
    // bug #2 on smoke.sh's list of production-only failures: decodeURIComponent THROWS on
    // '%zz'. An uncaught throw here is a 500 on a page whose entire job is to render a 404.
    expect(carrierSlugFromPath("/carrier/%zz")).toBe("%zz");
  });
});
