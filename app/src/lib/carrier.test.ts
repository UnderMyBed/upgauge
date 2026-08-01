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
// PA and ZZ are both 404s and that is the point: 1,543 of dim_carrier's 1,657 DISTINCT codes
// have no fact-present holder (measured; 1,776 is the table's ROW count, one per airline_id),
// so the "recognized but never filed" case is the COMMON 404 here, not the exotic one -- and
// since M5 Task 6 (lookup_carrier_code_exists.sql) it gets a DIFFERENT reason from ZZ's,
// naming every one of PA's three holders, the same split routePair.ts has always made for
// airports.

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

  it("404s a code that appears nowhere in dim_carrier, calling it unknown", async () => {
    // M5 Task 6: ZZ and PA below now get DIFFERENT reasons -- lookup_carrier_code_exists.sql
    // is what makes the split possible, the same way lookup_airport_code_exists.sql already
    // does for /route. Either half of this pair alone is vacuous: a handler that always says
    // "unknown" would still pass this test, and one that always says "recognized" would still
    // pass the PA test below.
    const r = await resolveCarrier("ZZ");
    if (r.kind !== "notFound") throw new Error(`expected ZZ to 404, got ${r.kind}`);
    expect(r.reason).toBe("unknown carrier code 'ZZ'");
    expect(r.reason).not.toMatch(/recognized/i);
  });

  it("404s a recognized code that has never filed, naming EVERY holder rather than picking one", async () => {
    // PA is the worst measured case: THREE rows in dim_carrier, not one -- airline_id 20384
    // and 20386, both "Pan American World Airways", and 20389 "Florida Coastal Airlines", an
    // UNRELATED carrier that just happens to share the code. Naming only the first would be
    // the same silent-pick failure the AUS lookup (docs/data/invariants.md § Entity
    // resolution) already cost this project once. A single-holder code cannot catch this --
    // this fixture is deliberately the one with the widest fan-out.
    const r = await resolveCarrier("PA");
    if (r.kind !== "notFound") throw new Error(`expected PA to 404, got ${r.kind}`);
    expect(r.reason).toContain("'PA'");
    expect(r.reason).toMatch(/recognized/i);
    expect(r.reason).not.toMatch(/^unknown/i);
    // The count, stated in words.
    expect(r.reason).toMatch(/\b3\b/);
    // Every holder, by id AND by name -- not just the first one the driver returned.
    expect(r.reason).toContain("20384");
    expect(r.reason).toContain("20386");
    expect(r.reason).toContain("20389");
    expect((r.reason.match(/Pan American World Airways/g) ?? []).length).toBe(2);
    expect(r.reason).toContain("Florida Coastal Airlines");
    expect(r.reason).toMatch(/filed|filing/i);
  });

  // Final whole-branch review, M5: `carrierNotFoundReason`'s `holders.length === 1` branch was
  // untested, and it is the MAJORITY carrier 404 -- 1,543 never-filed codes minus PA-shaped
  // 94 multi-holder codes leaves 1,449 that take this branch, not PA's rarer 3-holder path.
  // CBA (airline_id 19142, "Carriba Air Inc.") is a measured single-holder, never-filed code:
  // one row in dim_carrier, zero fct_segment_month rows for that airline_id. Pins the singular
  // "one airline id" wording -- a mutant that always pluralizes ("1 airline ids") or that
  // always takes PA's wording (hardcoding "3") would go undetected without this, since PA
  // alone can never exercise the singular branch.
  it("404s a single-holder never-filed code with singular wording, not PA's plural shape", async () => {
    const r = await resolveCarrier("CBA");
    if (r.kind !== "notFound") throw new Error(`expected CBA to 404, got ${r.kind}`);
    expect(r.reason).toContain("'CBA'");
    expect(r.reason).toMatch(/recognized/i);
    expect(r.reason).toContain("one airline id");
    expect(r.reason).not.toMatch(/airline ids/);
    expect(r.reason).toContain("19142");
    expect(r.reason).toContain("Carriba Air Inc.");
    expect((r.reason.match(/Carriba Air Inc\./g) ?? []).length).toBe(1);
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
    expect(carrierSlugFromPath("/carrier/%E0%A4%A")).toBe("%E0%A4%A");
  });

  // M5 Task 6: carrierSlugFromPath is now a one-line wrapper around lib/entitySlug.ts's
  // entitySlugFromPath. Pinned here so the collapse cannot smuggle in a behaviour change --
  // unlike airportSlugFromPath, this reader never special-cased an empty slug or a nested path.
  it("returns the empty string for a bare trailing slash, not null", () => {
    expect(carrierSlugFromPath("/carrier/")).toBe("");
  });

  it("returns whatever follows the prefix verbatim on a nested path", () => {
    expect(carrierSlugFromPath("/carrier/DL/extra")).toBe("DL/extra");
  });
});
