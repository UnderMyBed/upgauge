import { describe, expect, it, vi } from "vitest";

// THE LAST HOP INTO AN ImageResponse, which nothing else can reach. `Image()` returns a PNG
// stream and hands nothing back, so no assertion that calls a helper directly can see whether the
// default export still calls it -- measured during #118, replacing this route's sixth-stat call
// with a hard-coded literal left all 1,464 tests green. That was the third instance of the shape
// in one change (`<Chart note={null} />`, the `cardSixthStat` literal, and this), and extracting a
// function to "make the wiring testable" only moves the unpinned hop up one level unless
// something actually invokes the caller. #121 deleted the extracted helper for that reason; the
// spy below is what was doing the work all along.
//
// `renderEntityCard` is the seam. The spy CALLS THROUGH to the real implementation rather than
// standing in for it, so the route still rasterizes a real card and this file's existing
// "returns a PNG response" assertion keeps testing what it always did -- the spy only records
// the `CardInput` on its way past. `importOriginal` also keeps `CARD_SIZE`, which this route
// imports from the same module.
const renderSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/og/card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/og/card")>();
  renderSpy.mockImplementation(actual.renderEntityCard);
  return { ...actual, renderEntityCard: renderSpy };
});
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

// ---------------------------------------------------------------------------------------
// THE COMPOSITION, THROUGH THE REAL ROUTE ONLY. `cardSixthStat`'s four cells are asserted where
// it lives (lib/og/entityCard.test.ts); what is left to pin here is that THIS page pairs it with
// the right fallback and the right five measures -- and that hop cannot be reached by calling an
// exported helper, because `Image()` returns a PNG stream and hands nothing back.
//
// This file used to call an exported `airportCardStats` for three of these cases. #121 deleted
// that wrapper (every card now composes `cardStats` with `cardSixthStat` inline, so it named
// nothing the expression does not), and its own docstring had already recorded that calling it
// from a test proved nothing about the route: replacing the call with a hard-coded `Carriers`
// literal left the whole suite green. Every case it covered is below, driven through the spy,
// where the same mutant dies.
describe("the default export's card input", () => {
  // A18 and 05A are the two absences, and both have fewer than two filed months, so `cardChart`
  // returns early and no Plot/jsdom rendering happens in this node-environment file.
  async function cardInputFor(code: string) {
    renderSpy.mockClear();
    await Image({ params: Promise.resolve({ code }) });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    return renderSpy.mock.calls[0][0] as { stats: { label: string; value: string }[]; chartNote: string | null };
  }

  it("rasterizes the quarantined count on a wholly-quarantined airport", async () => {
    // MUTANT: `stats: cardStats(totals, { label: "Carriers", ... })` at the render call -> red.
    // Verified: that mutant previously survived the entire suite.
    const input = await cardInputFor("A18");
    expect(input.stats.map((s) => s.label)).toEqual([
      "Seats", "Passengers", "Load factor", "Avg gauge", "Departures", "Quarantined",
    ]);
    expect(input.stats[5].value).toBe("1");
    expect(input.stats.slice(0, 5).map((s) => s.value)).toEqual(["—", "—", "—", "—", "—"]);
  });

  it("rasterizes the carrier count on an airport that filed nothing", async () => {
    // The 290-page cell, through the real route. A card keyed on the null alone says
    // "Quarantined 0" here -- naming the one cause it is not.
    const input = await cardInputFor("05A");
    expect(input.stats[5]).toEqual({ label: "Carriers", value: "0" });
  });

  it("keeps the entity count on a page with quarantined rows beside real traffic", async () => {
    // THE THIRD BRANCH, and the one that makes the second operand non-deletable. STT filed 9
    // quarantined rows in this window AND 2,081,101 stateable seats across 16 carriers -- 24 of
    // the 29 /airport pages carrying a quarantined group look like this. Its measures are
    // honest and its sixth stat must stay the carrier count.
    //
    // MUTANT: key `cardSixthStat` on `quarantinedRows > 0` alone -> STT flips to
    // "Quarantined 9" -> red HERE. MUTANT: key it on `totals.seats === null` alone -> STT is
    // unaffected, but 05A above flips to "Quarantined 0", naming the one cause it is not
    // -> red THERE. Neither test catches the other's mutant, which is why both exist.
    const input = await cardInputFor("STT");
    expect(input.stats[5]).toEqual({ label: "Carriers", value: "16" });
    expect(input.stats.map((x) => x.value)).not.toContain("—");
  });

  it("rasterizes the page's own no-chart sentence, not a card-local one", async () => {
    // The other hop this file is the only place to reach: `chartNote` reaching `renderEntityCard`
    // at all. `card.test.tsx` pins that CardFrame RENDERS a note it is given; this pins that the
    // route SUPPLIES one.
    // MUTANT: `chartNote: null` at the render call -> red.
    const input = await cardInputFor("A18");
    // A18's ONE filed month is itself wholly quarantined, so "only one month of filings" was
    // true and useless -- it described the count and not the finding, on a card with no foot and
    // no aria-label to add one. `mixAbsenceNote`'s third branch names the cause instead.
    // MUTANT: call `mixAbsenceNote(months, dimension)` without the stateable set -> the old
    // sentence returns -> red.
    expect(input.chartNote).toBe(
      "1 month of filings in this window, wholly quarantined — every filing failed an " +
        "invariant, so no aircraft-type seats can be stated and there is nothing to draw.",
    );
  });
});
