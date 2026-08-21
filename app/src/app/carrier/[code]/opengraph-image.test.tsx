import { describe, expect, it } from "vitest";
import Image, { alt, contentType, dynamic, size } from "@/app/carrier/[code]/opengraph-image";

/** Real route, real `upgauge.duckdb`, no mock -- see route/[pair]/opengraph-image.test.tsx's
 * header for why the resolution contract is what these assert. */
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

describe("/carrier/<code> opengraph-image", () => {
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
  // Also pins the operating-carrier claim -- every figure on this card is what THIS carrier
  // operated, and a regional partner's flying is counted under the partner's own code.
  it("exports alt text saying the figures are what the carrier operated", () => {
    expect(alt).toMatch(/operated/i);
  });

  // THE BUG THIS CATCHES: an unknown code rendering a card of zeroes instead of 404ing. ZZ is
  // in `dim_carrier` not at all (measured, lib/carrier.ts).
  it("404s for an unknown code", async () => {
    expect(await catchDigest("ZZ")).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("redirects a lowercase code permanently to the canonical card", async () => {
    expect(await catchDigest("dl")).toBe("NEXT_REDIRECT;replace;/carrier/DL/opengraph-image;308;");
  });

  it("returns a PNG response for a known code", async () => {
    const res = await Image({ params: Promise.resolve({ code: "DL" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  // VX stopped filing in 2018-03 (measured) -- the trailing-12 query returns zero rows, so the
  // stat row is all dashes and only the chart has anything in it. A card that threw here, or
  // that printed 0.00% load factor for "nobody flew", would be the absence-as-measurement bug
  // lib/format.ts exists to prevent, on the 39% of this dataset's carriers that are dormant.
  it("still renders for a carrier that has stopped filing", async () => {
    const res = await Image({ params: Promise.resolve({ code: "VX" }) });
    expect(res.status).toBe(200);
  });
});
