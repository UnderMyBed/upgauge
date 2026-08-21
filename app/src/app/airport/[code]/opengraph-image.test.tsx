import { describe, expect, it } from "vitest";
import Image, { alt, contentType, dynamic, size } from "@/app/airport/[code]/opengraph-image";

/** Real route, real `upgauge.duckdb`, no mock -- see route/[pair]/opengraph-image.test.tsx's
 * header for why the resolution contract is what these assert and why a mocked resolver would
 * pass against the very bug they exist to catch. */
async function catchDigest(code: string): Promise<string> {
  try {
    await Image({ params: Promise.resolve({ code }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`Image(${JSON.stringify(code)}) did not throw`);
}

describe("/airport/<code> opengraph-image", () => {
  it("declares 1200x630 and image/png", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  // THE BUG THIS CATCHES: `export const dynamic = "force-dynamic"` deleted from the route. Next
  // statically optimizes a file-convention OG image unless the route opts out (its own
  // convention doc: generated images are "generated at build time and cached" unless they use
  // request-time APIs or uncached data, and a DuckDB read is neither), so every share of this
  // card would carry the DATA AS OF and the totals of whenever it was first rasterized. No
  // served-build gate can see it either: within one run a card frozen at its first render is
  // byte-identical to a correct one.
  it("opts out of static optimization", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  // THE BUG THIS CATCHES: no `alt` export, so Next emits an og:image with no og:image:alt.
  // Also pins the both-endpoint claim: an origin-only reading of this card is silently about
  // half the airport, so the alt has to say which one it is.
  it("exports alt text naming both endpoints", () => {
    expect(alt).toMatch(/both endpoints/i);
  });

  // THE BUG THIS CATCHES: an unknown slug rendering a card of zeroes instead of 404ing. The
  // page 404s; a card that disagrees is an invented data view, and the proxy would cache it.
  it("404s for an unknown code", async () => {
    expect(await catchDigest("ZZZZ")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("redirects a lowercase code permanently to the canonical card", async () => {
    expect(await catchDigest("sea")).toBe(
      "NEXT_REDIRECT;replace;/airport/SEA/opengraph-image;308;",
    );
  });

  it("returns a PNG response for a known code", async () => {
    const res = await Image({ params: Promise.resolve({ code: "SEA" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });
});
