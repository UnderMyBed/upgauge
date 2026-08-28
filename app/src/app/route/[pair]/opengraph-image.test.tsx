import { describe, expect, it, vi } from "vitest";

// THE LAST HOP INTO AN `ImageResponse`, which nothing else can reach. `Image()` returns a PNG
// stream and hands nothing back, so every other assertion in this file settles the RESOLUTION
// contract and none of them can see which sixth stat the card was built with. #118 measured that
// shape three times in one cycle, each with a full green suite; extracting a helper to "make the
// wiring testable" only moves the unpinned hop up one level unless something invokes the caller.
//
// `renderEntityCard` is the seam. The spy CALLS THROUGH to the real implementation rather than
// standing in for it, so the route still rasterizes a real card and this file's existing "returns
// a PNG response" assertion keeps testing what it always did -- the spy only records the
// `CardInput` on its way past. `importOriginal` also keeps `CARD_SIZE`, which this route imports
// from the same module.
const renderSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/og/card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/og/card")>();
  renderSpy.mockImplementation(actual.renderEntityCard);
  return { ...actual, renderEntityCard: renderSpy };
});
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

// ---------------------------------------------------------------------------------------
// THE CARD'S SIXTH STAT (#121). `sumTotals` used to coerce an unknowable sum to 0, so this card
// rasterized `SEATS 0 · PASSENGERS 0 · DEPARTURES 0 · CARRIERS 1` on 10 reachable route pages --
// figures contradicted by the very filings behind them, each a performed departure against a
// filed seat count of zero. With the fold fixed those five become `—`, and a card has no foot, no
// empty state and no `aria-label`, so the sixth stat is the only place left to explain them.
//
// `cardSixthStat`'s four cells are asserted where it lives (lib/og/entityCard.test.ts). What is
// pinned here is that THIS route reaches it, with THIS page's fallback, on real data.
describe("the default export's card input", () => {
  async function cardInputFor(pair: string) {
    renderSpy.mockClear();
    await Image({ params: Promise.resolve({ pair }) });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    return renderSpy.mock.calls[0][0] as {
      stats: { label: string; value: string }[];
      gaps: number;
      unknowable: number;
      understated: number;
    };
  }

  // A18-LMA (Kantishna-Lake Minchumina): its entire trailing 12 is ONE filing, 2025-06, seats 0
  // against 1 PERFORMED departure, quarantined `zero_seats`. One of the 10 pages this issue is
  // about.
  //
  // THE ORDER IS PART OF THE ASSERTION, not decoration. Load factor and average gauge rendered
  // `—` even under the bug (their denominators were zero either way), so "the card contains a
  // dash" passed against the buggy card. Only the first five ALL being dashes separates
  // `0 · 0 · — · — · 0` from `— · — · — · — · —`.
  //
  // MUTANT: `stats: cardStats(totals, { label: "Carriers", value: ... })` at the render call
  // (the pre-#121 line) -> the sixth stat reads `Carriers 1` -> red.
  // MUTANT: restore `?? 0` in `sumColumn` -> the first five read `0 · 0 · — · — · 0` -> red.
  it("rasterizes the quarantined count on a wholly-quarantined pair", async () => {
    const input = await cardInputFor("A18-LMA");
    expect(input.stats.map((s) => s.label)).toEqual([
      "Seats", "Passengers", "Load factor", "Avg gauge", "Departures", "Quarantined",
    ]);
    expect(input.stats[5].value).toBe("1");
    expect(input.stats.slice(0, 5).map((s) => s.value)).toEqual(["—", "—", "—", "—", "—"]);
  });

  // QUARANTINE BESIDE REAL TRAFFIC, which is what makes the gate's second operand undeletable.
  // AKP-FAI filed 7 quarantined rows AND stateable traffic across 2 carriers in this window. Its
  // measures are honest and its sixth stat must stay the carrier count.
  // MUTANT: key `cardSixthStat` on `quarantinedRows > 0` alone -> `Quarantined 7` here -> red.
  it("keeps the carrier count where quarantined rows sit beside stateable traffic", async () => {
    const input = await cardInputFor("AKP-FAI");
    expect(input.stats[5]).toEqual({ label: "Carriers", value: "2" });
    expect(input.stats.map((s) => s.value)).not.toContain("—");
  });

  // THE OTHER ABSENCE. ATL-CAK filed 67 months and nothing since 2022-06, so the trailing-12
  // pivot returns NO rows -- unknowable for a reason quarantine had no part in, which is the
  // state 12,115 of this database's route pairs are in.
  // MUTANT: key `cardSixthStat` on `totals.seats === null` alone -> `Quarantined 0` here, naming
  // the one cause it is not and withholding nothing that would explain the dashes -> red.
  // MUTANT: seed `sumColumn` at 0 -> the first five stop being dashes -> red.
  it("keeps the carrier count on a pair that filed nothing in the window", async () => {
    const input = await cardInputFor("ATL-CAK");
    expect(input.stats[5]).toEqual({ label: "Carriers", value: "0" });
    expect(input.stats.slice(0, 5).map((s) => s.value)).toEqual(["—", "—", "—", "—", "—"]);
  });
});

describe("the card's absence counts reach renderEntityCard", () => {
  async function cardInputFor(pair: string) {
    renderSpy.mockClear();
    await Image({ params: Promise.resolve({ pair }) });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    return renderSpy.mock.calls[0][0] as {
      gaps: number;
      unknowable: number;
      understated: number;
    };
  }

  // THE LAST HOP, on real data. `entityCard.test.ts` pins that `cardChart` computes these and
  // `card.test.tsx` pins that `CardFrame` renders them; neither can see whether THIS route still
  // passes them across. Review's mutant -- hard-coding both to 0 -- left all 82 og tests green,
  // and `smoke.sh` cannot reach a rasterized PNG.
  //
  // DFW-SJU 2020-05 is one filed cell, quarantined, with ordinary months either side.
  // MUTANT: `unknowable: 0` at the render call -> red.
  it("carries the wholly-quarantined count for a route that has one", async () => {
    const input = await cardInputFor("DFW-SJU");
    expect(input.unknowable).toBe(1);
  });

  // HNL-OGG's ATR-72 is quarantined beside three types filing real seats, across 11 months.
  // MUTANT: `understated: 0` at the render call -> red. A separate route from the one above, so
  // neither count can pass by borrowing the other's.
  it("carries the understated count for a route that has one", async () => {
    const input = await cardInputFor("HNL-OGG");
    expect(input.understated).toBe(11);
    expect(input.unknowable).toBe(0);
  });
});
