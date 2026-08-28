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

// AND A SECOND SEAM, WHICH ONLY THIS ROUTE NEEDS. Measured: replacing this route's
// `cardSixthStat(...)` call with the bare `{ label: "Aircraft types", ... }` literal it falls
// back to leaves every other test in this file GREEN -- because no carrier's every trailing-12
// filing is quarantined on this warehouse, so the shared rule and the inlined literal return the
// same object for every carrier that exists. That is a deletable call site: the #118 shape
// exactly, and the reason this file cannot stop at the card-input spy the way /route and
// /aircraft can, where a wholly-quarantined fixture separates the two.
//
// So the hop itself is what gets pinned: `cardSixthStat` is spied CALLING THROUGH to the real
// implementation, and the assertion is that this route invokes it with the page's own operands.
// No data is faked and no branch is simulated -- the rule's four cells stay asserted in
// lib/og/entityCard.test.ts, and its live behaviour on real quarantined data stays asserted on
// the three routes that can reach it.
const sixthSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/og/entityCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/og/entityCard")>();
  sixthSpy.mockImplementation(actual.cardSixthStat);
  return { ...actual, cardSixthStat: sixthSpy };
});
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

// ---------------------------------------------------------------------------------------
// THE CARD'S SIXTH STAT (#121), and the one honest limit in this change: NO CARRIER'S every
// trailing-12 filing is quarantined on this warehouse (measured), so this route cannot reach the
// `Quarantined` branch with real data. It is the same shared `cardSixthStat` the other three
// cards call, its four cells are asserted in lib/og/entityCard.test.ts, and it is driven live on
// /route, /aircraft and /airport. What these pin is that THIS route reaches it at all, and that
// the branch it DOES take on real data is the right one.
describe("the default export's card input", () => {
  async function cardInputFor(code: string) {
    renderSpy.mockClear();
    await Image({ params: Promise.resolve({ code }) });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    return renderSpy.mock.calls[0][0] as { stats: { label: string; value: string }[] };
  }

  // QUARANTINE BESIDE REAL TRAFFIC, and this carrier is the extreme of it: Wright Air Service
  // filed 118 quarantined rows in this window alongside stateable traffic on 3 aircraft types.
  // Its figures are honest, and a card that answered them with "Quarantined 118" would describe
  // the page as the opposite of what it is.
  // MUTANT: key `cardSixthStat` on `quarantinedRows > 0` alone -> `Quarantined 118` -> red.
  it("keeps the aircraft-type count where quarantined rows sit beside stateable traffic", async () => {
    const input = await cardInputFor("8V");
    expect(input.stats[5]).toEqual({ label: "Aircraft types", value: "3" });
    expect(input.stats.map((s) => s.value)).not.toContain("—");
  });

  // VX has been dormant since 2018-03, so the trailing-12 pivot returns no rows and the five
  // measures are absent for a reason quarantine had no part in -- 45 of this dataset's carriers
  // are in that state.
  // MUTANT: key `cardSixthStat` on `totals.seats === null` alone -> `Quarantined 0`, naming the
  // one cause it is not -> red.
  // MUTANT: seed `sumColumn` at 0 -> the first five read `0 · 0 · — · — · 0` -> red.
  it("keeps the aircraft-type count on a carrier that filed nothing in the window", async () => {
    const input = await cardInputFor("VX");
    expect(input.stats[5]).toEqual({ label: "Aircraft types", value: "0" });
    expect(input.stats.slice(0, 5).map((s) => s.value)).toEqual(["—", "—", "—", "—", "—"]);
  });
});

describe("the card's sixth stat is chosen by the shared rule, not by this route", () => {
  // MUTANT: inline `{ label: "Aircraft types", value: formatCount(result.rows.length) }` in
  // place of the `cardSixthStat(...)` call -> the spy records no call -> red. Verified: that
  // mutant survives every other test in this file.
  //
  // The OPERANDS are asserted, not just the fact of a call. 8V filed 118 quarantined rows in
  // this window, which is a value nothing else on the page carries -- so passing `0`, or
  // `result.rows.length` (3), or `totals.seats` in that slot is separable from passing the
  // page's real quarantined count. A call-count-only assertion would admit all three.
  it("passes its own totals, its own quarantined count and its own fallback", async () => {
    sixthSpy.mockClear();
    await Image({ params: Promise.resolve({ code: "8V" }) });
    expect(sixthSpy).toHaveBeenCalledTimes(1);
    const [totals, quarantinedRows, fallback] = sixthSpy.mock.calls[0];
    expect(quarantinedRows).toBe(118);
    expect(fallback).toEqual({ label: "Aircraft types", value: "3" });
    // The FIRST operand is the same totals object the five measures were formatted from -- a
    // route that passed a freshly-summed second copy here could disagree with its own card.
    expect(totals.seats).toBe(160353);
  });
});

// ---------------------------------------------------------------------------------------
/** THE CARD'S DISCLOSURE CHANNEL. Round 2 closed this on `/route` and ONLY `/route`: setting
 * `unknowable: 0` on `/airport`, `understated: 0` on `/carrier` and `unknowable: 0` on
 * `/aircraft` simultaneously left all 1,561 tests green -- the fix applied per RULE where the
 * defect is per CALL SITE, which is the failure CLAUDE.md names and the commit that made it
 * quoted. `smoke.sh` cannot reach any of it: a card is a rasterized PNG with no aria-label, no
 * foot and no empty state, which is why `CardInput`'s docstring calls a wrong word here
 * unrecoverable. The spy is the only seam that sees these values. */
describe("the card's absence counts and note reach renderEntityCard", () => {
  async function cardInput(SLUG: string) {
    renderSpy.mockClear();
    await Image({ params: Promise.resolve({ code: SLUG }) });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    return renderSpy.mock.calls[0][0] as {
      gaps: number;
      unknowable: number;
      understated: number;
      chartNote: string | null;
      chartSvg: string | null;
    };
  }

  // EM understates 25 months and has no wholly-quarantined one; YR is the reverse with 2.
  // Two carriers rather than one, so neither count can pass by borrowing the other's value.
  // MUTANT: `understated: 0` at the render call -> red here and not on YR.
  it("carries the understated count", async () => {
    const input = await cardInput("EM");
    expect(input.understated).toBe(25);
    expect(input.unknowable).toBe(0);
  });

  // MUTANT: `unknowable: 0` at the render call -> red here and not on EM.
  it("carries the wholly-quarantined count", async () => {
    const input = await cardInput("YR");
    expect(input.unknowable).toBe(2);
    expect(input.understated).toBe(0);
  });

  // THE NOTE, and this catches the mutant a hard-coded literal makes: replacing
  // `chartNote: chart.note` with `"No filings in this window."` -- the exact wording
  // `mixAbsenceNote`'s docstring records as having shipped once and calls unrecoverable on a
  // card -- left all 1,561 green. A page that HAS a chart must carry no note at all, so any
  // literal reddens here whatever it says.
  it("carries no note on a card that has a chart to draw", async () => {
    const input = await cardInput("DL");
    expect(input.chartSvg).not.toBeNull();
    expect(input.chartNote).toBeNull();
  });
});
