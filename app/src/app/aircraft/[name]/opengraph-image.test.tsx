import { describe, expect, it } from "vitest";
import Image, { alt, contentType, size } from "@/app/aircraft/[name]/opengraph-image";

/** Real route, real `upgauge.duckdb`, no mock -- see route/[pair]/opengraph-image.test.tsx's
 * header. It matters most on THIS route: `resolveAircraftSlug` is the four-outcome resolver,
 * and a mocked one would return whichever three the test author remembered. */
async function catchDigest(name: string): Promise<string> {
  try {
    await Image({ params: Promise.resolve({ name }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`Image(${JSON.stringify(name)}) did not throw`);
}

describe("/aircraft/<slug> opengraph-image", () => {
  it("declares 1200x630 and image/png", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  // THE BUG THIS CATCHES: no `alt` export, so Next emits an og:image with no og:image:alt.
  // Also pins the stack: this card's chart is banded by operating CARRIER, not by aircraft
  // type -- a page that IS one type would otherwise draw a single band encoding nothing.
  it("exports alt text naming the operating-carrier stack", () => {
    expect(alt).toMatch(/by operating carrier/i);
  });

  it("404s for an unknown short name", async () => {
    expect(await catchDigest("NOPE-1")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  // THE BUG THIS CATCHES, and it is the reason the outcome check is an allow-list rather than
  // `kind !== "notFound"`: CE-180 identifies TWO fact-present BTS codes (030 CESSNA 180 and
  // 031 CESSNA 180A/B), so `resolveAircraftSlug` returns `ambiguous` -- not `notFound`. Under
  // the negated form this route would card ONE of the two airframes, under a URL its own page
  // 404s, and the proxy would cache the pick. Picking one is exactly the silent-pick failure
  // the four-way split exists to refuse.
  it("404s for an ambiguous short name rather than picking one of the two airframes", async () => {
    expect(await catchDigest("CE-180")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("redirects a lowercase slug permanently to the canonical card", async () => {
    expect(await catchDigest("a320-1-2")).toBe(
      "NEXT_REDIRECT;replace;/aircraft/A320-1-2/opengraph-image;308;",
    );
  });

  it("returns a PNG response for a known type", async () => {
    const res = await Image({ params: Promise.resolve({ name: "B737-8" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });
});
