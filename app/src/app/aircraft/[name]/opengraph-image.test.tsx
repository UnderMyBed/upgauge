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

// THE ROWS ARE THE FIXTURE, NOT THE AIRCRAFT TYPE. `syntheticPivot.fixture.ts` carries the
// argument; the short form is that a wholly-quarantined window is a SHAPE, and pinning it to
// whichever type happens to have that shape today ties the fixture to the trailing 12, which
// moves. `answer` is null for every test in this file but the ones that set it.
const pivot = vi.hoisted(() => ({
  answer: null as null | ((q: PivotQuery) => Record<string, unknown>[] | null),
  hits: 0,
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { syntheticRunPivot } = await import("@/lib/syntheticPivot.fixture");
  return { ...actual, runPivot: syntheticRunPivot(actual, pivot) };
});
import Image, { alt, contentType, dynamic, size } from "@/app/aircraft/[name]/opengraph-image";
import type { PivotQuery } from "@/lib/pivot/types";

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

// ---------------------------------------------------------------------------------------
// THE CARD'S SIXTH STAT (#121), and THIS route is the half issue #121 never measured: it scoped
// the wholly-quarantined footprint at route grain only, and an aircraft type whose every
// trailing-12 filing failed an invariant is in exactly the same state.
//
// THE ROWS ARE THE FIXTURE, NOT THE TYPE. Both pivots this route issues, answered as such a
// type: one operating carrier, two filed months, every FILTERed sum NULL, and a
// `quarantined_rows` COUNT that survives because a count is not a measure. Two months rather
// than one because `mixChartDraws` gates on the months that can be STATED and an earlier
// revision counted the FILED ones -- a one-month fixture cannot tell those apart. The SUBJECT
// stays real: B737-8 resolves, and its real query supplies the column list. Only the rows are
// constructed, because every live type in this state sits inside a window that moves.
const DL_ID = 19790;
function whollyQuarantinedType(q: PivotQuery): Record<string, unknown>[] | null {
  if (!q.filters.some(([key]) => key === "aircraft_type")) return null;
  if (q.dimensions.includes("year_month")) {
    return ["2025-08", "2025-09"].map((month) => ({
      year_month: month,
      op_airline_id: DL_ID,
      seats: null,
      departures_performed: null,
    }));
  }
  if (q.dimensions.length === 1 && q.dimensions[0] === "op_airline_id") {
    return [
      {
        op_airline_id: DL_ID,
        seats: null,
        passengers: null,
        departures_performed: null,
        quarantined_rows: 2,
        quarantine_reasons: "zero_seats",
      },
    ];
  }
  return null;
}

/** The card rasterized over the constructed window, and the `CardInput` the route handed
 * `renderEntityCard` on the way past.
 *
 * The hit count is the harness's own check -- two pivots, the stat row's and the chart's --
 * because a stub whose dispatch stopped matching would card the real B737-8, where the five
 * dashes one describe below are trivially false but `chartSvg === null` two describes below is
 * trivially true. Both callers read it through their own shape, the way `cardInputFor` and
 * `cardInput` already do. */
async function quarantinedCardInput<T>(): Promise<T> {
  renderSpy.mockClear();
  pivot.answer = whollyQuarantinedType;
  pivot.hits = 0;
  try {
    await Image({ params: Promise.resolve({ name: "B737-8" }) });
  } finally {
    pivot.answer = null;
  }
  expect(renderSpy).toHaveBeenCalledTimes(1);
  expect(pivot.hits).toBe(2);
  return renderSpy.mock.calls[0][0] as T;
}

describe("the default export's card input", () => {
  async function cardInputFor(name: string) {
    renderSpy.mockClear();
    await Image({ params: Promise.resolve({ name }) });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    return renderSpy.mock.calls[0][0] as { stats: { label: string; value: string }[] };
  }

  // THE ORDER IS PART OF THE ASSERTION: load factor and average gauge rendered `—` even under the
  // bug, so only the first five ALL being dashes separates `0 · 0 · — · — · 0` from five dashes.
  // MUTANT: `stats: cardStats(totals, { label: "Carriers", ... })` at the render call -> the
  // sixth stat reads `Carriers 1` -> red.
  // MUTANT: restore `?? 0` in `sumColumn` -> the first five stop being dashes -> red.
  it("rasterizes the quarantined count on a wholly-quarantined aircraft type", async () => {
    const input = await quarantinedCardInput<{ stats: { label: string; value: string }[] }>();
    expect(input.stats.map((s) => s.label)).toEqual([
      "Seats", "Passengers", "Load factor", "Avg gauge", "Departures", "Quarantined",
    ]);
    expect(input.stats[5].value).toBe("2");
    expect(input.stats.slice(0, 5).map((s) => s.value)).toEqual(["—", "—", "—", "—", "—"]);
  });

  // QUARANTINE BESIDE REAL TRAFFIC: the Caravan carries 75 quarantined rows in this window and
  // stateable traffic across 13 operating carriers.
  // MUTANT: key `cardSixthStat` on `quarantinedRows > 0` alone -> `Quarantined 75` -> red.
  it("keeps the carrier count where quarantined rows sit beside stateable traffic", async () => {
    const input = await cardInputFor("CARAVAN");
    expect(input.stats[5]).toEqual({ label: "Carriers", value: "13" });
    expect(input.stats.map((s) => s.value)).not.toContain("—");
  });

  // The MD-80 stopped filing in 2023-04, so its trailing-12 pivot returns no rows -- 39 of this
  // dataset's 112 fact-present types are in that state.
  // MUTANT: key `cardSixthStat` on `totals.seats === null` alone -> `Quarantined 0` -> red.
  // MUTANT: seed `sumColumn` at 0 -> the first five stop being dashes -> red.
  it("keeps the carrier count on a type that filed nothing in the window", async () => {
    const input = await cardInputFor("MD-80");
    expect(input.stats[5]).toEqual({ label: "Carriers", value: "0" });
    expect(input.stats.slice(0, 5).map((s) => s.value)).toEqual(["—", "—", "—", "—", "—"]);
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
    await Image({ params: Promise.resolve({ name: SLUG }) });
    expect(renderSpy).toHaveBeenCalledTimes(1);
    return renderSpy.mock.calls[0][0] as {
      gaps: number;
      unknowable: number;
      understated: number;
      chartNote: string | null;
      chartSvg: string | null;
    };
  }

  // The ATR-72 carries both: 13 wholly-quarantined months and 12 understated ones, stacked BY
  // CARRIER on this page. 11 aircraft types carry at least one.
  // MUTANT: `unknowable: 0` at the render call -> red. MUTANT: `understated: 0` -> red.
  it("carries both absence counts for a type that has both", async () => {
    const input = await cardInput("ATR-72");
    expect(input.unknowable).toBe(13);
    expect(input.understated).toBe(12);
  });

  // A type whose every filed month is itself wholly quarantined has no chart AND must carry the
  // page's own sentence -- the case the hard-coded "No filings in this window." literal was
  // live on, since this page's own note correctly names the quarantine.
  // MUTANT: any literal for `chartNote` -> red.
  it("carries the page's own no-chart sentence, not a card-local one", async () => {
    const input = await quarantinedCardInput<{ chartNote: string | null; chartSvg: string | null }>();
    expect(input.chartSvg).toBeNull();
    expect(input.chartNote).toBe(
      "2 months of filings in this window, every one wholly quarantined — every filing failed " +
        "an invariant, so no carrier seats can be stated and there is nothing to draw.",
    );
  });

  // THE NOTE, and this catches the mutant a hard-coded literal makes: replacing
  // `chartNote: chart.note` with `"No filings in this window."` -- the exact wording
  // `mixAbsenceNote`'s docstring records as having shipped once and calls unrecoverable on a
  // card -- left all 1,561 green. A page that HAS a chart must carry no note at all, so any
  // literal reddens here whatever it says.
  it("carries no note on a card that has a chart to draw", async () => {
    const input = await cardInput("B737-8");
    expect(input.chartSvg).not.toBeNull();
    expect(input.chartNote).toBeNull();
  });
});
