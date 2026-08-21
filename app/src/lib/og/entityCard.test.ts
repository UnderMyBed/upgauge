import { describe, expect, it } from "vitest";
import { cardChart, cardStats, cardSubtitle } from "./entityCard";
import type { MixRow } from "@/lib/chart/aircraftMix";
import type { EntityTotals } from "@/lib/entityFacts";

const TOTALS: EntityTotals = {
  seats: 3_464_803,
  passengers: 3_005_548,
  departures: 20_252,
  loadFactor: 3_005_548 / 3_464_803,
  avgGauge: 3_464_803 / 20_252,
};

const EMPTY: EntityTotals = {
  seats: 0,
  passengers: 0,
  departures: 0,
  loadFactor: null,
  avgGauge: null,
};

/** Two bands over three months, with 2015-02 unfiled so the run splits and the gap is real
 * rather than asserted into existence. Synthetic on purpose: these are pure functions over
 * already-shaped mix rows, and each route's own test drives the live database. */
function rows(months: string[]): MixRow[] {
  return months.flatMap((month) => [
    { month, code: "614", label: "B737-8", seats: 1000, departures: 6 },
    { month, code: "694", label: "A321", seats: 400, departures: 2 },
  ]);
}

describe("cardStats", () => {
  // THE BUG THIS CATCHES: a seventh stat added to the row. It is one line 1,112px wide and a
  // seventh overflows it, silently clipping whichever stat ends up last.
  it("is exactly six stats, in the page's own order", () => {
    const stats = cardStats(TOTALS, { label: "Carriers", value: "5" });
    expect(stats.map((s) => s.label)).toEqual([
      "Seats",
      "Passengers",
      "Load factor",
      "Avg gauge",
      "Departures",
      "Carriers",
    ]);
  });

  // THE BUG THIS CATCHES: the derived flag dropped, so load factor and average gauge read as
  // filed figures. CLAUDE.md requires a derived measure LABELLED as computed, and a card is a
  // data view, not a marketing asset. Asserted as the exact SET, not "load factor is derived":
  // marking everything derived would satisfy the weaker form.
  it("marks load factor and average gauge computed, and nothing else", () => {
    const stats = cardStats(TOTALS, { label: "Carriers", value: "5" });
    expect(stats.filter((s) => s.derived === true).map((s) => s.label)).toEqual([
      "Load factor",
      "Avg gauge",
    ]);
  });

  // THE BUG THIS CATCHES: a null ratio formatted as 0.00% / 0.0. Absence is not a measurement
  // (lib/format.ts), and 39% of this dataset's carriers filed nothing in the trailing 12
  // months -- VX stopped in 2018-03 -- so this is the routine case, not the corner.
  it("renders an absent ratio as a dash, never as zero", () => {
    const stats = cardStats(EMPTY, { label: "Carriers", value: "0" });
    expect(stats.find((s) => s.label === "Load factor")?.value).toBe("—");
    expect(stats.find((s) => s.label === "Avg gauge")?.value).toBe("—");
    expect(stats.find((s) => s.label === "Seats")?.value).toBe("0");
  });
});

describe("cardSubtitle", () => {
  it("names the descriptor and the window the STATS were summed over", () => {
    expect(cardSubtitle("Delta Air Lines Inc.", "2025-06", "2026-05")).toBe(
      "Delta Air Lines Inc. · trailing 12 months · 2025-06 → 2026-05",
    );
  });
});

describe("cardChart", () => {
  // THE BUG THIS CATCHES, and it is invisible without rasterizing: `renderPlotToSvg` returns
  // jsdom's `outerHTML`, and the HTML fragment serialization algorithm writes no namespace
  // declaration -- measured, no `xmlns` anywhere in 28,873 bytes of a real chart. Inside the
  // page's HTML that is correct; inside a `data:image/svg+xml` URI the bytes ARE the document
  // and resvg parses them as XML. Drop the injection and the card still returns 200 with an
  // image/png content-type, because ImageResponse rasterizes lazily -- so no route test can
  // see this, and this one has to.
  it("returns a standalone SVG document, namespace declared", () => {
    const { svg } = cardChart(rows(["2015-01", "2015-03", "2015-04"]), "JFK–LAX");
    expect(svg?.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ')).toBe(true);
  });

  // THE BUG THIS CATCHES: a `var(--token)` reaching the rasterizer. resvg has no CSS-variable
  // resolution and falls back to BLACK, so the card would render successfully with the wrong
  // colours -- the failure mode resolveSvgTokens exists to make loud.
  it("leaves no CSS custom property for the rasterizer to guess at", () => {
    const { svg } = cardChart(rows(["2015-01", "2015-03", "2015-04"]), "JFK–LAX");
    expect(svg).not.toContain("var(--");
  });

  // THE BUG THIS CATCHES: gaps counted from the wrong axis, or not carried to the card at all.
  // The page states the count on the chart AND in its aria-label; a rasterized card has
  // neither, so `CardFrame`'s visible line is the only thing left that can say it. 2015-02 is
  // the unfiled month here.
  it("carries the unfiled-month count out of the chart", () => {
    expect(cardChart(rows(["2015-01", "2015-03", "2015-04"]), "JFK–LAX").gaps).toBe(1);
    expect(cardChart(rows(["2015-01", "2015-02", "2015-03"]), "JFK–LAX").gaps).toBe(0);
  });

  // Fewer than two filed months is not a drawable stacked area (degenerate x domain, zero
  // width). `CardFrame` states that in words; drawing an empty frame under a DATA AS OF badge
  // is the failure /explore and /route already refuse.
  it("draws nothing rather than an empty frame when there is no trend", () => {
    expect(cardChart([], "JFK–LAX").svg).toBeNull();
    expect(cardChart(rows(["2015-01"]), "JFK–LAX").svg).toBeNull();
  });
});
