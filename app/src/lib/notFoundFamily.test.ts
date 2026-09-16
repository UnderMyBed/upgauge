import { describe, it, expect } from "vitest";
import { notFoundFamilyFromPath } from "./notFoundFamily";

describe("notFoundFamilyFromPath", () => {
  it.each([
    ["/route/ZZZZ-LAX", "route"],
    ["/airport/ZZZZ", "airport"],
    ["/carrier/ZZZ", "carrier"],
    ["/aircraft/NOPE-1", "aircraft"],
    ["/watch/nope", "watch"],
    ["/explore/filter/not_a_dimension", "filter"],
  ])("%s belongs to the %s family", (pathname, family) => {
    expect(notFoundFamilyFromPath(pathname)).toBe(family);
  });

  // THE BUG THIS EXISTS TO CATCH: every entity slug reader is a bare prefix test that does not
  // stop at one segment, so carrierSlugFromPath("/carrier/DL/opengraph-image") is
  // "DL/opengraph-image", not null. proxy.ts already orders its OG loop above its entity
  // branches for exactly this reason. A dispatcher that tests the entity prefixes first would
  // render the carrier 404 view for a card URL, and the fixture that catches it MUST be an OG
  // path -- a "/carrier/DL" fixture cannot fail this way.
  it.each([
    "/route/JFK-LAX/opengraph-image",
    "/airport/ORD/opengraph-image",
    "/carrier/DL/opengraph-image",
    "/aircraft/737-800/opengraph-image",
  ])("%s is not an entity page", (pathname) => {
    expect(notFoundFamilyFromPath(pathname)).toBeNull();
  });

  it.each(["/nope", "/", "/explore", "/watch", "/search", "/wp-login.php"])(
    "%s belongs to no family",
    (pathname) => {
      expect(notFoundFamilyFromPath(pathname)).toBeNull();
    },
  );

  it.each([
    "/carrier/DL/x",
    "/route/JFK-LAX/x",
    "/airport/ORD/x",
    "/aircraft/737-800/x",
    "/watch/gauge/x",
    "/explore/filter/origin_state/x",
    "/carrier/DL/opengraph-image/x",
  ])("gives the nested path %s no family -- it routes nowhere", (pathname) => {
    expect(notFoundFamilyFromPath(pathname)).toBeNull();
  });

  it("keeps an encoded slash inside one segment", () => {
    expect(notFoundFamilyFromPath("/carrier/D%2FL")).toBe("carrier");
  });
});
