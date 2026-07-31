import { describe, expect, it } from "vitest";
import {
  MissingRawPathError,
  RAW_PATH_HEADER,
  rawPathFromHeaders,
  routeSlugFromPath,
} from "@/lib/rawPath";

// A real Headers object, not a mock -- same discipline as rawQuery.test.ts.
describe("rawPathFromHeaders", () => {
  it("returns the pathname verbatim", () => {
    const headers = new Headers({ [RAW_PATH_HEADER]: "/route/JFK-LAX" });
    expect(rawPathFromHeaders(headers)).toBe("/route/JFK-LAX");
  });

  it("throws rather than guessing when proxy.ts did not run", () => {
    expect(() => rawPathFromHeaders(new Headers())).toThrow(MissingRawPathError);
  });

  it("treats an empty header as absence, unlike the raw query string", () => {
    // "" is a legitimate query string but never a legitimate pathname, so the two helpers
    // deliberately differ here. Falling through with "" would render the generic 404.
    expect(() => rawPathFromHeaders(new Headers({ [RAW_PATH_HEADER]: "" }))).toThrow(
      MissingRawPathError,
    );
  });

  it("names the header and the file to check in the error", () => {
    expect(() => rawPathFromHeaders(new Headers())).toThrow(/proxy\.ts/);
    expect(() => rawPathFromHeaders(new Headers())).toThrow(new RegExp(RAW_PATH_HEADER));
  });
});

describe("routeSlugFromPath", () => {
  it("extracts the pair from a /route/ pathname", () => {
    expect(routeSlugFromPath("/route/JFK-LAX")).toBe("JFK-LAX");
  });

  it("returns null for any other page, so the 404 body and the cache rule both opt out", () => {
    expect(routeSlugFromPath("/explore")).toBeNull();
    expect(routeSlugFromPath("/")).toBeNull();
    // Not "/route/" -- the prefix must be exact, or proxy.ts would run a database lookup for
    // a future unrelated top-level route.
    expect(routeSlugFromPath("/routes/JFK-LAX")).toBeNull();
  });

  it("percent-decodes, because the page receives params.pair already decoded", () => {
    // Without this the proxy would resolve `JFK%2DLAX` (unknown) while page.tsx resolves
    // `JFK-LAX` (known), and the 200 would ship `no-store`.
    expect(routeSlugFromPath("/route/JFK%2DLAX")).toBe("JFK-LAX");
  });

  it("returns the raw text rather than throwing on a malformed escape", () => {
    // decodeURIComponent THROWS on `%zz`. That is bug #2 on smoke.sh's list of
    // production-only failures; an uncaught throw here would 500 the proxy, i.e. every
    // request to a route page, on a URL anyone can type.
    expect(routeSlugFromPath("/route/%zz-LAX")).toBe("%zz-LAX");
  });
});
