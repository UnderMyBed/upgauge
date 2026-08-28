// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Chip, ChipRow } from "@/components/builder/Chips";

describe("Chip", () => {
  it("renders a real anchor, so the control works with JS off", () => {
    const { container } = render(<Chip href="/explore?v=1" label="Segment" />);
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("/explore?v=1");
  });

  it("marks the current option with aria-current, not colour alone", () => {
    const { container } = render(<Chip href="/explore?v=1" label="Segment" current />);
    expect(container.querySelector("a")!.getAttribute("aria-current")).toBe("page");
  });

  it("renders an inert option as a non-anchor carrying its stated reason", () => {
    const { container } = render(
      <Chip href={null} label="Aircraft type" reason="not available at route grain" />,
    );
    expect(container.querySelector("a")).toBeNull();
    const span = container.querySelector(".chip-off")!;
    expect(span.getAttribute("title")).toBe("not available at route grain");
  });

  it("marks a derived measure so it is distinguishable from an additive one", () => {
    const { container } = render(<Chip href="/x" label="Load factor" derived />);
    expect(container.querySelector(".chip-derived")).not.toBeNull();
  });
});

describe("ChipRow", () => {
  it("labels the row with its URL key, so the interface teaches the format", () => {
    const { container } = render(<ChipRow urlKey="d" label="Group by"><span /></ChipRow>);
    expect(container.querySelector(".chip-key")!.textContent).toBe("d");
  });
});
