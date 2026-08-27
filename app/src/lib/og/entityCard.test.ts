import { describe, expect, it } from "vitest";
import { cardChart, cardSixthStat, cardStats, cardSubtitle } from "./entityCard";
import { BY_AIRCRAFT_TYPE, type MixRow } from "@/lib/chart/aircraftMix";
import { mixAbsenceNote } from "@/lib/chart/mixPlotConfig";
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

// ---------------------------------------------------------------------------------------
// Issue #118 design review: the card's no-chart copy must be the PAGE's finding.
//
// `prepareMixPlot` returns `plot: null` for two different findings -- nothing filed, and exactly
// one filed month. `AircraftMixChart` has always distinguished them; `cardChart` threw the
// distinction away and `card.tsx` printed a flat "No filings in this window." So the card
// previewing /airport/A18 -- an airport whose whole window is ONE quarantined filing -- asserted
// that nothing had ever been filed there, on the surface a shared link renders first.
describe("cardChart's absence note", () => {
  const month = (m: string): MixRow => ({
    month: m,
    code: "738",
    label: "738",
    seats: 100,
    departures: 1,
  });

  it("says which of the two findings it is when there is one filed month", () => {
    // MUTANT: hardcode `note: "No filings in this window."` in cardChart -> red.
    const c = cardChart([month("2025-06")], "A18");
    expect(c.svg).toBeNull();
    expect(c.note).toBe(
      "Only one month of filings in this window (2025-06) — a stacked area needs at least two.",
    );
  });

  it("says nothing was filed only when nothing was filed", () => {
    const c = cardChart([], "A18");
    expect(c.svg).toBeNull();
    expect(c.note).toBe("No aircraft-type filings in this window.");
  });

  it("carries no note when it has a chart to draw", () => {
    // A note beside a drawn chart would be a caption contradicting the drawing.
    // MUTANT: return the note unconditionally -> red.
    const c = cardChart([month("2025-06"), month("2025-07")], "SEA");
    expect(c.svg).not.toBeNull();
    expect(c.note).toBeNull();
  });

  it("uses the same sentence the page renders, not a second wording of it", () => {
    // The drift this exists to make impossible: two literals that agree today.
    // MUTANT: give cardChart its own copy of either string -> red.
    expect(cardChart([month("2025-06")], "A18").note).toBe(
      mixAbsenceNote(["2025-06"], BY_AIRCRAFT_TYPE),
    );
    expect(cardChart([], "A18").note).toBe(mixAbsenceNote([], BY_AIRCRAFT_TYPE));
  });
});

// ---------------------------------------------------------------------------------------
// Issue #118 design review: five dashes and no count is five unexplained holes.
//
// A card has no empty state, no foot and no aria-label, so the sixth stat is the only place a
// reader can be told why the other five are em dashes. The matrix is (seats null?) x
// (quarantinedRows > 0?) and all four cells are asserted -- the fourth is the one that shipped
// wrong, keyed on the null alone.
describe("cardSixthStat", () => {
  const CARRIERS = { label: "Carriers", value: "7" };
  const base: EntityTotals = {
    seats: 100,
    passengers: 90,
    departures: 4,
    loadFactor: null,
    avgGauge: null,
  };
  const absent: EntityTotals = { ...base, seats: null, passengers: null, departures: null };

  it("explains the dashes when quarantine is why no measure can be stated", () => {
    // MUTANT: return `fallback` unconditionally -> red.
    expect(cardSixthStat(absent, 1, CARRIERS)).toEqual({ label: "Quarantined", value: "1" });
  });

  it("does not blame quarantine for an absence quarantine did not cause", () => {
    // THE CELL THAT SHIPPED WRONG. `seats === null` covers TWO absences, and the pages that
    // filed nothing at all are by far the larger group. Keyed on that alone the card answers
    // five dashes with "Quarantined 0" -- naming the one cause it is not, while withholding the
    // count that does explain them.
    // MUTANT: drop `&& quarantinedRows > 0` -> red. The other three cells stay green under it,
    // which is exactly why this one had to exist.
    expect(cardSixthStat(absent, 0, { label: "Carriers", value: "0" })).toEqual({
      label: "Carriers",
      value: "0",
    });
  });

  it("keeps the entity count where real totals sit beside quarantined rows", () => {
    // MUTANT: key on `quarantinedRows > 0` alone -> red. Wrong on 24 of the 29 /airport pages
    // that carry a quarantined row, all of which have totals worth counting carriers for.
    expect(cardSixthStat(base, 3, CARRIERS)).toEqual(CARRIERS);
  });

  it("keeps the entity count on an ordinary page", () => {
    expect(cardSixthStat(base, 0, CARRIERS)).toEqual(CARRIERS);
  });
});
