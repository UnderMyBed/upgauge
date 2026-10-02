// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SeasonalityHeatmap } from "@/components/SeasonalityHeatmap";
import type { MixRow } from "@/lib/chart/aircraftMix";
import { heatmapGrid, heatmapKeyNotes, heatmapLabel } from "@/lib/chart/seasonality";

// ---------------------------------------------------------------------------------------
// Fixture: one subject whose span is 2016-03 .. 2017-02, carrying every cell kind.
//
//   2016-01, 2016-02          outside (before the first filing)
//   2016-03   120,000         value, the MIN  -> --g1
//   2016-04 1,234,567         value, the MAX  -> --g5
//   2016-05   600,000 + NULL  understated     -> --g3 (1 + floor(480000/1114567*5) = 3)
//   2016-06   NULL + NULL     unknown (filed, wholly quarantined)
//   2016-07   (no rows)       unfiled
//   2016-08 .. 2017-02        value 300,000   -> --g1
//   2017-03 .. 2017-12        outside (after the last filing)
//
// Two bands per filed month, so the understated month genuinely has a stateable band beside
// a NULL one, and the unknown month has two NULLs rather than one.
// ---------------------------------------------------------------------------------------

function band(month: string, code: string, seats: number | null): MixRow {
  return { month, code, label: code, seats, departures: seats === null ? null : 10 };
}

function month(month: string, a: number | null, b: number | null): MixRow[] {
  return [band(month, "A", a), band(month, "B", b)];
}

const STEADY = ["2016-08", "2016-09", "2016-10", "2016-11", "2016-12", "2017-01", "2017-02"];

const ALL_KINDS: MixRow[] = [
  ...month("2016-03", 120_000, 0),
  ...month("2016-04", 1_000_000, 234_567),
  ...month("2016-05", 600_000, null),
  ...month("2016-06", null, null),
  ...STEADY.flatMap((m) => month(m, 300_000, 0)),
];

/** Only stated months, so every count is zero. */
const VALUES_ONLY: MixRow[] = ["2016-03", "2016-04", "2016-05"].flatMap((m, i) =>
  month(m, 100_000 * (i + 1), 0),
);

function heatmap(rows: MixRow[], truncated = false, title = "JFK–LAX") {
  const { container } = render(
    <SeasonalityHeatmap rows={rows} title={title} truncated={truncated} />,
  );
  return container;
}

/** The WIDE render -- the desktop grid, which every cell and geometry test reads. The grid is
 * drawn once per fit (ChartFit); the per-fit properties are pinned in their own describe block,
 * so these helpers stay scoped to one render. */
function wideOf(container: HTMLElement): Element {
  const svg = container.querySelector(".chart-fit > .fit-wide svg");
  if (svg === null) throw new Error("no wide render");
  return svg;
}

function cellOf(container: HTMLElement, m: string): SVGRectElement {
  const rect = wideOf(container).querySelector(`rect[data-month="${m}"]`);
  if (rect === null) throw new Error(`no cell for ${m}`);
  return rect as unknown as SVGRectElement;
}

/** The marks that belong to a cell are siblings of its rect inside the cell's own group. */
function marksOf(container: HTMLElement, m: string) {
  const g = cellOf(container, m).parentElement!;
  return { tick: g.querySelector("path.tick"), dot: g.querySelector("circle.dot") };
}

function titleOf(container: HTMLElement, m: string): string | null {
  return cellOf(container, m).querySelector("title")?.textContent ?? null;
}

const num = (el: Element, attr: string) => Number(el.getAttribute(attr));

/** Bounding box of an absolute M/L/H/V/Z path -- jsdom has no getBBox. Throws on any other
 * command rather than guessing, so a path this cannot read fails the test loudly. */
function pathBox(d: string) {
  const xs: number[] = [];
  const ys: number[] = [];
  let x = 0;
  let y = 0;
  for (const [, cmd, args] of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const n = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
    if (cmd === "M" || cmd === "L") [x, y] = n;
    else if (cmd === "H") x = n[0];
    else if (cmd === "V") y = n[0];
    else if (cmd === "Z") continue;
    else throw new Error(`pathBox cannot read command ${cmd} in ${d}`);
    xs.push(x);
    ys.push(y);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe("SeasonalityHeatmap -- cell kinds", () => {
  // Mutant: an off-by-one or reversed token mapping (`--g${6 - bin}`): the max month would
  // draw --g1 and the min --g5.
  it("fills a value cell with its bin's token: the max month --g5, the min month --g1", () => {
    const c = heatmap(ALL_KINDS);
    expect(cellOf(c, "2016-04").getAttribute("fill")).toBe("var(--g5)");
    expect(cellOf(c, "2016-03").getAttribute("fill")).toBe("var(--g1)");
    expect(cellOf(c, "2016-04").getAttribute("data-kind")).toBe("value");
    expect(cellOf(c, "2016-04").classList.contains("hairline")).toBe(false);
    expect(marksOf(c, "2016-04")).toEqual({ tick: null, dot: null });
    expect(titleOf(c, "2016-04")).toBe("2016-04 · 1,234,567 seats");
  });

  // Mutant: drop the understated tick -- the cell then reads as an ordinary, complete month.
  it("fills an understated cell at its stateable sum AND marks it with a corner tick", () => {
    const c = heatmap(ALL_KINDS);
    const rect = cellOf(c, "2016-05");
    expect(rect.getAttribute("data-kind")).toBe("understated");
    expect(rect.getAttribute("fill")).toBe("var(--g3)");
    expect(rect.classList.contains("hairline")).toBe(false);
    expect(marksOf(c, "2016-05").tick).not.toBeNull();
    expect(marksOf(c, "2016-05").dot).toBeNull();
    expect(titleOf(c, "2016-05")).toBe("2016-05 · 600,000 seats, understated");
  });

  // Mutants: the tick drawn at the top-LEFT corner; the tick drawn as a full-cell overlay. Both
  // still emit a `path.tick`, so only its geometry tells them from the real mark.
  it("places the understated tick in the cell's top-right corner, covering a small part of it", () => {
    const c = heatmap(ALL_KINDS);
    const rect = cellOf(c, "2016-05");
    const [rx, ry, rw, rh] = ["x", "y", "width", "height"].map((a) => num(rect, a));
    const b = pathBox(marksOf(c, "2016-05").tick!.getAttribute("d")!);
    // Inside the cell, flush with its right and top edges.
    expect(b.maxX).toBeCloseTo(rx + rw);
    expect(b.minY).toBeCloseTo(ry);
    expect(b.maxY).toBeLessThanOrEqual(ry + rh);
    // In the right half and the top half: a corner, not an edge band or the whole cell.
    expect(b.minX).toBeGreaterThan(rx + rw / 2);
    expect(b.maxY).toBeLessThan(ry + rh / 2);
    expect((b.maxX - b.minX) * (b.maxY - b.minY)).toBeLessThan((rw * rh) / 10);
  });

  // Mutant: swap the unknown/unfiled branches -- the dot lands on the unfiled month and
  // leaves the wholly-quarantined one looking unfiled.
  it("draws an unknown cell unfilled, hairlined, with a centred dot", () => {
    const c = heatmap(ALL_KINDS);
    const rect = cellOf(c, "2016-06");
    expect(rect.getAttribute("data-kind")).toBe("unknown");
    expect(rect.getAttribute("fill")).toBe("none");
    expect(rect.classList.contains("hairline")).toBe(true);
    const { dot, tick } = marksOf(c, "2016-06");
    expect(tick).toBeNull();
    expect(dot).not.toBeNull();
    // Centred: the dot sits at the rect's own midpoint, not at a corner.
    expect(num(dot!, "cx")).toBeCloseTo(num(rect, "x") + num(rect, "width") / 2);
    expect(num(dot!, "cy")).toBeCloseTo(num(rect, "y") + num(rect, "height") / 2);
    expect(titleOf(c, "2016-06")).toBe("2016-06 · filed, wholly quarantined");
  });

  // Same mutant as above, seen from the other cell: a dot on a month nobody filed claims a
  // filing that does not exist.
  it("draws an unfiled cell unfilled and hairlined, with no dot", () => {
    const c = heatmap(ALL_KINDS);
    const rect = cellOf(c, "2016-07");
    expect(rect.getAttribute("data-kind")).toBe("unfiled");
    expect(rect.getAttribute("fill")).toBe("none");
    expect(rect.classList.contains("hairline")).toBe(true);
    expect(marksOf(c, "2016-07")).toEqual({ tick: null, dot: null });
    expect(titleOf(c, "2016-07")).toBe("2016-07 · no filings");
  });

  // Mutant: draw `outside` cells as unfiled -- the span would silently stretch to whole years.
  it("draws nothing for months outside the filed span", () => {
    const c = heatmap(ALL_KINDS);
    for (const m of ["2016-01", "2016-02", "2017-03", "2017-12"]) {
      expect(c.querySelector(`[data-month="${m}"]`)).toBeNull();
    }
    expect([...wideOf(c).querySelectorAll("rect[data-month]")].map((r) => r.getAttribute("data-month")))
      .toEqual(["2016-03", "2016-04", "2016-05", "2016-06", "2016-07", ...STEADY]);
  });
});

describe("SeasonalityHeatmap -- geometry", () => {
  // Mutant: swap the axes (month on y, year on x). Every cell is still present with the right
  // fill, so only a position assertion can see it.
  it("lays out rows by year and columns by month", () => {
    const c = heatmap(ALL_KINDS);
    const x = (m: string) => num(cellOf(c, m), "x");
    const y = (m: string) => num(cellOf(c, m), "y");
    expect(x("2016-03")).toBeLessThan(x("2016-04"));
    expect(y("2016-03")).toBe(y("2016-04"));
    expect(y("2017-01")).toBeGreaterThan(y("2016-12"));
    expect(x("2017-01")).toBeLessThan(x("2016-12"));
    // February sits one column pitch left of March, in the next year's row.
    const pitch = x("2016-04") - x("2016-03");
    expect(x("2017-02")).toBeCloseTo(x("2016-03") - pitch);
  });

  it("is responsive: a viewBox and no pinned width", () => {
    const svg = heatmap(ALL_KINDS).querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(svg.getAttribute("width")).toBeNull();
    expect(svg.getAttribute("class")).toBe("heatmap-grid");
  });

  // Mutant: month labels drawn in reverse or year labels missing.
  it("labels the twelve month columns in order and each year row", () => {
    const c = heatmap(ALL_KINDS);
    const texts = [...wideOf(c).querySelectorAll("text")].map((t) => t.textContent);
    expect(texts.slice(0, 12)).toEqual(["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"]);
    expect(texts.slice(12)).toEqual(["2016", "2017"]);
  });
});

describe("SeasonalityHeatmap -- legend, key and label", () => {
  // Mutant: swap the min and max labels, or drop formatSeats.
  it("labels the legend's left end with the min and its right end with the max, formatted", () => {
    const key = heatmap(ALL_KINDS).querySelector(".hkey")!;
    const kids = [...key.children];
    const swatches = kids.filter((k) => k.tagName === "I");
    expect(swatches.map((s) => (s as HTMLElement).style.background)).toEqual([
      "var(--g1)",
      "var(--g2)",
      "var(--g3)",
      "var(--g4)",
      "var(--g5)",
    ]);
    const firstSwatch = kids.indexOf(swatches[0]);
    const lastSwatch = kids.indexOf(swatches[4]);
    expect(kids[firstSwatch - 1].textContent).toBe("120,000");
    expect(kids[firstSwatch - 1].className).toBe("gnum");
    expect(kids[lastSwatch + 1].textContent).toBe("1,234,567");
    expect(kids[lastSwatch + 1].className).toBe("gnum");
  });

  // Mutant: drop the key-note rendering.
  it("states one sentence per non-zero count", () => {
    const key = heatmap(ALL_KINDS).querySelector(".hkey")!;
    const notes = heatmapKeyNotes(heatmapGrid(ALL_KINDS)!);
    expect(notes).toHaveLength(3);
    const spans = [...key.querySelectorAll("span.gnum")].map((s) => s.textContent);
    expect(spans).toEqual(["120,000", "1,234,567", ...notes]);
  });

  // Mutant: render every note regardless of its count.
  it("states no note when every count is zero", () => {
    const key = heatmap(VALUES_ONLY).querySelector(".hkey")!;
    const spans = [...key.querySelectorAll("span.gnum")].map((s) => s.textContent);
    expect(spans).toEqual(["100,000", "300,000"]);
  });

  // Mutant: label the svg with the title instead of heatmapLabel.
  it("labels the svg with heatmapLabel", () => {
    const svg = heatmap(ALL_KINDS).querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe(heatmapLabel(heatmapGrid(ALL_KINDS)!));
  });

  it("frames it as the seats-by-month chart for the subject", () => {
    const c = heatmap(ALL_KINDS);
    expect(c.querySelector(".chart.heatmap .ctitle")!.textContent).toBe("Seats by month");
    expect(c.querySelector(".chart.heatmap .csub")!.textContent).toBe(
      "JFK–LAX · monthly seats · darker is more",
    );
  });
});

describe("SeasonalityHeatmap -- not drawn", () => {
  // Mutant: drop the truncated guard -- a month total summed from a capped fetch is drawn as
  // if it were the whole month.
  it("states the truncation in one sentence and draws no svg", () => {
    const c = heatmap(ALL_KINDS, true);
    expect(c.querySelector("svg")).toBeNull();
    expect(c.querySelector(".chart .ctitle")!.textContent).toBe("Seats by month");
    expect(c.querySelector(".chart p.foot")!.textContent).toBe(
      "The monthly totals cannot be stated: the fetch behind this chart hit its row limit.",
    );
    expect(c.querySelector(".hkey")).toBeNull();
  });

  // Mutant: drop the null guard (render a frame when the mix chart does not draw).
  it("renders nothing for a single stated month", () => {
    expect(heatmap(month("2016-03", 100, 0)).innerHTML).toBe("");
    expect(heatmap(month("2016-03", 100, 0), true).innerHTML).toBe("");
  });
});

describe("SeasonalityHeatmap -- one render per width band", () => {
  const renders = (c: HTMLElement) =>
    (["wide", "mid", "narrow"] as const).map((fit) => {
      const svg = c.querySelector(`.chart-fit > .fit-${fit} svg`);
      if (svg === null) throw new Error(`no ${fit} render`);
      return svg;
    });

  // Mutant: ChartFit renders only the wide child.
  it("draws exactly three grids, one per fit, over 960/540/300-unit viewBoxes", () => {
    const c = heatmap(ALL_KINDS);
    expect(c.querySelectorAll("svg").length).toBe(3);
    expect([...c.querySelector(".chart-fit")!.children].map((e) => e.className)).toEqual([
      "fit-wide",
      "fit-mid",
      "fit-narrow",
    ]);
    expect(renders(c).map((s) => s.getAttribute("viewBox")!.split(" ")[2])).toEqual(["960", "540", "300"]);
  });

  // Mutant: the narrow grid is fed a different grid (another row set).
  it("draws every grid from the same rows: same cells, same kinds, same label", () => {
    const c = heatmap(ALL_KINDS);
    const cells = (svg: Element) =>
      [...svg.querySelectorAll("rect[data-month]")].map(
        (r) => `${r.getAttribute("data-month")}:${r.getAttribute("data-kind")}:${r.getAttribute("fill")}`,
      );
    const [wide, mid, narrow] = renders(c);
    expect(cells(wide).length).toBeGreaterThan(0);
    expect(cells(mid)).toEqual(cells(wide));
    expect(cells(narrow)).toEqual(cells(wide));
    for (const s of [mid, narrow]) expect(s.getAttribute("aria-label")).toBe(wide.getAttribute("aria-label"));
  });

  // Mutant: the narrow grid keeps the wide column pitch -- its last column then falls outside
  // its own 300-unit viewBox.
  it("fits all twelve columns inside each render's own viewBox", () => {
    for (const svg of renders(heatmap(ALL_KINDS))) {
      const w = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
      const months = [...svg.querySelectorAll("text")].slice(0, 12).map((t) => Number(t.getAttribute("x")));
      expect(Math.max(...months)).toBeLessThan(w);
      expect(Math.max(...months)).toBeGreaterThan(w * 0.9);
    }
  });

  // Mutant: the key moved inside ChartFit's render, so it appears three times.
  it("keeps the HTML key once, outside the renders", () => {
    const c = heatmap(ALL_KINDS);
    expect(c.querySelectorAll(".hkey").length).toBe(1);
    expect(c.querySelector(".chart-fit .hkey")).toBeNull();
  });

  // Mutant: a fixed id on the grid's svg -- three copies in one document.
  it("repeats no id across the three renders", () => {
    const ids = [...heatmap(ALL_KINDS).querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
