import { describe, expect, it } from "vitest";
import { dedupeAircraftBySlug, parseLastmod, sitemapEntries } from "@/lib/sitemap";
import { dataAsOf } from "@/lib/db";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

// No mocks: every case below runs the real sitemap_*.sql files against the real
// upgauge.duckdb, exactly as routePair.test.ts / carrier.test.ts do.

describe("sitemapEntries", () => {
  it("emits exactly the measured URL count per kind, quarantine included", async () => {
    // docs/product/scope.md § D2's 23,785 breakdown (23,780 through M5; M6 Task 7 added
    // `/watch` plus its four presets, +5, which this file's four ENTITY counts do not carry --
    // they are appended by app/sitemap.ts). Each of the four counts is measured
    // against the built database; a regression here is a real count drift, not a guess.
    const [routes, airports, carriers, aircraft] = await Promise.all([
      sitemapEntries("routes"),
      sitemapEntries("airports"),
      sitemapEntries("carriers"),
      sitemapEntries("aircraft"),
    ]);
    expect(routes).toHaveLength(22509);
    expect(airports).toHaveLength(1047);
    expect(carriers).toHaveLength(114);
    expect(aircraft).toHaveLength(110);
  });

  // (a) Quarantine scoping. Filtering `NOT is_quarantined` gives 1,043 airports, not 1,047.
  // Anchor on a SPECIFIC entity that resolves only because quarantined rows are counted:
  // A18, DJN, OQZ and POB are the four airports (measured) whose ONLY fct_segment_month rows
  // are quarantined -- excluding quarantine drops all four, which is exactly the class of bug
  // this test exists to catch (mutant 1: adding `WHERE NOT is_quarantined` to
  // sitemap_airports.sql must turn this red).
  it("includes an airport that appears ONLY in quarantined rows", async () => {
    const airports = await sitemapEntries("airports");
    const codes = new Set(airports.map((e) => e.url.split("/").pop()));
    expect(codes.has("A18")).toBe(true);
    expect(codes.has("DJN")).toBe(true);
    expect(codes.has("OQZ")).toBe(true);
    expect(codes.has("POB")).toBe(true);
  });

  // (b) lastmod is the entity's OWN last-filed month, never the build/current date.
  // /carrier/VX (Virgin America) last filed 2018-03 -- a fixture on an ACTIVE carrier cannot
  // fail this way, because its last filed month and the current window (data_as_of ==
  // 2026-05) coincide. This is the anchor the brief requires.
  it("dates a dormant carrier by ITS last filed month, not by the current window", async () => {
    const carriers = await sitemapEntries("carriers");
    const vx = carriers.find((e) => e.url.endsWith("/VX"));
    expect(vx).toBeDefined();
    expect(vx?.lastModified.toISOString()).toBe(new Date("2018-03-01T00:00:00Z").toISOString());
    // Not the build/current month -- pinning what it must NOT be is what distinguishes this
    // from a test that would pass even if lastModified were hardcoded to "today".
    expect(vx?.lastModified.getUTCFullYear()).not.toBe(new Date().getUTCFullYear());
  });

  // Companion fixture: an ACTIVE carrier's lastModified equals the dataset's current window
  // (2026-05). On its own this assertion is NOT sufficient to catch a build-date bug (the
  // brief's own point: "a fixture on an active entity cannot fail" that way) -- it exists so
  // the VX test above can be shown to be load-bearing by contrast (see task-5-report.md's
  // mutant 2).
  it("dates an active carrier by its last filed month too, which happens to be the current window", async () => {
    const carriers = await sitemapEntries("carriers");
    const dl = carriers.find((e) => e.url.endsWith("/DL"));
    expect(dl).toBeDefined();
    expect(dl?.lastModified.toISOString()).toBe(new Date("2026-05-01T00:00:00Z").toISOString());
  });

  // (c) Route URLs are the CODE-ALPHABETICAL canonical form, not the id-ordered pair
  // sitemap_routes.sql returns. Anchored on HPN/BNH -- the exact pair routePair.test.ts
  // anchors its own id-vs-alphabetical trap on: id order is HPN-BNH (HPN=12197, BNH=16954)
  // while the alphabetical canonical, and the only URL /route/<pair> itself ever 200s on, is
  // BNH-HPN. A fixture built on a pair where the two orderings agree (JFK-LAX, 22,294 of
  // 22,509) cannot fail this way.
  it("emits the code-alphabetical route URL, not the id-ordered pair", async () => {
    const routes = await sitemapEntries("routes");
    const urls = new Set(routes.map((e) => e.url));
    expect(urls.has("/route/BNH-HPN")).toBe(true);
    expect(urls.has("/route/HPN-BNH")).toBe(false);
  });

  it("builds airport, carrier and aircraft URLs under their own prefixes", async () => {
    const airports = await sitemapEntries("airports");
    expect(airports.some((e) => e.url === "/airport/SEA")).toBe(true);

    const carriers = await sitemapEntries("carriers");
    expect(carriers.some((e) => e.url === "/carrier/DL")).toBe(true);

    const aircraft = await sitemapEntries("aircraft");
    // A320-1/2 is one of the 15 fact-present short names carrying a '/', so its slug must
    // read A320-1-2 (aircraftSlug.ts's slugFor) -- an un-transformed short name would emit an
    // unroutable two-segment URL.
    expect(aircraft.some((e) => e.url === "/aircraft/A320-1-2")).toBe(true);
    // Every URL is exactly two path segments (the /aircraft/ prefix plus one slug) -- an
    // un-transformed short name containing '/' would produce a THIRD segment instead.
    expect(aircraft.every((e) => e.url.split("/").length === 3)).toBe(true);
  });

  // CE-180 (code 030 CESSNA 180, code 031 CESSNA 180A/B) resolves `ambiguous` and renders a
  // named-disambiguation 404, never a 200 -- lookup_aircraft_by_name.sql / aircraftSlug.ts's
  // resolveFromMatches. It must not appear in the sitemap.
  it("excludes the ambiguous aircraft short name CE-180", async () => {
    const aircraft = await sitemapEntries("aircraft");
    expect(aircraft.some((e) => e.url === "/aircraft/CE-180")).toBe(false);
  });

  // M6 Task 7: five URLs, one index plus one per preset, all under /watch/.
  it("emits /watch plus its four presets, five URLs total", async () => {
    const watch = await sitemapEntries("watch");
    const urls = watch.map((e) => e.url).sort();
    expect(urls).toEqual(
      ["/watch", "/watch/death-watch", "/watch/empty-planes", "/watch/gauge", "/watch/new-routes"].sort(),
    );
  });

  // THE property this kind exists to hold, and the one place it disagrees with every OTHER
  // kind in this file: lastModified is the dataset's asOf month, not a per-entity last-filed
  // month -- there is no per-entity date to read, since /watch and its presets are
  // dataset-WIDE views over mart_route_health, not one entity's own filing history. A test
  // that only checked "lastModified is defined" would also pass a build-date bug; anchoring on
  // the REAL asOf value (read independently via dataAsOf(), not re-derived from the sitemap
  // code under test) is what a build-date substitution would actually fail.
  it("dates every /watch URL by the dataset's asOf month, all five identically", async () => {
    const asOf = await dataAsOf();
    const expected = new Date(`${asOf}-01T00:00:00Z`).toISOString();
    const watch = await sitemapEntries("watch");
    expect(watch).toHaveLength(5);
    for (const entry of watch) {
      expect(entry.lastModified.toISOString()).toBe(expected);
    }
  });
});

// Task 3's original draft test called `sitemapEntries()` with no argument and read each
// entry's `.path` -- neither compiles (`sitemapEntries` requires a `SitemapKind`; entries carry
// `.url`, not `.path`), and no `SitemapKind` can ever emit an `/api/` path in the first place,
// so a `not.toContain("/api/health")` there could never fail under the bug it names -- exactly
// the vacuous-test failure CLAUDE.md's "run the mutant" rule exists to catch. This asserts an
// ALLOW-list instead, over the ASSEMBLED sitemap (`app/sitemap.ts`'s default export -- the
// artifact actually served at `/sitemap.xml`, not the per-kind builder underneath it): every
// URL must match one of the known page-route shapes. Same discipline `proxy.ts`'s own
// `isCacheable()` uses (CLAUDE.md: `kind === "ok" || kind === "redirect"`, never
// `!== "notFound"`) -- a negation of one bad shape lets every OTHER bad shape through; an
// allow-list of good shapes lets nothing else through.
describe("sitemap (assembled, app/sitemap.ts)", () => {
  it("emits only the known page-route shapes -- /route, /airport, /carrier, /aircraft, /watch", async () => {
    const entries = await sitemap();
    const paths = entries.map((e) => new URL(e.url).pathname);
    const KNOWN_SHAPE = /^\/(route\/[^/]+|airport\/[^/]+|carrier\/[^/]+|aircraft\/[^/]+|watch(\/[^/]+)?)$/;
    const unrecognized = paths.filter((p) => !KNOWN_SHAPE.test(p));
    // If this ever fails, `unrecognized` (not just a count) is what should be read first --
    // an `/api/health` entry smuggled into one kind's rows would show up here by name.
    expect(unrecognized).toEqual([]);

    // Anti-vacuity: prove the allow-list is actually exercised by a non-trivial, multi-shape
    // list, so a `sitemap()` that regressed to returning `[]` could not pass this test by
    // having nothing left to check.
    expect(paths.length).toBeGreaterThan(20000);
    expect(paths.some((p) => p.startsWith("/route/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/airport/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/carrier/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/aircraft/"))).toBe(true);
    expect(paths).toContain("/watch");

    // The specific claim Task 3 exists to pin, restated as its own assertion rather than left
    // to be an implication of the allow-list above.
    expect(paths).not.toContain("/api/health");
  });
});

describe("robots", () => {
  // /watch is a closed, shareable set of four presets -- the whole point of Gauge Watch
  // leading, per docs/product/features.md -- and must stay crawlable, unlike /search's
  // unbounded query space (disallowed for exactly that reason, robots.ts's own header). No
  // change to robots.ts is expected from M6 Task 7; this test PINS that absence of a change
  // rather than assuming it silently holds.
  it("does not disallow /watch", () => {
    const { rules } = robots();
    const ruleList = Array.isArray(rules) ? rules : [rules];
    for (const rule of ruleList) {
      const disallow = Array.isArray(rule.disallow)
        ? rule.disallow
        : rule.disallow
          ? [rule.disallow]
          : [];
      expect(disallow).not.toContain("/watch");
      expect(disallow).not.toContain("/watch/");
    }
  });
});

describe("parseLastmod", () => {
  it("parses the sitemap_*.sql lastmod convention (YYYY-MM-01) as UTC midnight", () => {
    const d = parseLastmod("2018-03-01", "test");
    expect(d.toISOString()).toBe("2018-03-01T00:00:00.000Z");
  });

  it("throws, naming the context, on a non-string value", () => {
    expect(() => parseLastmod(null, "route BNH-HPN")).toThrow(/route BNH-HPN/);
    expect(() => parseLastmod(42, "route BNH-HPN")).toThrow(/route BNH-HPN/);
  });

  it("throws, naming the context, on a malformed date string", () => {
    expect(() => parseLastmod("not-a-date", "carrier VX")).toThrow(/carrier VX/);
  });
});

describe("dedupeAircraftBySlug", () => {
  it("passes distinct short names through untouched", () => {
    const out = dedupeAircraftBySlug([
      { shortName: "B737-8", lastmod: "2026-04-01" },
      { shortName: "ERJ-175", lastmod: "2025-01-01" },
    ]);
    expect(out.size).toBe(2);
    expect(out.get("B737-8")?.shortName).toBe("B737-8");
    expect(out.get("ERJ-175")?.shortName).toBe("ERJ-175");
  });

  // The property this function exists to hold: slugFor() is many-to-one ('/' and ' ' both
  // become '-'), so two DIFFERENT short names CAN collide on the same slug -- there is no
  // live example in today's catalog (aircraftSlug.ts's header: injective over all 111
  // fact-present names, measured), so this is the only way to exercise the guard at all.
  it("throws, naming both short names, on a slugFor collision between two different names", () => {
    expect(() =>
      dedupeAircraftBySlug([
        { shortName: "A320-1-2", lastmod: "2026-04-01" },
        { shortName: "A320-1/2", lastmod: "2025-01-01" },
      ]),
    ).toThrow(/A320-1-2/);
  });
});
