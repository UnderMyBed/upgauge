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
    // first -- the same disagreement CLAUDE.md documents for 215 of 22,509 pairs.
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

  // Final whole-branch review, M4: CE-180 is not a cross-namespace collision (LNY/NEW/WST's
  // shape) -- it is aircraftExactHits' own AmbiguousCodeError path, WITHIN one namespace: BTS
  // codes 030 (CESSNA 180) and 031 (CESSNA 180A/B) share one short name, so both hits carry
  // the identical `code` ("CE-180") and the identical `href` ("/aircraft/CE-180"). Only
  // `name` tells them apart -- which is exactly what search/page.test.tsx's sibling test pins
  // as the React key search/page.tsx must use instead of `href`.
  it("CE-180: two aircraft types share one short name, both surfaced with the same href", async () => {
    const r = await search("CE-180");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    const hits = flatten(r.groups);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.kind === "aircraft")).toBe(true);
    expect(hits.every((h) => h.href === "/aircraft/CE-180")).toBe(true);
    expect(new Set(hits.map((h) => h.name)).size).toBe(2);
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

describe("search -- aircraft substring hits are slugified (fix round 1, Critical 1)", () => {
  it("'A320' matches two types via search_by_name.sql and links to the SLUG, not the raw short_name", async () => {
    // Measured against the built database: search_by_name.sql's aircraft arm matches on
    // dim_aircraft_type.NAME and returns short_name RAW -- 'A320-1/2' (AIRBUS INDUSTRIE
    // A320-100/200) and 'A320NEO' (AIRBUS INDUSTRIE A320-200N). '/' is a real path separator,
    // so a hit built straight from the raw short_name produces /aircraft/A320-1%2F2
    // (percent-encoded, and NOT what /aircraft/[name]/page.tsx's own canonical URL is --
    // that's /aircraft/A320-1-2). This is the exact defect fix round 1 found: no test in the
    // original diff reached an aircraft hit through the SUBSTRING path (only the exact-match
    // path, via 'B737-8', which already slugified correctly) -- reached via a query as
    // ordinary as the feature's own 'A220' headline example.
    //
    // The query was 'A321' until the 20260807 refresh. It still returns two types, but BTS
    // renamed 699 to 'A321nXLR' and neither A321 short name carries a separator any more, so
    // the pair could no longer distinguish a slugified href from a raw one -- the assertion
    // would have passed against the very bug it exists to catch. 'A320' restores the shape
    // exactly: two hits, one whose slug differs from its short name and one whose does not.
    const r = await search("A320");
    expect(r.kind).toBe("results");
    if (r.kind !== "results") return;
    const hits = flatten(r.groups).filter((h) => h.kind === "aircraft");
    expect(hits).toContainEqual({
      kind: "aircraft",
      code: "A320-1-2",
      name: "AIRBUS INDUSTRIE A320-100/200",
      href: "/aircraft/A320-1-2",
    });
    expect(hits).toContainEqual({
      kind: "aircraft",
      code: "A320NEO",
      name: "AIRBUS INDUSTRIE A320-200N",
      href: "/aircraft/A320NEO",
    });
    // Neither hit's href ever carries a raw '/' or a percent-encoded one.
    for (const h of hits) {
      expect(h.href).not.toContain("%2F");
      expect(h.href.slice("/aircraft/".length)).not.toContain("/");
    }
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
  // Fix round 1, Important 2: the original fixtures here ('50%off', 'p_x') returned 0 rows
  // under EVERY combination of JS-side/SQL-side escaping present or absent -- including the
  // buggy one where `likePattern()` stops escaping entirely -- because no fact-present name
  // happens to contain a literal backslash, which is what a dropped JS-side escape leaves
  // behind instead of a wildcard. That made both tests pass whether or not the escaping they
  // claimed to cover actually ran: the exact "asserting an outcome the buggy implementation
  // also produces" anti-pattern CLAUDE.md's Workflow section names.
  //
  // 'd_t' and 'a%o' are a genuinely discriminating pair, measured directly against the built
  // database before writing these: correctly escaped, both return 0 rows; with
  // `likePattern()`'s escaping removed (so '_'/'%' reach the database as literal SQL
  // wildcards), 'd_t' returns 7 rows and 'a%o' returns 794 -- proven below by mutating
  // `likePattern` and re-running this exact block.
  it("a literal '_' in the query is not treated as a single-character wildcard", async () => {
    const r = await search("d_t");
    expect(r).toEqual({ kind: "none", query: "d_t" });
  });

  it("a literal '%' in the query does not turn into a wildcard", async () => {
    const r = await search("a%o");
    expect(r).toEqual({ kind: "none", query: "a%o" });
  });
});
