import { describe, expect, it } from "vitest";
import {
  MAX_SLUG_SEPARATORS,
  aircraftSlugFromPath,
  resolveAircraftSlug,
  resolveFromMatches,
  shortNameCandidates,
  slugFor,
} from "@/lib/aircraftSlug";
import { dataAsOf, runPivot } from "@/lib/db";
import { displayValue, resolutionKey, type AircraftRef } from "@/lib/resolve";

describe("slugFor", () => {
  it("passes through a short name that is already a path segment", () => {
    // 36 of the 112 fact-present short names carry no separator at all and 65 carry only a
    // hyphen; for all 101 the transform must be the identity, or every one of them 404s.
    expect(slugFor("B737-8")).toBe("B737-8");
    expect(slugFor("ERJ-175")).toBe("ERJ-175");
    expect(slugFor("SKYHAWK")).toBe("SKYHAWK");
  });

  it("replaces the two characters that cannot appear in a single path segment", () => {
    // `/aircraft/A320-1/2` parses as TWO path segments and can never match a single dynamic
    // segment, so a page keyed on the raw short name 404s all 15 names that carry a `/` or a
    // space. Task 1 measured this and left the decision here.
    //
    // `slugFor` is pure string work, so these assertions passed straight through the 20260807
    // refresh that retired 'A321/LR' (BTS renamed type 699 to 'A321nXLR'). They were rewritten
    // anyway: a worked example naming a type that no longer exists teaches the next reader a
    // name they will not find in the catalog.
    expect(slugFor("B767-3/R")).toBe("B767-3-R");
    expect(slugFor("A320-1/2")).toBe("A320-1-2");
    expect(slugFor("MAX 8")).toBe("MAX-8");
    expect(slugFor("MAX 8-20")).toBe("MAX-8-20");
    expect(slugFor("FLT/AMPH")).toBe("FLT-AMPH");
  });

  it("uppercases, so the canonical URL does not depend on how BTS typed the name", () => {
    // dim_aircraft_type carries exactly one lower-case short name, '330-9neo' (code 824, the
    // A330-900neo), which has never filed a T-100 Segment row. It is not reachable today and
    // will be the first month Airbus's neo shows up in the data.
    expect(slugFor("330-9neo")).toBe("330-9NEO");
  });
});

describe("shortNameCandidates", () => {
  it("names every short name a slug could have come from", () => {
    // The transform is many-to-one -- it maps `/` and ` ` onto a character that already occurs
    // in names like B737-8 -- so the reverse is a SET, not a function. Each `-` in the slug
    // could have been any of the three.
    // FLT/AMPH, not B767-3/R: the latter's slug is 'B767-3-R', which carries the pre-existing
    // dash TOO and so expands to nine, not three. A one-separator example has to be a name
    // with exactly one `/`-or-space and no `-` of its own.
    expect(new Set(shortNameCandidates("FLT-AMPH"))).toEqual(
      new Set(["FLT-AMPH", "FLT/AMPH", "FLT AMPH"]),
    );
    // Two separators, nine candidates -- and 'A320-1/2', the real one, is among them.
    const two = shortNameCandidates("A320-1-2");
    expect(two).toHaveLength(9);
    expect(two).toContain("A320-1/2");
    // A slug with no separator has exactly one preimage, so the lookup is a single value.
    expect(shortNameCandidates("SKYHAWK")).toEqual(["SKYHAWK"]);
  });

  it("refuses to expand a slug with more separators than any real type has", () => {
    // A bound, not a nicety: the candidate set is 3^n, so `/aircraft/-------------------`
    // would otherwise ask DuckDB to bind 3^19 parameters. The measured maximum over all 111
    // fact-present slugs is 2 (pinned by the live-catalog test below), so this cap is 2x the
    // real world and still finite.
    expect(shortNameCandidates("A-B-C-D-E-F")).toBeNull();
    // ...and the boundary itself is accepted, so the cap is off-by-one-proof in both
    // directions: 4 separators is 81 candidates, which is a bound, not a refusal.
    expect(shortNameCandidates("A-B-C-D-E")).toHaveLength(81);
    expect(MAX_SLUG_SEPARATORS).toBe(4);
  });
});

describe("the slug transform against the live catalog", () => {
  it("is injective over every fact-present aircraft type, with CE-180 the one exception", async () => {
    // This is the measurement the whole scheme rests on, and it is a property of TODAY'S DATA,
    // not of the transform: mapping `/` and ` ` onto `-` collides the moment BTS ships a type
    // whose name differs from another's only in that character. So it is asserted against the
    // real catalog rather than assumed, and a future clash fails here instead of resolving
    // arbitrarily on a page.
    //
    // Enumerated through the existing pivot (no new SQL -- the M4d spec's own constraint):
    // one row per fact-present aircraft type over the full window, with short_name resolved.
    const asOf = await dataAsOf();
    const result = await runPivot({
      grain: "segment",
      dimensions: ["aircraft_type"],
      measures: ["seats"],
      timeFrom: "2015-01",
      timeTo: asOf,
      filters: [],
      sort: null,
      sortDesc: true,
      limit: 1000,
      grouping: "operating",
    });
    const names = result.rows.map((r) => {
      const code = String(r.aircraft_type);
      return displayValue(result.resolved.get(resolutionKey("aircraft_type", code)), code);
    });
    expect(names.length).toBe(112);

    const bySlug = new Map<string, string[]>();
    for (const name of names) {
      const slug = slugFor(name);
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), name]);
    }
    const collisions = [...bySlug].filter(([, group]) => group.length > 1);
    // Exactly one collision, and it is the short name colliding with ITSELF (two BTS codes
    // share 'CE-180'), not two distinct names flattened together by the transform. Falsifiable:
    // a transform that also replaced, say, '.' would fold new pairs in here.
    expect(collisions.map(([slug]) => slug)).toEqual(["CE-180"]);
    expect(new Set(collisions[0][1])).toEqual(new Set(["CE-180"]));
    expect(bySlug.size).toBe(111);

    // ...and the separator bound the candidate expansion depends on.
    const worst = Math.max(...[...bySlug.keys()].map((s) => s.split("-").length - 1));
    expect(worst).toBe(2);
    expect(worst).toBeLessThanOrEqual(MAX_SLUG_SEPARATORS);
  });
});

describe("resolveAircraftSlug", () => {
  it("resolves a slug that needed no transform", async () => {
    const r = await resolveAircraftSlug("B737-8");
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
    // The zero-padded BTS code as a STRING: 614 is the 737-800. Number(614) would still read
    // 614, which is why the leading-zero types are the ones that prove the rule -- AircraftRef
    // types `id` as string for exactly that reason (resolve.ts).
    expect(r.type.id).toBe("614");
    expect(r.type.code).toBe("B737-8");
    expect(r.type.name).toBe("BOEING 737-800");
    expect(r.canonical).toBe("B737-8");
  });

  it("resolves a slug whose short name is not a path segment", async () => {
    // THE test the transform exists for, and the one that fails if it is removed: matching
    // `upper(short_name)` directly can never see 'A320-1/2' from a single URL segment.
    //
    // This used A321/LR until the 20260807 refresh, when BTS renamed type 699 to 'A321nXLR'
    // -- a name with NO separator, which cannot exercise this path at all. A320-1/2 (code 694)
    // is the replacement: the highest-traffic separator-bearing type in the catalog, 987 M
    // seats, still filing as of 2026-04. It also carries TWO slug separators where A321/LR had
    // one, so it exercises the 3^2 expansion rather than the 3^1 case.
    const r = await resolveAircraftSlug("A320-1-2");
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
    expect(r.type.id).toBe("694");
    expect(r.type.code).toBe("A320-1/2");
    // The canonical URL is the SLUG, never the short name -- '/aircraft/A320-1/2' is unroutable.
    expect(r.canonical).toBe("A320-1-2");
  });

  it("redirects a lower-case slug to its canonical form", async () => {
    const r = await resolveAircraftSlug("a320-1-2");
    expect(r).toEqual({ kind: "redirect", canonical: "A320-1-2" });
  });

  it("refuses to pick one airframe for a slug that names two", async () => {
    // REACHABLE, not hypothetical: 'CE-180' is the short name of BTS code 030 (CESSNA 180, 183
    // filed rows) AND code 031 (CESSNA 180A/B, 131 rows). Both really flew; no scoping resolves
    // it (lookup_aircraft_by_name.sql). Task 1 made AmbiguousCodeError carry its candidates so
    // this page can name both rather than render whichever row DuckDB returned last -- which is
    // what the AUS bug did, confidently displaying an airport closed since 1999.
    const r = await resolveAircraftSlug("CE-180");
    if (r.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${r.kind}`);
    expect(r.slug).toBe("CE-180");
    expect([...r.ids].sort()).toEqual(["030", "031"]);
    // Zero-padded, as strings. Falsifiable: an implementation that let these through Number()
    // reports 30 and 31, and the disambiguation page's Explorer links would then filter on
    // aircraft types that do not exist.
    expect(r.ids.every((id) => typeof id === "string")).toBe(true);
  });

  it("names the slug it could not resolve", async () => {
    const r = await resolveAircraftSlug("NOPE-1");
    if (r.kind !== "notFound") throw new Error(`expected notFound, got ${r.kind}`);
    expect(r.reason).toContain("NOPE-1");
  });

  it("404s a type BTS lists but has never filed a segment row for", async () => {
    // '330-9neo' (code 824, AIRBUS A330-900neo) is in dim_aircraft_type and in no fact row, so
    // lookup_aircraft_by_name.sql's fact-presence filter excludes it -- a page for it would be
    // entirely empty under a DATA AS OF badge. Distinct from the typo above only in the data;
    // asserted because dropping that filter would silently make this a blank 200.
    //
    // It also exercises the uppercasing end to end on the ONE lower-case short name in the
    // dimension: this is the type that turns up the day Airbus's neo files, and it will arrive
    // as `/aircraft/330-9NEO`.
    expect((await resolveAircraftSlug("330-9NEO")).kind).toBe("notFound");
  });

  it("resolves KINGAIR to the fact-present Beech 200, not the King Air C-90", async () => {
    // The first version of this test asserted KINGAIR was fact-ABSENT, misreading
    // lookup_aircraft_by_name.sql's header -- it is the C-90 *under* that short name that never
    // filed, not the short name itself. The test failed, which is the point of writing it
    // first. The real claim is the one the fact-presence filter earns: 12 short names name more
    // than one dim_aircraft_type row, and for 11 of them the filter picks out the one that
    // actually flew. Falsifiable: without it, KINGAIR matches two rows and this page 500s.
    const r = await resolveAircraftSlug("KINGAIR");
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
    expect(r.type.id).toBe("406");
    expect(r.type.name).toBe("BEECH 200 SUPER KINGAIR");
  });

  it("404s an over-separated slug without asking the database to bind 3^n parameters", async () => {
    const r = await resolveAircraftSlug("A-B-C-D-E-F");
    if (r.kind !== "notFound") throw new Error(`expected notFound, got ${r.kind}`);
    expect(r.reason).toContain("A-B-C-D-E-F");
  });
});

describe("resolveFromMatches", () => {
  // The slug-collision branch. HONEST ABOUT WHAT THIS IS: no live data reaches it -- the
  // catalog test above proves the transform introduces zero collisions today -- so this is an
  // ALARM for a future BTS refresh, not a test that would have caught a bug written today. It
  // is a direct call on the pure half for exactly that reason: the only other way to observe
  // the branch would be to wait for BTS to ship a colliding pair, which is not a test.
  const ref = (id: string, code: string): AircraftRef => ({
    id,
    code,
    name: code,
  });

  it("refuses two DIFFERENT short names that flatten to one slug", () => {
    const r = resolveFromMatches("B737-8", [ref("614", "B737-8"), ref("999", "B737/8")]);
    if (r.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${r.kind}`);
    expect(r.ids).toEqual(["614", "999"]);
  });

  it("resolves a single match", () => {
    const r = resolveFromMatches("B737-8", [ref("614", "B737-8")]);
    expect(r.kind).toBe("ok");
  });
});

describe("aircraftSlugFromPath", () => {
  it("reads the slug out of an /aircraft pathname and nothing else", () => {
    expect(aircraftSlugFromPath("/aircraft/B737-8")).toBe("B737-8");
    expect(aircraftSlugFromPath("/route/JFK-LAX")).toBeNull();
    expect(aircraftSlugFromPath("/explore")).toBeNull();
  });

  it("survives a malformed percent-escape rather than throwing", () => {
    // `decodeURIComponent` THROWS on '%zz'. That is bug #2 on smoke.sh's list of
    // production-only failures -- found once, never by a unit test -- and an uncaught throw in
    // a not-found render is a 500 where a 404 was already the answer.
    expect(aircraftSlugFromPath("/aircraft/%zz")).toBe("%zz");
    expect(aircraftSlugFromPath("/aircraft/%E0%A4%A")).toBe("%E0%A4%A");
    expect(aircraftSlugFromPath("/aircraft/MAX%208")).toBe("MAX 8");
  });

  // M5 Task 6: aircraftSlugFromPath is now a one-line wrapper around lib/entitySlug.ts's
  // entitySlugFromPath. Pinned here so the collapse cannot smuggle in a behaviour change --
  // unlike airportSlugFromPath, this reader never special-cased an empty slug or a nested path.
  it("returns the empty string for a bare trailing slash, not null", () => {
    expect(aircraftSlugFromPath("/aircraft/")).toBe("");
  });

  it("returns whatever follows the prefix verbatim on a nested path", () => {
    expect(aircraftSlugFromPath("/aircraft/B737-8/extra")).toBe("B737-8/extra");
  });
});
