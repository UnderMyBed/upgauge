// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import type { MixRow } from "@/lib/chart/aircraftMix";

// ---------------------------------------------------------------------------------------
// Fixtures
//
// The seat ordering and the gauge ordering DISAGREE at positions 2-5, mirroring the measured
// JFK-LAX table in the spec (§ Encoding). A component that re-derived shade from seat rank --
// or that ignored `band.token` and re-indexed BAND_TOKENS after a sort of its own -- produces a
// plausible-looking chart with the wrong type in the wrong shade, which is the single failure
// this milestone exists to avoid.
//
//   code label      seats/mo  dep/mo  gauge   seats rank   gauge rank (shade)
//   699  A321/LR      12000     100     120       1          1  --g1
//   626  B767-3/R      9000      45     200       2          4  --g4
//   627  B767-4        6000      25     240       3          5  --g5
//   622  B757-2        4800      30     160       4          3  --g3
//   694  A320-1/2      3000      20     150       5          2  --g2
//   638  B737-3        1200      10     120       6          Other
//   650  DC-9-50        400       4     100       7          Other
// ---------------------------------------------------------------------------------------

type TypeSpec = {
  code: string;
  label: string;
  /** Seats in the given month. A function so a fixture can move its leader between years. */
  seats: (month: string) => number;
  /** Departures in the given month; seats/departures is the gauge that fixes the shade. */
  departures: (month: string) => number;
};

function flat(seats: number, departures: number) {
  return { seats: () => seats, departures: () => departures };
}

const MEMBERS: TypeSpec[] = [
  { code: "699", label: "A321/LR", ...flat(12000, 100) },
  { code: "626", label: "B767-3/R", ...flat(9000, 45) },
  { code: "627", label: "B767-4", ...flat(6000, 25) },
  { code: "622", label: "B757-2", ...flat(4800, 30) },
  { code: "694", label: "A320-1/2", ...flat(3000, 20) },
];

const OTHERS: TypeSpec[] = [
  { code: "638", label: "B737-3", ...flat(1200, 10) },
  { code: "650", label: "DC-9-50", ...flat(400, 4) },
];

/** Ascending gauge, i.e. the order `--g1`..`--g5` must be assigned in. */
const SHADE_ORDER = ["A321/LR", "A320-1/2", "B757-2", "B767-3/R", "B767-4"];
const RAMP = ["--g1", "--g2", "--g3", "--g4", "--g5"];

const WINDOW_FROM = "2015-01";
const WINDOW_TO = "2026-04";

function monthRange(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const out: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

function rows(types: TypeSpec[], from = WINDOW_FROM, to = WINDOW_TO): MixRow[] {
  return monthRange(from, to).flatMap((month) =>
    types.map((t) => ({
      month,
      code: t.code,
      label: t.label,
      seats: t.seats(month),
      departures: t.departures(month),
    })),
  );
}

/** Seven types: five bands plus a two-type Other. */
const FLEET = rows([...MEMBERS, ...OTHERS]);
/** Exactly five types, so there is nothing left over to aggregate. */
const FIVE_TYPES = rows(MEMBERS);

/** The B767-4 takes the lead from the A321/LR in `year`; everything else is unchanged.
 * `findCrossover` reports `{ year, from: "A321/LR", to: "B767-4" }`. */
function crossoverAt(year: number): MixRow[] {
  const swap = (before: number, after: number) => (month: string) =>
    Number(month.slice(0, 4)) < year ? before : after;
  return rows([
    { code: "699", label: "A321/LR", seats: swap(12000, 3000), departures: swap(100, 25) },
    { code: "626", label: "B767-3/R", ...flat(9000, 45) },
    { code: "627", label: "B767-4", seats: swap(6000, 15000), departures: swap(25, 62.5) },
    { code: "622", label: "B757-2", ...flat(4800, 30) },
    { code: "694", label: "A320-1/2", ...flat(3000, 20) },
    ...OTHERS,
  ]);
}

// ---------------------------------------------------------------------------------------
// Readers over the serialized SVG
// ---------------------------------------------------------------------------------------

function chart(rowSet: MixRow[], title = "JFK–LAX") {
  const { container } = render(<AircraftMixChart rows={rowSet} title={title} />);
  return container;
}

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("no <svg> in the rendered output");
  return svg as unknown as SVGSVGElement;
}

/** The band areas, in document order (which is stack order, bottom first). */
function bandPaths(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('path[fill^="var(--g"]')];
}

function fillsOf(container: HTMLElement): string[] {
  return bandPaths(container).map((p) => p.getAttribute("fill")!);
}

/** The highest point of a band's outline: the top edge of the stack up to and including it.
 * Smaller y is higher on the screen, so over a stack of positive bands this must fall
 * strictly as the stack is climbed. */
function topOf(path: Element): number {
  const ys = [...path.getAttribute("d")!.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) =>
    Number(m[2]),
  );
  return Math.min(...ys);
}

/** A `date -> x` mapping read out of the chart's OWN x axis, by fitting the two outermost
 * year ticks. Self-calibrating on purpose: it survives a change of width or margin, and
 * still pins the thing under test -- that a mark claiming to sit at a given month is drawn
 * where that month actually falls. */
function xScale(svg: SVGSVGElement): (iso: string) => number {
  const group = svg.querySelector('g[aria-label="x-axis tick label"]');
  if (group === null) throw new Error("no x-axis tick labels");
  const ticks = [...group.querySelectorAll("text")].map((t) => ({
    t: Date.parse(`${t.textContent}-01-01T00:00:00Z`),
    x: Number(/translate\(([-\d.]+),/.exec(t.getAttribute("transform")!)![1]),
  }));
  const [a, b] = [ticks[0], ticks[ticks.length - 1]];
  const perMs = (b.x - a.x) / (b.t - a.t);
  return (iso) => a.x + (Date.parse(iso) - a.t) * perMs;
}

function covidRect(container: HTMLElement): Element | null {
  return container.querySelector('g[fill="var(--panel-2)"] rect');
}

function textsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll("svg text")].map((t) => t.textContent ?? "");
}

// ---------------------------------------------------------------------------------------

describe("AircraftMixChart", () => {
  it("draws one filled area per band, in the six ramp tokens and no others", () => {
    // Breaks if: the colour scale's range is dropped or reordered (Plot then emits its own
    // categorical hues, and `hue is never load-bearing` is violated), or if a band is lost.
    const fills = fillsOf(chart(FLEET));
    expect(fills.length).toBe(6);
    expect(new Set(fills)).toEqual(new Set(["--g0", ...RAMP].map((t) => `var(${t})`)));
  });

  it("stacks lightest at the bottom and darkest on top", () => {
    // Breaks if: the stack order is reversed, dropped (leaving Plot's input order), or the
    // Other band is stacked anywhere but the bottom. Asserted on GEOMETRY, not on document
    // order -- a reversed `order` array still emits six paths with six correct fills, so any
    // assertion over the fill list alone passes under the bug.
    const container = chart(FLEET);
    const tops = ["--g0", ...RAMP].map((token) =>
      topOf(container.querySelector(`path[fill="var(${token})"]`)!),
    );
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeLessThan(tops[i - 1]);
    }
  });

  it("assigns each shade to the type whose gauge earns it, not to its seat rank", () => {
    // Breaks if: the component re-sorts the bands by seats, or re-derives tokens by array
    // index after a sort of its own. The fixture's seat order and gauge order disagree at
    // positions 2-5, so a single-sort implementation mislabels four of the five swatches.
    const container = chart(FLEET);
    for (const [i, token] of RAMP.entries()) {
      const swatch = container.querySelector(`.ckey [data-token="${token}"]`);
      expect(swatch?.textContent).toContain(SHADE_ORDER[i]);
    }
  });

  it("draws the COVID band across 2020-03 to 2021-06, positioned on the chart's own x axis", () => {
    // Breaks if: the band's dates are wrong, or the rect is drawn at a fixed pixel offset.
    // The expectation is computed from the rendered axis, so it holds independently of the
    // width and margins.
    const container = chart(FLEET);
    const x = xScale(svgOf(container));
    const rect = covidRect(container)!;
    expect(Number(rect.getAttribute("x"))).toBeCloseTo(x("2020-03-01T00:00:00Z"), 0);
    const right = Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"));
    expect(right).toBeCloseTo(x("2021-06-01T00:00:00Z"), 0);
  });

  it("moves the COVID band with the window rather than drawing it at a fixed place", () => {
    // Breaks if: the rect is hardcoded to a fraction of the frame. Over 2019-01..2022-12 the
    // same 16 months occupy roughly a third of the chart instead of a ninth of it, so a
    // fixed-geometry implementation cannot satisfy both this and the test above.
    const container = chart(rows([...MEMBERS, ...OTHERS], "2019-01", "2022-12"));
    const x = xScale(svgOf(container));
    const rect = covidRect(container)!;
    expect(Number(rect.getAttribute("x"))).toBeCloseTo(x("2020-03-01T00:00:00Z"), 0);
    const width = Number(rect.getAttribute("width"));
    expect(width).toBeCloseTo(x("2021-06-01T00:00:00Z") - x("2020-03-01T00:00:00Z"), 0);

    const full = chart(FLEET);
    expect(width).toBeGreaterThan(Number(covidRect(full)!.getAttribute("width")) * 2);
  });

  it("labels the COVID band, on the band", () => {
    // Breaks if: the label is dropped, reworded, or parked at the frame's centre rather than
    // the band's. Presence alone would pass with the label anywhere on the chart.
    const container = chart(FLEET);
    const label = [...container.querySelectorAll("svg text")].find((t) =>
      t.textContent?.startsWith("COVID"),
    );
    expect(label?.textContent).toBe("COVID — in window on purpose.");
    const rect = covidRect(container)!;
    const mid = Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2;
    const at = Number(/translate\(([-\d.]+),/.exec(label!.getAttribute("transform")!)![1]);
    expect(at).toBeCloseTo(mid, 0);
  });

  it("omits the COVID band entirely when the window does not reach it", () => {
    // Breaks if: the rect is drawn unconditionally -- which puts a --panel-2 slab at a
    // meaningless x, since 2020-03 is off the left of a 2023-2025 window.
    const container = chart(rows(MEMBERS, "2023-01", "2025-12"));
    expect(covidRect(container)).toBeNull();
    expect(textsOf(container).some((t) => t.startsWith("COVID"))).toBe(false);
  });

  it("carries role=img on the SVG itself and an aria-label naming the series and the window", () => {
    // Breaks if: role/aria-label move to a wrapper (the SVG then reaches AT unlabelled, with
    // every axis-tick group announced), or the label degrades to a generic word. Asserted
    // against CONTENT -- every band label, both window bounds, the subject and the encoding --
    // because "chart" satisfies any non-empty check.
    const svg = svgOf(chart(FLEET));
    expect(svg.getAttribute("role")).toBe("img");
    const label = svg.getAttribute("aria-label")!;
    for (const type of SHADE_ORDER) expect(label).toContain(type);
    expect(label).toContain(WINDOW_FROM);
    expect(label).toContain(WINDOW_TO);
    expect(label).toContain("JFK–LAX");
    expect(label).toContain("seats per departure");
  });

  it("draws the derived crossover annotation when there is one", () => {
    // Breaks if: the annotation is not rendered, or its text is hand-written rather than
    // derived -- the fixture's leader change is invented here, so no hardcoded string can
    // match it.
    const container = chart(crossoverAt(2019));
    expect(textsOf(container)).toContain("B767-4 overtakes A321/LR · 2019");
    expect(container.querySelector('g[stroke-dasharray] line')).not.toBeNull();
    // and it reaches a screen reader, not only the ink
    expect(svgOf(container).getAttribute("aria-label")).toContain("B767-4 overtakes A321/LR");
  });

  it("draws no annotation when the #1 type never changes", () => {
    // Paired with the test above on purpose: alone, this passes for a component that never
    // renders an annotation at all. FLEET's leader is constant, so the honest output is
    // nothing -- and `findCrossover` returns null for 46% of real routes, JFK-LAX included.
    const container = chart(FLEET);
    expect(textsOf(container).some((t) => t.includes("overtakes"))).toBe(false);
    expect(container.querySelector("g[stroke-dasharray]")).toBeNull();
    expect(svgOf(container).getAttribute("aria-label")).not.toContain("overtakes");
  });

  it("anchors the annotation away from whichever edge it would otherwise overflow", () => {
    // Breaks if: the text anchor is fixed. A 2025 crossover on a window ending 2026-04 leaves
    // ~10% of the width to the right of the rule; a start-anchored 30-character label runs off
    // the frame.
    const early = chart(crossoverAt(2019));
    const late = chart(crossoverAt(2025));
    const anchorOf = (c: HTMLElement) =>
      [...c.querySelectorAll("svg g")]
        .find((g) => g.textContent?.includes("overtakes"))
        ?.getAttribute("text-anchor");
    expect(anchorOf(early)).toBe("start");
    expect(anchorOf(late)).toBe("end");
  });

  it("draws and names the Other band only when there is something in it", () => {
    // A pair, for the same reason as the annotation pair: an implementation that always draws
    // Other passes the seven-type case, and one that never draws it passes the five-type case.
    const seven = chart(FLEET);
    expect(seven.querySelector('path[fill="var(--g0)"]')).not.toBeNull();
    const other = seven.querySelector('.ckey [data-token="--g0"]')!;
    // Honesty requirement (spec § "The Other band is not a rounding error"): how many types,
    // and what share of seats. 1,600 of 36,400 seats a month = 4.4%.
    expect(other.textContent).toContain("2 types");
    expect(other.textContent).toContain("4.4%");

    const five = chart(FIVE_TYPES);
    expect(five.querySelector('path[fill="var(--g0)"]')).toBeNull();
    expect(five.querySelector('.ckey [data-token="--g0"]')).toBeNull();
  });

  it("renders axis numerics with tabular figures", () => {
    // CLAUDE.md's UI constraint. Breaks if the root style is dropped: Plot sets
    // font-variant on its two axis groups but nothing else, so the annotation's year and the
    // COVID label would fall back to proportional figures.
    expect(svgOf(chart(FLEET)).getAttribute("style")).toContain(
      "font-variant-numeric: tabular-nums",
    );
  });

  it("states the absence in words rather than drawing an empty frame", () => {
    // Breaks if: an empty or one-month row set is handed to Plot anyway. Plot's x domain then
    // collapses to a point and the areas serialize to zero width -- a blank panel under a DATA
    // AS OF badge, which is the failure mode /explore and /route already refuse.
    const empty = chart([]);
    expect(empty.querySelector("svg")).toBeNull();
    expect(empty.textContent).toContain("No aircraft-type filings");

    const one = chart(rows(MEMBERS, "2026-04", "2026-04"));
    expect(one.querySelector("svg")).toBeNull();
    expect(one.textContent).toContain("2026-04");
    expect(one.textContent).toContain("one month");
  });

  it("names the subject without claiming to know what kind of thing it is", () => {
    // The component is mounted on /route now and on /airport, /carrier and /aircraft in M4d
    // (spec § What ships): its props are a row set and a title, and it must not hardcode
    // "route" anywhere a reader can see.
    const container = chart(FLEET, "Alaska Airlines");
    expect(container.textContent).toContain("Alaska Airlines");
    expect(container.textContent).not.toMatch(/route/i);
  });
});
