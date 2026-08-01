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
    expect(screen.getByText(/quarantined/)).toBeDefined();
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
});
