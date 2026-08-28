// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import { BY_CARRIER, type MixDimension, type MixRow } from "@/lib/chart/aircraftMix";

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
//   699  A321nXLR      12000     100     120       1          1  --g1
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
  { code: "699", label: "A321nXLR", ...flat(12000, 100) },
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
const SHADE_ORDER = ["A321nXLR", "A320-1/2", "B757-2", "B767-3/R", "B767-4"];
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

/** `skip` is the months the SUBJECT filed nothing in -- no row for any type, which is what a
 * real absence looks like in a pivot result (14,293 of 23,041 route pairs have at least one).
 * Not the same thing as a type with zero seats in a month it did fly. */
function rows(
  types: TypeSpec[],
  from = WINDOW_FROM,
  to = WINDOW_TO,
  skip: string[] = [],
): MixRow[] {
  const absent = new Set(skip);
  return monthRange(from, to)
    .filter((month) => !absent.has(month))
    .flatMap((month) =>
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

/** The B767-4 takes the lead from the A321nXLR in `year`; everything else is unchanged.
 * `findCrossover` reports `{ year, from: "A321nXLR", to: "B767-4" }`. */
function crossoverAt(year: number): MixRow[] {
  const swap = (before: number, after: number) => (month: string) =>
    Number(month.slice(0, 4)) < year ? before : after;
  return rows([
    { code: "699", label: "A321nXLR", seats: swap(12000, 3000), departures: swap(100, 25) },
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

function chart(rowSet: MixRow[], title = "JFK–LAX", dimension?: MixDimension) {
  const { container } = render(
    <AircraftMixChart rows={rowSet} title={title} dimension={dimension} />,
  );
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

/** Every path drawn in one ramp token, in document order. More than one means the band is
 * broken into pieces, which is what a month with no filings must produce. */
function pathsFor(container: HTMLElement, token: string): Element[] {
  return [...container.querySelectorAll(`path[fill="var(${token})"]`)];
}

/** The x coordinates in a path's outline -- its horizontal extent, which is what says whether
 * the band was drawn ACROSS a month or stopped at it. */
function xsOf(path: Element): number[] {
  return [...path.getAttribute("d")!.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) =>
    Number(m[1]),
  );
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
    expect(textsOf(container)).toContain("B767-4 overtakes A321nXLR · 2019");
    expect(container.querySelector('g[stroke-dasharray] line')).not.toBeNull();
    // and it reaches a screen reader, not only the ink
    expect(svgOf(container).getAttribute("aria-label")).toContain("B767-4 overtakes A321nXLR");
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

  it("renders axis numerics monospaced AND tabular", () => {
    // CLAUDE.md's UI constraint is both words: "All numerics monospaced, tabular-figure".
    // The first version of this test asserted only font-variant, and the chart shipped with
    // Plot's own `font-family: system-ui, sans-serif` on the root -- so the y ticks ("1.2M"),
    // the year ticks and the annotation's year rendered in the sans face while every other
    // numeric on the page was Plex Mono. Breaks if either declaration is dropped.
    const style = svgOf(chart(FLEET)).getAttribute("style");
    expect(style).toContain("font-variant-numeric: tabular-nums");
    expect(style).toContain("font-family: var(--font-mono)");
  });

  // ------------------------------------------------------------------------------------
  // Gaps are gaps (docs/design/system.md § Charts)
  // ------------------------------------------------------------------------------------

  /** The HNL-LAS hole, to the month: the pair filed nothing 2020-04..2020-09. */
  const HNL_LAS_GAP = ["04", "05", "06", "07", "08", "09"].map((m) => `2020-${m}`);

  it("breaks the area at months the subject filed nothing in, rather than drawing across", () => {
    // The M4c defect, in the shape it actually shipped: the x domain came from the months
    // PRESENT in the pivot result, so an absent month was not on the axis at all and Plot
    // joined the two surrounding samples with a straight edge -- roughly 30k, 22k, 15k seats
    // read off a chart for months that filed nothing, inside the COVID band the chart labels
    // "in window on purpose".
    //
    // Falsifiable against both wrong renderings, and confirmed by mutation:
    //   - one areaY over all points (the shipped code) draws ONE path per band spanning the
    //     whole width, so the count assertion fails AND the extent assertion fails;
    //   - zero-filling the hole also draws one path per band, and its outline crosses the gap.
    const container = chart(rows(MEMBERS, WINDOW_FROM, WINDOW_TO, HNL_LAS_GAP));
    const x = xScale(svgOf(container));
    const lastFiled = x("2020-03-01T00:00:00Z");
    const nextFiled = x("2020-10-01T00:00:00Z");

    for (const token of RAMP) {
      const paths = pathsFor(container, token);
      expect(paths.length).toBe(2);
      // No ink between the two: the left piece ends on 2020-03 and the right begins on
      // 2020-10. `toBeLessThanOrEqual` with a 1px slack for the rounding Plot does when it
      // serializes coordinates.
      expect(Math.max(...xsOf(paths[0]))).toBeLessThanOrEqual(lastFiled + 1);
      expect(Math.min(...xsOf(paths[1]))).toBeGreaterThanOrEqual(nextFiled - 1);
    }
  });

  it("draws a single filed month between two gaps instead of erasing it", () => {
    // An area needs two points, so a one-month run serializes to a degenerate, invisible path
    // -- and 9,486 of 22,919 route pairs (41%) have at least one isolated interior month.
    // Dropping the filing would be the same class of dishonesty as inventing one, so those
    // runs are stroked. Breaks if the solo mark is removed: the month vanishes silently, which
    // is exactly the failure that would not be noticed.
    const isolate = monthRange("2020-01", "2020-12").filter((m) => m !== "2020-06");
    const container = chart(rows(MEMBERS, WINDOW_FROM, WINDOW_TO, isolate));
    const x = xScale(svgOf(container));
    const stroked = [...container.querySelectorAll('path[stroke^="var(--g"]')];
    // One hairline column per band, all of them at 2020-06 and nowhere else.
    expect(stroked.length).toBe(RAMP.length);
    expect(new Set(stroked.map((p) => p.getAttribute("stroke")))).toEqual(
      new Set(RAMP.map((t) => `var(${t})`)),
    );
    for (const p of stroked) {
      for (const px of xsOf(p)) expect(px).toBeCloseTo(x("2020-06-01T00:00:00Z"), 0);
    }
  });

  it("says how many months filed nothing, on the key and to a screen reader", () => {
    // A hole in a stacked area reads as "flat and small" as easily as "not filed", and a
    // screen reader sees no hole at all. Paired with the no-gap case below, because a
    // component that printed the sentence unconditionally would satisfy either half alone.
    const container = chart(rows(MEMBERS, WINDOW_FROM, WINDOW_TO, HNL_LAS_GAP));
    expect(container.textContent).toContain("6 months with no filings");
    expect(container.textContent).toContain("drawn as gaps rather than interpolated");
    expect(svgOf(container).getAttribute("aria-label")).toContain("6 months with no filings");

    const whole = chart(FLEET);
    expect(whole.textContent).not.toContain("no filings");
    expect(svgOf(whole).getAttribute("aria-label")).not.toContain("no filings");
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

// ---------------------------------------------------------------------------------------
// M4d: the same component, stacked by a different dimension.
//
// `/aircraft/<slug>` is a page that IS one aircraft type, so the type stack is degenerate
// there -- one band, whose gauge ordering encodes nothing. It stacks by OPERATING CARRIER.
//
// The fixture is modelled on the real 737-800 (measured, see aircraftMix.test.ts) and sharpened
// so the two orderings are EXACT reverses at every position rather than at four of five: the
// carrier with the most seats also flies the densest cabin, so a single sort -- by either key --
// mislabels all five swatches instead of four.
//
//   code   label  seats/mo  dep/mo  gauge    seats rank   gauge rank (shade)
//   19393  WN       59000     300   196.7        1            5  --g5
//   19805  AA       55000     300   183.3        2            4  --g4
//   19977  UA       22000     125   176.0        3            3  --g3
//   19790  DL       13500      80   168.8        4            2  --g2
//   19930  AS        9500      60   158.3        5            1  --g1
//   20422  SY        4000      22   181.8        6         Other
//   20207  XP        2000      11   181.8        7         Other
//
// SY and XP are the second- and third-densest cabins in the fixture and are still in Other:
// membership is a seats question and never a gauge one, on either stack.
// ---------------------------------------------------------------------------------------

const CARRIERS: TypeSpec[] = [
  { code: "19393", label: "WN", ...flat(59000, 300) },
  { code: "19805", label: "AA", ...flat(55000, 300) },
  { code: "19977", label: "UA", ...flat(22000, 125) },
  { code: "19790", label: "DL", ...flat(13500, 80) },
  { code: "19930", label: "AS", ...flat(9500, 60) },
  { code: "20422", label: "SY", ...flat(4000, 22) },
  { code: "20207", label: "XP", ...flat(2000, 11) },
];

/** Ascending gauge, i.e. the order `--g1`..`--g5` must be assigned in -- and the exact reverse
 * of the seats ordering (WN, AA, UA, DL, AS). */
const CARRIER_SHADE_ORDER = ["AS", "DL", "UA", "AA", "WN"];

const FLEET_BY_CARRIER = rows(CARRIERS);

describe("AircraftMixChart stacked by operating carrier", () => {
  it("assigns each shade to the carrier whose cabin density earns it, not to its seat rank", () => {
    // THE test of this task. Breaks if the component (or toBands) collapses the two orderings
    // into one sort: seats-descending gives WN --g1 through AS --g5, the exact reverse of this
    // list, so all five assertions fail rather than the one that a coinciding first position
    // would leave. The M4c fixture that was meant to catch this bug had the two orders
    // coincide, and `const shaded = members` passed it -- hence the reversal here.
    const container = chart(FLEET_BY_CARRIER, "B737-8", BY_CARRIER);
    for (const [i, token] of RAMP.entries()) {
      const swatch = container.querySelector(`.ckey [data-token="${token}"]`);
      expect(swatch?.textContent).toContain(CARRIER_SHADE_ORDER[i]);
    }
  });

  it("titles the chart with the dimension it is actually stacked by", () => {
    // Breaks if "Seats by aircraft type" stays hard-coded in the frame -- the shape of this
    // milestone's most likely regression, and one that leaves a completely plausible-looking
    // chart claiming to break down by a dimension it is not broken down by.
    expect(chart(FLEET_BY_CARRIER, "B737-8", BY_CARRIER).querySelector(".ctitle")?.textContent)
      .toBe("Seats by operating carrier");
    // Paired: the default is unchanged, so /route, /airport and /carrier keep their title.
    expect(chart(FLEET).querySelector(".ctitle")?.textContent).toBe("Seats by aircraft type");
  });

  it("counts the Other bucket in the stack's own unit", () => {
    // Breaks if `plural(n, "type")` stays hard-coded: "2 types" on a chart whose bands are
    // airlines. 6,000 of 165,000 seats a month = 3.6%.
    const other = chart(FLEET_BY_CARRIER, "B737-8", BY_CARRIER).querySelector(
      '.ckey [data-token="--g0"]',
    )!;
    expect(other.textContent).toContain("2 carriers");
    expect(other.textContent).toContain("3.6%");
  });

  it("says what the ramp means for THIS stack, which is not what it means across types", () => {
    // Across aircraft types a darker band is bigger metal. Across carriers of ONE type it is
    // the SAME metal fitted denser -- measured, F9 fits 230.0 seats into the A321 to B6's
    // 172.3. Breaks if the key's note stays "smallest metal", which would describe an encoding
    // this chart is not drawing.
    const key = chart(FLEET_BY_CARRIER, "B737-8", BY_CARRIER).querySelector(".ckey")!.textContent;
    expect(key).toContain("least dense cabin");
    expect(key).not.toContain("smallest metal");
    // Paired, so a component that simply reworded the constant fails: the type stack keeps
    // saying "smallest metal", which is the true claim there.
    expect(chart(FLEET).querySelector(".ckey")!.textContent).toContain("smallest metal");
  });

  it("describes the stack it drew to a screen reader, not the one it used to draw", () => {
    // `role="img"` means the aria-label is the ONLY thing announced, so a stale noun here is
    // the whole chart misdescribed for a reader who cannot see it.
    const label = svgOf(chart(FLEET_BY_CARRIER, "B737-8", BY_CARRIER)).getAttribute("aria-label")!;
    expect(label).toContain("monthly seats by operating carrier");
    expect(label).not.toContain("aircraft type");
    for (const code of CARRIER_SHADE_ORDER) expect(label).toContain(code);
  });

  it("states an absence in the stack's own words rather than drawing an empty frame", () => {
    // Breaks if the empty sentence keeps naming aircraft types on a carrier-stacked page.
    expect(chart([], "B737-8", BY_CARRIER).textContent).toContain("No carrier filings");
    expect(chart([]).textContent).toContain("No aircraft-type filings");
  });
});

// ---------------------------------------------------------------------------------------
/** THE TWO OTHER ABSENCE CAUSES, EACH IN ITS OWN SENTENCE (#121).
 *
 * A month whose every filing was quarantined is a hole for a DIFFERENT reason than an unfiled
 * one, and a month drawn from only its stateable bands is not a hole at all -- it is a stack
 * that understates itself. One merged "N months not drawn" would be true of none of the three,
 * and the visible key is the only channel a sighted reader has.
 *
 * The bug the merged form would be: a chart saying "3 months with no filings" about a month that
 * WAS filed and whose filings all failed an invariant. That is the compound-claim-with-one-false-
 * clause shape `/watch/new-routes` already shipped once. */
describe("the chart names WHICH absence each month is", () => {
  const QUARANTINED_MONTH = "2020-06";

  /** The JFK-LAX fleet with one month emptied of stateable cells (every band NULL there), which
   * is the wholly-quarantined shape: filed, and nothing about it can be stated. */
  function wholly(): MixRow[] {
    return FLEET.map((r) =>
      r.month === QUARANTINED_MONTH ? { ...r, seats: null, departures: null } : r,
    );
  }

  /** ...and the mixed shape: ONE band unstateable in that month, the rest real. */
  function partial(): MixRow[] {
    const target = FLEET.find((r) => r.month === QUARANTINED_MONTH)!.code;
    return FLEET.map((r) =>
      r.month === QUARANTINED_MONTH && r.code === target
        ? { ...r, seats: null, departures: null }
        : r,
    );
  }

  // MUTANT: fold `unknowable` into `gaps` -> the key reads "1 month with no filings" about a
  // month that filed -> red. MUTANT: drop the `unknowableNote` line from the key -> red.
  it("says a wholly-quarantined month was FILED, not unfiled, on the key and to a screen reader", () => {
    const container = chart(wholly());
    expect(container.textContent).toContain("1 month filed but wholly quarantined");
    expect(container.textContent).toContain("every filing failed an invariant");
    expect(svgOf(container).getAttribute("aria-label")).toContain("filed but wholly quarantined");
    // The false sentence must NOT appear: this month is not one with no filings.
    expect(container.textContent).not.toContain("1 month with no filings");
  });

  // MUTANT: drop `understated` from the key or from `describe()` -> a stack short by an
  // unstateable amount is drawn with nothing said about it -> red.
  it("says a partially-quarantined month is understated, and does NOT call it a gap", () => {
    const container = chart(partial());
    expect(container.textContent).toContain("1 month understated");
    // The note names the MARK, not just a total: the unstateable cell is painted at zero height
    // inside a drawn month (a stacked area's y is cumulative, so one band cannot be holed), and
    // 249 of the 420 such cells belong to a top-five MEMBER band across 87 pairs. A reader
    // watching a named band flatten can only recover that from this sentence.
    expect(container.textContent).toContain("drawn at zero height");
    expect(container.textContent).toContain("the stack is lower than the real total");
    expect(svgOf(container).getAttribute("aria-label")).toContain("1 month understated");
    // It is drawn, so it is neither a gap nor a wholly-quarantined month.
    expect(container.textContent).not.toContain("wholly quarantined");
    expect(container.textContent).not.toContain("with no filings");
  });

  // THE ISOLATION, and the reason both fixtures exist. Neither sentence may appear on a clean
  // chart -- without this, a component that printed both unconditionally would satisfy the two
  // tests above.
  it("says neither on a chart with nothing quarantined", () => {
    const container = chart(FLEET);
    expect(container.textContent).not.toContain("wholly quarantined");
    expect(container.textContent).not.toContain("understated");
    const label = svgOf(container).getAttribute("aria-label")!;
    expect(label).not.toContain("wholly quarantined");
    expect(label).not.toContain("understated");
  });
});

// ---------------------------------------------------------------------------------------
/** THE AXIS COVERS THE WINDOW EVERY SENTENCE AROUND IT NAMES.
 *
 * Plot infers its x domain from the marks, and since #121 the marks carry only the months that
 * can be DRAWN -- while the page's `chart: A → B` line, the aria-label and both absence counts
 * all name first->last FILED month. Those were the same range until a wholly-quarantined month
 * stopped being plotted. `/route/LIT-MOB` then said `chart: 2017-05 → 2024-08` over an axis
 * ending in 2021, with 38 of its 85 claimed gap months and its one wholly-quarantined month off
 * the frame entirely: `docs/design/system.md`'s "the aria-label name the range actually drawn",
 * broken. 43 of 16,694 drawn route pairs diverged.
 *
 * ASSERT THE DOMAIN, not a tick count: ticks are `"1 year"`, so a chart can lose eighteen months
 * off its right edge without losing a tick. */
describe("the drawn x axis spans the window the chart claims", () => {
  /** The x extent Plot actually laid out, read back off the axis's own tick positions is not
   * enough (see above) -- this reads the AREA geometry, which is the drawn range itself. */
  function drawnExtent(container: HTMLElement): [number, number] {
    const xs = bandPaths(container).flatMap((p) => xsOf(p));
    return [Math.min(...xs), Math.max(...xs)];
  }

  // A subject filing 2020-01..2020-06 whose LAST month is wholly quarantined: the drawable range
  // ends 2020-05, the stated window ends 2020-06.
  // MUTANT: drop `domain` from the x scale -> Plot fits the marks, the frame ends at 2020-05,
  // and the month the legend calls "filed but wholly quarantined" is not on the chart -> red.
  it("reaches the last filed month even when it cannot be drawn", () => {
    // OUTSIDE THE COVID WINDOW, deliberately. 2020-03..2021-06 gets a `--panel-2` rect clamped
    // to the last FILED month, and that rect is itself a mark -- so an inferred domain stretches
    // to cover it and the missing axis is masked. That is the same coupling this fix repairs
    // (six pairs drew the band past their last drawn month), and a fixture inside the band
    // cannot fail for the reason it is written for.
    const filed = ["2023-01", "2023-02", "2023-03", "2023-04", "2023-05", "2023-06"];
    const rows: MixRow[] = filed.flatMap((month): MixRow[] =>
      month === "2023-06"
        ? [{ month, code: "442", label: "442", seats: null, departures: null }]
        : [{ month, code: "614", label: "614", seats: 1000, departures: 5 }],
    );
    const container = chart(rows);
    // The legend claims it, so the axis must contain it.
    expect(container.textContent).toContain("1 month filed but wholly quarantined");

    const svg = svgOf(container);
    const [, right] = drawnExtent(container);
    // The frame's right edge: the plot's own width less MARGIN.right (mixPlotConfig.ts).
    const frameRight = Number(svg.getAttribute("width")) - 10;
    // Under the bug the last DRAWN month sits at the frame edge, because the domain stopped
    // there. With the domain pinned it sits one month short of it.
    expect(right).toBeLessThan(frameRight - 10);
  });

  // The negative: a subject whose every filed month is drawable must be unchanged -- its last
  // month still reaches the right edge, so the assertion above cannot pass by always shrinking.
  it("still runs to the frame edge when every filed month is drawable", () => {
    const filed = ["2023-01", "2023-02", "2023-03", "2023-04", "2023-05", "2023-06"];
    const rows: MixRow[] = filed.map((month) => ({
      month,
      code: "614",
      label: "614",
      seats: 1000,
      departures: 5,
    }));
    const container = chart(rows);
    const svg = svgOf(container);
    const [, right] = drawnExtent(container);
    expect(right).toBeCloseTo(Number(svg.getAttribute("width")) - 10, 0);
  });
});
