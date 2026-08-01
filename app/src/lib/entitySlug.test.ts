import { describe, expect, it } from "vitest";
import { entitySlugFromPath } from "@/lib/entitySlug";

// The four real prefixes this function was collapsed out of, so every property below is
// checked against all four rather than against one representative -- the whole point of
// collapsing four copies into one implementation is that a single mutation here breaks all
// four entity pages at once. See rawPath.test.ts, carrier.test.ts, aircraftSlug.test.ts and
// airport/[code]/not-found.test.tsx for the per-module wrapper tests this file's properties
// feed.
const PREFIXES = ["/route/", "/airport/", "/carrier/", "/aircraft/"];

describe("entitySlugFromPath", () => {
  it("reads the slug out of a matching pathname", () => {
    expect(entitySlugFromPath("/carrier/DL", "/carrier/")).toBe("DL");
    expect(entitySlugFromPath("/route/JFK-LAX", "/route/")).toBe("JFK-LAX");
    expect(entitySlugFromPath("/airport/SEA", "/airport/")).toBe("SEA");
    expect(entitySlugFromPath("/aircraft/B737-8", "/aircraft/")).toBe("B737-8");
  });

  it("returns null for a pathname that does not start with the prefix", () => {
    for (const prefix of PREFIXES) {
      expect(entitySlugFromPath("/explore", prefix)).toBeNull();
      expect(entitySlugFromPath("/somewhere/else", prefix)).toBeNull();
      // The prefix with its trailing slash stripped must NOT match -- otherwise `/carrier`
      // (no slash) would be treated as a valid, empty slug.
      expect(entitySlugFromPath(prefix.slice(0, -1), prefix)).toBeNull();
    }
  });

  it("percent-decodes, matching what the page receives in params", () => {
    expect(entitySlugFromPath("/carrier/%39E", "/carrier/")).toBe("9E");
    expect(entitySlugFromPath("/route/JFK%2DLAX", "/route/")).toBe("JFK-LAX");
  });

  it("falls back to the raw text on a malformed escape instead of throwing, for all four prefixes", () => {
    // decodeURIComponent THROWS on both of these. If the try/catch in entitySlugFromPath is
    // ever removed, EVERY one of these four assertions goes red together -- and so does every
    // sibling test in rawPath.test.ts, carrier.test.ts, aircraftSlug.test.ts and
    // airport/[code]/not-found.test.tsx, since all four wrapper functions now delegate here.
    // That simultaneity is the entire point of the collapse: before it, the same mutation in
    // one copy left the other three modules' guards untouched.
    for (const prefix of PREFIXES) {
      expect(entitySlugFromPath(`${prefix}%zz`, prefix)).toBe("%zz");
      expect(entitySlugFromPath(`${prefix}%E0%A4%A`, prefix)).toBe("%E0%A4%A");
    }
  });

  it("returns the empty string for a bare trailing slash, not null", () => {
    // airportSlugFromPath (lib/airport.ts) is the one caller that maps this particular result
    // to null -- a quirk pinned by its own test, layered on TOP of this function rather than
    // reproduced inside it. This function itself treats all four prefixes alike.
    for (const prefix of PREFIXES) {
      expect(entitySlugFromPath(prefix, prefix)).toBe("");
    }
  });

  it("returns whatever follows the prefix verbatim, including embedded slashes", () => {
    for (const prefix of PREFIXES) {
      expect(entitySlugFromPath(`${prefix}DL/extra`, prefix)).toBe("DL/extra");
    }
  });
});
