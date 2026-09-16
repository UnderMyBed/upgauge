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

  // THE BUG THIS EXISTS TO CATCH: a reader that accepts a nested remainder -- so
  // carrierSlugFromPath("/carrier/DL/opengraph-image") returns "DL/opengraph-image" instead of
  // null -- would send a card URL to the carrier 404 view instead of recognizing it as
  // not-an-entity-page. A "/carrier/DL" fixture cannot catch this: only a path whose remainder
  // past the slug is itself a second raw segment (the `opengraph-image` suffix) can.
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
