import { describe, expect, it } from "vitest";
import type { MixRow } from "@/lib/chart/aircraftMix";
import { binOf, heatmapGrid, heatmapKeyNotes, heatmapLabel } from "@/lib/chart/seasonality";

function row(month: string, code: string, seats: number | null): MixRow {
  return { month, code, label: code, seats, departures: seats === null ? null : 1 };
}

function cell(g: NonNullable<ReturnType<typeof heatmapGrid>>, month: string) {
  const c = g.years.flatMap((y) => y.cells).find((x) => x.month === month);
  if (!c) throw new Error(`no cell ${month}`);
  return c;
}

describe("binOf", () => {
  // Mutants: drop Math.min(5, ..) clamp (max -> 6); Math.ceil for floor; min===max -> NaN.
  it("bins the extremes, the midpoint and the edges", () => {
    expect(binOf(0, 0, 100)).toBe(1);
    expect(binOf(100, 0, 100)).toBe(5);
    expect(binOf(50, 0, 100)).toBe(3);
    expect(binOf(19.9, 0, 100)).toBe(1);
    expect(binOf(20, 0, 100)).toBe(2);
    expect(binOf(7, 7, 7)).toBe(5);
  });
});

describe("heatmapGrid", () => {
  // Mutant: `?? 0` in the sum -> an all-NULL month becomes a value of 0.
  it("classifies a month whose every band is NULL as unknown, never 0", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 100),
      row("2016-02", "A", null),
      row("2016-02", "B", null),
      row("2016-03", "A", 300),
    ])!;
    expect(cell(g, "2016-02")).toEqual({
      month: "2016-02",
      kind: "unknown",
      seats: null,
      bin: null,
    });
  });

  // Mutants: classify as value; return null seats.
  it("classifies a month with one band and one NULL band as understated, binned", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 100),
      row("2016-02", "A", 100),
      row("2016-02", "B", null),
      row("2016-03", "A", 300),
    ])!;
    const c = cell(g, "2016-02");
    expect(c.kind).toBe("understated");
    expect(c.seats).toBe(100);
    expect(c.bin).toBe(1);
  });

  // Mutant: treat a mid-span absent month as outside.
  it("marks a mid-span absent month unfiled", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 100),
      row("2016-02", "A", 100),
      row("2016-04", "A", 100),
    ])!;
    expect(cell(g, "2016-03").kind).toBe("unfiled");
  });

  // Mutants: span to whole years; rows through a later year.
  it("spans first to last filed month and marks the rest of those years outside", () => {
    const g = heatmapGrid([row("2016-03", "A", 100), row("2017-10", "A", 200)])!;
    expect(g.years.map((y) => y.year)).toEqual([2016, 2017]);
    expect(g.years.every((y) => y.cells.length === 12)).toBe(true);
    expect(g.first).toBe("2016-03");
    expect(g.last).toBe("2017-10");
    for (const m of ["2016-01", "2016-02", "2017-11", "2017-12"])
      expect(cell(g, m).kind).toBe("outside");
    expect(cell(g, "2016-03").kind).toBe("value");
    expect(cell(g, "2017-10").kind).toBe("value");
    expect(cell(g, "2016-04").kind).toBe("unfiled");
  });

  // Mutant: draw a single filed month.
  it("is null when the mix chart would not draw", () => {
    expect(heatmapGrid([row("2016-03", "A", 100)])).toBeNull();
    expect(heatmapGrid([row("2016-03", "A", 100), row("2016-04", "A", null)])).toBeNull();
  });

  // Mutants: swap highest/lowest; include unknown as 0.
  it("takes min, max, highest and lowest over stateable cells, ignoring unknown", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 200),
      row("2016-02", "A", 500),
      row("2016-03", "A", null),
      row("2016-04", "A", 150),
    ])!;
    expect(g.min).toBe(150);
    expect(g.max).toBe(500);
    expect(g.highest).toEqual({ month: "2016-02", seats: 500 });
    expect(g.lowest).toEqual({ month: "2016-04", seats: 150 });
  });

  // Mutant: range computed over kind === "value" cells only (understated excluded).
  it("includes an understated month at the extreme of the range", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 100),
      row("2016-02", "A", 200),
      row("2016-03", "A", 900),
      row("2016-03", "B", null),
    ])!;
    expect(cell(g, "2016-03").kind).toBe("understated");
    expect(g.max).toBe(900);
    expect(g.highest).toEqual({ month: "2016-03", seats: 900 });
    expect(cell(g, "2016-03").bin).toBe(5);
  });

  // Mutants: `>` -> `>=` in the highest reduce; `<` -> `<=` in the lowest reduce.
  it("breaks a tie toward the earlier month for both highest and lowest", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 500),
      row("2016-02", "A", 100),
      row("2016-03", "A", 300),
      row("2016-04", "A", 100),
      row("2016-05", "A", 500),
    ])!;
    expect(g.highest.month).toBe("2016-01");
    expect(g.lowest.month).toBe("2016-02");
  });

  // Mutant: swapped counters. Each count has a distinct value.
  it("counts each kind from its own months", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 100),
      // 2016-02 unfiled; 2016-03 unfiled
      row("2016-04", "A", null), // unknown
      row("2016-05", "A", 100),
      row("2016-05", "B", null), // understated
      row("2016-06", "A", 100),
      row("2016-07", "A", null), // unknown
      row("2016-08", "A", null), // unknown
      row("2016-09", "A", 100),
    ])!;
    expect(g.counts).toEqual({ unfiled: 2, unknown: 3, understated: 1 });
  });
});

// 2016-01 100 lowest, 2016-02 300 highest, 03 unfiled, 04 unknown, 05 understated, 06 value.
const mixed = () =>
  heatmapGrid([
    row("2016-01", "A", 100),
    row("2016-02", "A", 300),
    row("2016-04", "A", null),
    row("2016-05", "A", 200),
    row("2016-05", "B", null),
    row("2016-06", "A", 150),
  ])!;

describe("heatmapLabel", () => {
  it("states span, extremes and every non-zero count", () => {
    expect(heatmapLabel(mixed())).toBe(
      "Seats by month, 2016-01 to 2016-06. Highest 2016-02 300 seats, lowest 2016-01 100 seats. " +
        "1 month with no filings. 1 month filed but wholly quarantined. 1 month understated.",
    );
  });

  // Mutant: drop the ", understated" qualifier from an extreme. The lowest month here is
  // understated (one stateable band plus a NULL one), so its 50 is a floor, not a total; the
  // highest is a complete month and must stay unqualified.
  it("marks an understated extreme as understated, and only that one", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 50),
      row("2016-01", "B", null),
      row("2016-02", "A", 300),
      row("2016-03", "A", 200),
    ])!;
    expect(heatmapLabel(g)).toBe(
      "Seats by month, 2016-01 to 2016-03. Highest 2016-02 300 seats, lowest 2016-01 50 seats, " +
        "understated. 1 month understated.",
    );
  });

  it("omits zero counts and pluralises", () => {
    const g = heatmapGrid([
      row("2016-01", "A", 1234567),
      row("2016-04", "A", 100),
      row("2016-07", "A", 100),
    ])!;
    expect(heatmapLabel(g)).toBe(
      "Seats by month, 2016-01 to 2016-07. Highest 2016-01 1,234,567 seats, lowest 2016-04 100 " +
        "seats. 4 months with no filings.",
    );
  });
});

describe("heatmapKeyNotes", () => {
  it("returns one sentence per non-zero count in order unfiled, unknown, understated", () => {
    expect(heatmapKeyNotes(mixed())).toEqual([
      "1 month with no filings, left unfilled.",
      "1 month filed but wholly quarantined — every filing failed an invariant, so the month " +
        "cannot be stated.",
      "1 month understated — a quarantined filing is left out of that month's total, which is " +
        "lower than the real one by an amount that cannot be stated.",
    ]);
  });

  it("omits zero counts", () => {
    const g = heatmapGrid([row("2016-01", "A", 1), row("2016-02", "A", 2)])!;
    expect(heatmapKeyNotes(g)).toEqual([]);
  });
});
