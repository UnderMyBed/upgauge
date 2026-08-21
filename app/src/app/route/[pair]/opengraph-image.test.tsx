import { describe, expect, it } from "vitest";
import Image, { alt, contentType, dynamic, size } from "@/app/route/[pair]/opengraph-image";

/** Drives the real route against the real `upgauge.duckdb` -- no mock. A mocked
 * `resolveRoutePair` would return whatever shape the test asked for and would pass against the
 * exact bug these tests exist to catch (this codebase has no mocks: lib/resolve.ts's header).
 *
 * The assertions are about RESOLUTION, not pixels: rasterizing in a unit test is slow and
 * proves nothing `make app-smoke` against a served build does not prove better. `ImageResponse`
 * extends `Response` and builds its body as a lazy `ReadableStream`
 * (node_modules/next/dist/server/og/image-response.js), so reading `.status` and the
 * content-type header settles the contract without rasterizing.
 *
 * `notFound()`/`permanentRedirect()` throw digest-carrying Errors rather than returning, so the
 * 404 and redirect cases are asserted by catching the throw -- the same mechanism, read off the
 * same Next source, that page.test.tsx already pins. */
async function catchDigest(pair: string): Promise<string> {
  try {
    await Image({ params: Promise.resolve({ pair }) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`Image(${JSON.stringify(pair)}) did not throw`);
}

describe("/route/<pair> opengraph-image", () => {
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

  // THE BUG THIS CATCHES: no `alt` export, so Next emits an og:image with no og:image:alt --
  // an untexted image on a site whose every chart carries a real aria-label.
  it("exports alt text describing the card's contents", () => {
    expect(alt).toMatch(/seats/i);
    expect(alt.length).toBeGreaterThan(40);
  });

  // THE BUG THIS CATCHES: an unknown slug rendering a card of empty/zero data instead of
  // 404ing. The page 404s; a card that disagrees is an invented data view -- and it would be
  // cached, because the proxy resolves cacheability from the same slug.
  it("404s for an unknown pair", async () => {
    expect(await catchDigest("ZZZZ-LAX")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("404s for a slug that is not two codes", async () => {
    expect(await catchDigest("JFK")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  // 308 and not 307, and to the CARD's path rather than the page's: a card served under two
  // URLs is two CDN entries for one image.
  it("redirects a reversed pair permanently to the canonical card", async () => {
    expect(await catchDigest("LAX-JFK")).toBe(
      "NEXT_REDIRECT;replace;/route/JFK-LAX/opengraph-image;308;",
    );
  });

  it("returns a PNG response for a known pair", async () => {
    const res = await Image({ params: Promise.resolve({ pair: "JFK-LAX" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });
});
