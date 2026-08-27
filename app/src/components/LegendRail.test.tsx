// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LegendRail } from "@/components/LegendRail";
import { BY_CARRIER } from "@/lib/chart/aircraftMix";

describe("LegendRail", () => {
  it("renders the panel", () => {
    const { container } = render(<LegendRail />);
    expect(container.querySelector("aside.legend")).not.toBeNull();
    expect(screen.getByText("Chart legend")).toBeDefined();
  });

  it("explains every row-mark glyph the gutter can show", () => {
    render(<LegendRail />);
    expect(screen.getByText("⌀")).toBeDefined();
    expect(screen.getByText(/flew, carried no passengers/)).toBeDefined();
    expect(screen.getByText("n")).toBeDefined();
    expect(screen.getByText(/below the 30-departure floor/)).toBeDefined();
    expect(screen.getByText("Q")).toBeDefined();
    // Anchored, not a bare /quarantined/: the em-dash row below this group also says
    // "quarantined", and an unscoped match is ambiguous between the two -- the same scoping
    // this file's map-legend test already needed for "below the 30-departure floor".
    expect(screen.getByText(/^quarantined — failed an invariant$/)).toBeDefined();
    expect(screen.getByText(/computed measure/)).toBeDefined();
  });

  it("carries the operating-carrier grain explanation", () => {
    render(<LegendRail />);
    expect(screen.getByText(/operating carrier is the grain/i)).toBeDefined();
  });

  it("states the fixed gauge axis and its regional/widebody bands", () => {
    render(<LegendRail />);
    expect(screen.getByText(/fixed 0–260 axis/)).toBeDefined();
    expect(screen.getByText(/regional metal/)).toBeDefined();
    expect(screen.getByText(/widebody/)).toBeDefined();
  });

  it("states that codes are current identity, not point-in-time filings", () => {
    render(<LegendRail />);
    expect(screen.getByText(/current identity/i)).toBeDefined();
  });

  // M5, Task 2, "D3": public-domain attribution for the source data. Unconditional --
  // rendered on a rail mounted WITHOUT the fleetMix opt-in, unlike the fleet-shading group,
  // because it is true of every view the rail appears on, not only the ones with a chart.
  it("states the source data is public-domain US Government filings, without fleetMix", () => {
    render(<LegendRail />);
    expect(screen.getByText(/US DOT/i)).toBeDefined();
    expect(screen.getByText(/BTS|Bureau of Transportation Statistics/i)).toBeDefined();
    expect(screen.getByText(/T-100/i)).toBeDefined();
    expect(screen.getByText(/public-domain/i)).toBeDefined();
  });

  // M4c. The rail is the project's standing "how to read this", so the temptation is to put
  // every encoding in it once and be done. The rule this component already follows (its own
  // header, on the mockup's map group) is the opposite: describe the encodings THIS view uses.
  // /explore draws no chart.
  it("omits the fleet-shading group unless a chart is on the page", () => {
    render(<LegendRail />);
    expect(screen.queryByText(/darkening stack is an upgauge/i)).toBeNull();
    expect(screen.queryByText(/Fleet shading/i)).toBeNull();
  });

  it("explains the gauge ramp when a chart is on the page", () => {
    render(<LegendRail fleetMix />);
    expect(screen.getByText("Fleet shading")).toBeDefined();
    expect(screen.getByText(/smaller metal/)).toBeDefined();
    expect(screen.getByText(/larger metal/)).toBeDefined();
    // The methodology, not a restatement of the chart's per-subject numbers: BOTH orderings,
    // because "shaded by gauge" alone leaves a reader thinking the biggest band is the biggest
    // aircraft. Fails if the group is reduced to the ramp sentence alone.
    expect(screen.getByText(/ordered by seats per departure/i)).toBeDefined();
    expect(screen.getByText(/darkening stack is an upgauge/i)).toBeDefined();
    expect(screen.getByText(/five types with the most seats/i)).toBeDefined();
  });

  it("draws its swatches from the ramp tokens, not from copied hex", () => {
    // globals.css is the single source for --g0..--g5 (system.md § Charts, and the same rule
    // the chart component follows by passing `var(--gN)` into Plot's colour range). The
    // mockup this group is ported from hardcodes #C8D3D1/#21514A; copying those down here
    // would make a palette change silently disagree with the chart standing next to it.
    const { container } = render(<LegendRail fleetMix />);
    expect(container.querySelector('rect[fill="var(--g1)"]')).not.toBeNull();
    expect(container.querySelector('rect[fill="var(--g5)"]')).not.toBeNull();
  });

  it("states that the shaded months are COVID, drawn on purpose", () => {
    // The band is --panel-2 and carries a label inside the SVG, but the rail is where a
    // reader who cannot see the chart finds out what the shading means -- and it names the
    // months, so it cannot drift from the chart's own COVID_FROM/COVID_TO without a test
    // failing here.
    render(<LegendRail fleetMix />);
    expect(screen.getByText(/2020-03 to 2021-06/)).toBeDefined();
  });

  // M4d. The rail must describe the stack the page actually draws. `/aircraft/<slug>` stacks
  // seats by operating carrier, so "the five types with the most seats" and "larger metal" are
  // both false there -- every band is the SAME metal, configured differently.
  it("describes the carrier stack when that is what the page drew", () => {
    render(<LegendRail fleetMix stack={BY_CARRIER} />);
    expect(screen.getByText(/five carriers with the most seats/i)).toBeDefined();
    expect(screen.getByText(/denser cabin/)).toBeDefined();
    // Falsifiable against a rail that merely appended the new words: the type-stack claims
    // must be GONE, not accompanied.
    expect(screen.queryByText(/larger metal/)).toBeNull();
    expect(screen.queryByText(/five types with the most seats/i)).toBeNull();
    // The parts that are true of every stack stay put.
    expect(screen.getByText(/darkening stack is an upgauge/i)).toBeDefined();
    expect(screen.getByText(/2020-03 to 2021-06/)).toBeDefined();
  });

  // Final whole-branch review, Important #5: `/airport/<code>` draws a network map (M7) whose
  // three encodings (width <- seats, dash <- load factor, dotted/muted <- below the
  // 30-departure floor) were explained NOWHERE on the served page -- this rail had no arc
  // group at all, and its own header comment said outright "this page has no map." Same
  // opt-in shape as fleetMix: omitted unless a map is actually drawn.
  it("omits the arc-rendering group unless a map is on the page", () => {
    render(<LegendRail />);
    expect(screen.queryByText("Arc rendering")).toBeNull();
    expect(screen.queryByText(/width scales with seats/i)).toBeNull();
  });

  it("explains the arc encodings when a map is on the page", () => {
    render(<LegendRail map />);
    expect(screen.getByText("Arc rendering")).toBeDefined();
    expect(screen.getByText(/width scales with seats/i)).toBeDefined();
    expect(screen.getByText(/load factor is below 70%/i)).toBeDefined();
    // Scoped past "below the 30-departure floor" alone: the Row-marks group (always
    // rendered, `map` or not) already contains that exact phrase for its own `n` glyph, so an
    // unscoped match would be ambiguous between the two groups.
    expect(screen.getByText(/dotted, muted -- below the 30-departure floor/i)).toBeDefined();
    // The straight-line-across-a-panel-boundary fact system.md claims "the page says so" for
    // -- it must actually be true, not merely asserted in a doc. Direction-agnostic wording:
    // re-review finding 4 found the old "into an inset panel" phrasing false for every
    // inset-origin airport (ANC, HNL, SJU, GUM), whose cross-panel arcs go the other way.
    expect(screen.getByText(/straight line instead/i)).toBeDefined();
  });

  // The rail is the methodology surface -- system.md: "there is no separate 'how to read this'
  // page to go stale" -- so a cell treatment the tables use has to be DECLARED here. `—` was
  // promoted to a documented state (system.md § States, "Unknowable") while the rail still
  // listed only ⌀, n, Q and abc, leaving a reader to guess whether a dash meant zero, missing
  // or broken.
  // MUTANT: delete the em-dash `lrow` from LegendRail.tsx -> this goes red.
  it("declares the em dash, not only the gutter glyphs", () => {
    render(<LegendRail />);
    expect(screen.getByText(/no measure to state/i)).toBeDefined();
  });

  it("does not name a cause the page may contradict", () => {
    // This rail renders on EVERY table view, so it cannot know why a given dash is there --
    // nothing filed, every filing quarantined, or a zero denominator are all `—`. Naming
    // quarantine here put "every filing quarantined" beside a foot reading "0 quarantined
    // rows" on 290 airport pages, and over-claimed on /explore besides.
    // MUTANT: restore "— every filing quarantined" to the em-dash row -> red.
    const { container } = render(<LegendRail />);
    const rows = [...container.querySelectorAll(".lrow")].map((r) => r.textContent ?? "");
    const dash = rows.find((t) => t.includes("no measure to state"));
    expect(dash).toBeDefined();
    expect(dash).not.toMatch(/quarantined/i);
  });

  it("paints the em dash as a data-availability mark, not an out-of-limit one", () => {
    // A TEXT ASSERTION CANNOT SEE THIS. globals.css gives `.lrow b` --limit and `.lrow b.k`
    // --ink, so a swatch without `.k` declares the dash in the same red as `Q` and `⌀` while
    // the tables draw it in ordinary ink -- the legend then does not look like the mark it
    // declares, and re-states through colour the cause-claim its words refuse.
    // MUTANT: drop `className="k"` from the em-dash `<b>` -> red.
    const { container } = render(<LegendRail />);
    const dash = [...container.querySelectorAll(".lrow b")].find((b) => b.textContent === "—");
    expect(dash).toBeDefined();
    expect(dash!.className).toContain("k");
    // The `n` glyph is the existing member of that class; `Q` is the contrast that proves the
    // assertion is about this row and not about every glyph in the group.
    const q = [...container.querySelectorAll(".lrow b")].find((b) => b.textContent === "Q");
    expect(q!.className).not.toContain("k");
  });

  it("draws the map legend's swatches from the ink tokens, not copied hex", () => {
    const { container } = render(<LegendRail map />);
    expect(container.querySelector('line[stroke="var(--ink)"]')).not.toBeNull();
    expect(container.querySelector('line[stroke="var(--ink-3)"]')).not.toBeNull();
  });
});
