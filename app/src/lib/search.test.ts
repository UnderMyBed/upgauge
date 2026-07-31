import { describe, expect, it } from "vitest";
import { rankByStartsWith, search, SEARCH_RESULT_CAP, type SearchHit } from "@/lib/search";

function flatten(groups: { hits: SearchHit[] }[]): SearchHit[] {
  return groups.flatMap((g) => g.hits);
}

describe("search -- unique exact match redirects (step 1a)", () => {
  it("resolves an airport code", async () => {
    const r = await search("PDX");
    expect(r).toEqual({ kind: "redirect", to: "/airport/PDX" });
  });

  it("resolves a carrier code", async () => {
    const r = await search("DL");
    expect(r).toEqual({ kind: "redirect", to: "/carrier/DL" });
  });

  it("resolves an aircraft slug", async () => {
    const r = await search("B737-8");
    expect(r).toEqual({ kind: "redirect", to: "/aircraft/B737-8" });
  });

  it("resolves a route pair to the code-alphabetical URL, not the typed order", async () => {
    // Measured: 'A' < 'P', so the alphabetical canonical is AUS-PDX even though PDX was typed
    // first -- the same disagreement CLAUDE.md documents for 154 of 22,420 pairs.
    const r = await search("PDX-AUS");
    expect(r).toEqual({ kind: "redirect", to: "/route/AUS-PDX" });
  });

  it("accepts an en dash as the route separator", async () => {
    const r = await search("PDX–AUS");
    expect(r).toEqual({ kind: "redirect", to: "/route/AUS-PDX" });
  });

  it("accepts a space as the route separator", async () => {
    const r = await search("PDX AUS");
    expect(r).toEqual({ kind: "redirect", to: "/route/AUS-PDX" });
  });

  it("is case-insensitive for a route pair", async () => {
    const r = await search("pdx-aus");
    expect(r).toEqual({ kind: "redirect", to: "/route/AUS-PDX" });
  });
});

describe("search -- a code in two namespaces does not redirect (step 1b)", () => {
  // Measured, fact-present, is_latest-scoped: exactly three codes are both an airport and a
  // carrier. LNY is the sharpest of the three because the carrier is named after the airport,
  // so a wrong (silently-picked) answer would still read as plausible.
  it("LNY: Lanai Airport and Western Aircraft dba Lanai Air", async () => {
    const r = await search("LNY");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    const hits = flatten(r.groups);
    expect(hits).toContainEqual({
      kind: "airport",
      code: "LNY",
      name: "Lanai Airport",
      href: "/airport/LNY",
    });
    expect(hits).toContainEqual({
      kind: "carrier",
      code: "LNY",
      name: "Western Aircraft, dba Lanai Air",
      href: "/carrier/LNY",
    });
    expect(hits.length).toBe(2);
  });

  it("NEW: Lakefront and New England Airlines Inc.", async () => {
    const r = await search("NEW");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    const hits = flatten(r.groups);
    expect(hits).toContainEqual({
      kind: "airport",
      code: "NEW",
      name: "Lakefront",
      href: "/airport/NEW",
    });
    expect(hits).toContainEqual({
      kind: "carrier",
      code: "NEW",
      name: "New England Airlines Inc.",
      href: "/carrier/NEW",
    });
    expect(hits.length).toBe(2);
  });

  it("WST: Westerly State and Friday Harbor Seaplanes", async () => {
    const r = await search("WST");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    const hits = flatten(r.groups);
    expect(hits).toContainEqual({
      kind: "airport",
      code: "WST",
      name: "Westerly State",
      href: "/airport/WST",
    });
    expect(hits).toContainEqual({
      kind: "carrier",
      code: "WST",
      name: "Friday Harbor Seaplanes",
      href: "/carrier/WST",
    });
    expect(hits.length).toBe(2);
  });

  it("never redirects for a colliding code -- no 'to' on the result", async () => {
    const r = await search("LNY");
    expect(r.kind).not.toBe("redirect");
  });
});

describe("search -- name substring returns every match, across states (step 1c)", () => {
  it("'Portland' matches all four fact-present airports, including PWM (Maine)", async () => {
    // A count-only assertion (length > 1) passes against an implementation that returns only
    // the Oregon three -- assert the four codes by name, per the task brief.
    const r = await search("Portland");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    const codes = flatten(r.groups)
      .filter((h) => h.kind === "airport")
      .map((h) => h.code)
      .sort();
    expect(codes).toEqual(["HIO", "PDX", "PWM", "TTD"]);
    const pwm = flatten(r.groups).find((h) => h.code === "PWM");
    expect(pwm?.name).toBe("Portland International Jetport");
  });
});

describe("search -- substring hits rank prefix matches first (step 1d)", () => {
  it("puts AS (Alaska Airlines) at index 0, ahead of the substring false positive DUT", async () => {
    // Measured: 'alaska' returns 8 rows -- DUT (Unalaska Airport) plus 7 carriers. Under the
    // SQL's own ORDER BY 1, 2, AS sorts third (behind 4Y and 5V). This is an ordering
    // property: `results.some(r => r.code === "AS")` cannot fail under the bug that returns
    // the un-reranked order, so this asserts position, not mere presence.
    const r = await search("Alaska");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    const hits = flatten(r.groups);
    expect(hits[0].code).toBe("AS");
    expect(hits[0].kind).toBe("carrier");
    expect(hits.length).toBe(8);
  });

  it("rankByStartsWith is a stable partition: starts-with tier first, ties in original order", () => {
    const rows = [
      { kind: "airport", code: "DUT", name: "Unalaska Airport" },
      { kind: "carrier", code: "4Y", name: "Yute Air Aka Flight Alaska" },
      { kind: "carrier", code: "5V", name: "Tatonduk Outfitters Limited" },
      { kind: "carrier", code: "AS", name: "Alaska Airlines Inc." },
    ];
    const ranked = rankByStartsWith(rows, "alaska");
    expect(ranked[0].code).toBe("AS");
    // The three that only CONTAIN the query keep their original relative order.
    expect(ranked.slice(1).map((r) => r.code)).toEqual(["DUT", "4Y", "5V"]);
  });
});

describe("search -- states (step 1e)", () => {
  it("empty query", async () => {
    const r = await search("");
    expect(r).toEqual({ kind: "empty" });
  });

  it("whitespace-only query is also empty", async () => {
    const r = await search("   ");
    expect(r).toEqual({ kind: "empty" });
  });

  it("no match names the query", async () => {
    const r = await search("zzzznotarealthing9999");
    expect(r).toEqual({ kind: "none", query: "zzzznotarealthing9999" });
  });

  it("discloses truncation with the true count still recoverable from groups", async () => {
    // 'air' returns 423 of the 1,271 fact-present rows (measured) -- comfortably over
    // SEARCH_RESULT_CAP, so this exercises the disclosure without needing a synthetic fixture.
    const r = await search("air");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    expect(r.truncated).toBe(true);
    const total = flatten(r.groups).length;
    expect(total).toBeGreaterThan(SEARCH_RESULT_CAP);
  });

  it("does not disclose truncation under the cap", async () => {
    const r = await search("Portland");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    expect(r.truncated).toBe(false);
  });
});

describe("search -- fact-presence (mutation fixture)", () => {
  it("does not surface an airport with no fact-present rows, even when its name matches", async () => {
    // Rio Vista Municipal (1CA) is a real, current (is_latest) dim_airport row that has never
    // filed a T-100 Segment row -- measured: zero rows in fct_segment_month for its
    // airport_id, and 'rio vista' matches nothing else in dim_carrier or dim_aircraft_type.
    // Without search_by_name.sql's fact-presence filter this would render a link to
    // /airport/1CA, which 404s -- the exact defect M4d's own airport reverse-lookup review
    // found (docs/data/invariants.md § Entity resolution).
    const r = await search("rio vista");
    expect(r).toEqual({ kind: "none", query: "rio vista" });
  });
});

describe("search -- escaping (ambiguity note)", () => {
  it("a literal '%' in the query does not turn into a wildcard", async () => {
    // No fact-present name contains '%', so this must find nothing rather than matching
    // everything the way an un-escaped '%' would.
    const r = await search("50%off");
    expect(r.kind).toBe("none");
  });

  it("a literal '_' in the query is not treated as a single-character wildcard", async () => {
    // Without escaping, 'p_x' would match 'pdx' (and anything else of that shape) via '_'
    // matching any one character; no fact-present name literally contains 'p_x'.
    const r = await search("p_x");
    expect(r.kind).toBe("none");
  });
});
