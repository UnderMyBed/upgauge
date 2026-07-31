// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LegendRail } from "@/components/LegendRail";

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
});
