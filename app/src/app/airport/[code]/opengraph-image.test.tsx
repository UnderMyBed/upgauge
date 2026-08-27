import { describe, expect, it, vi } from "vitest";

// THE LAST HOP INTO AN ImageResponse, which nothing else can reach. `Image()` returns a PNG
// stream, so every other assertion in this file calls the route's EXPORTED helpers directly and
// none of them can see whether the default export still calls them -- measured, replacing
// `stats: airportCardStats(totals)` with a hard-coded literal left all 1,464 tests green. That
// is the third instance of this shape in one change (`<Chart note={null} />`, the `cardSixthStat`
// literal, and this), and extracting a function to "make the wiring testable" only moves the
// unpinned hop up one level unless something actually invokes the caller.
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
import Image, {
  airportCardStats,
  alt,
  contentType,
  dynamic,
  size,
} from "@/app/airport/[code]/opengraph-image";

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
// THE COMPOSITION, not the rule and not the wiring. `cardSixthStat`'s four cells are asserted
// where it lives (lib/og/entityCard.test.ts); these assert that THIS page pairs it with the
// right fallback and the right five measures. They call the exported function directly, so they
// cannot see whether `Image()` still calls it -- that hop needs the spy in the describe below,
// and believing these covered it is what left the mutant alive.
describe("the card's stat row composes the shared rule with this page's fallback", () => {
  const base = { loadFactor: null, avgGauge: null, carriers: 1, destinations: 1 };

  it("carries the quarantined count when no measure can be stated", () => {
    // MUTANT: inline `{ label: "Carriers", ... }` in place of the cardSixthStat call -> red.
    const stats = airportCardStats({
      ...base, seats: null, passengers: null, departures: null, quarantinedRows: 1,
    });
    expect(stats).toHaveLength(6);
    expect(stats[5]).toEqual({ label: "Quarantined", value: "1" });
    expect(stats.slice(0, 5).map((s) => s.value)).toEqual(["—", "—", "—", "—", "—"]);
  });

  it("carries the carrier count on a page that filed nothing", () => {
    // The 290-page cell, through the real composition.
    const stats = airportCardStats({
      ...base, seats: null, passengers: null, departures: null, quarantinedRows: 0, carriers: 0,
    });
    expect(stats[5]).toEqual({ label: "Carriers", value: "0" });
  });

  it("carries the carrier count on an ordinary page", () => {
    const stats = airportCardStats({
      ...base, seats: 100, passengers: 90, departures: 4, quarantinedRows: 0, carriers: 7,
    });
    expect(stats[5]).toEqual({ label: "Carriers", value: "7" });
    expect(stats[0]).toEqual({ label: "Seats", value: "100" });
  });
});

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

  it("rasterizes the page's own no-chart sentence, not a card-local one", async () => {
    // The other hop this file is the only place to reach: `chartNote` reaching `renderEntityCard`
    // at all. `card.test.tsx` pins that CardFrame RENDERS a note it is given; this pins that the
    // route SUPPLIES one.
    // MUTANT: `chartNote: null` at the render call -> red.
    const input = await cardInputFor("A18");
    expect(input.chartNote).toBe(
      "Only one month of filings in this window (2025-06) — a stacked area needs at least two.",
    );
  });
});
