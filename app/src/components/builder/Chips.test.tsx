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

  it("leaves aria-current absent on an option that is not current", () => {
    // Named for the mutant that hard-codes aria-current="page" unconditionally: that bug
    // left the test above green, since nothing checked the negative case. .chip[aria-current
    // ="page"] is the CSS's only hook for --signal plus the weight change, so a chip that
    // always carries the attribute would make every option look active.
    const { container } = render(<Chip href="/explore?v=1" label="Route" />);
    expect(container.querySelector("a")!.getAttribute("aria-current")).toBeNull();
  });

  it("renders an inert option as a non-anchor carrying its stated reason", () => {
    const { container } = render(
      <Chip href={null} label="Aircraft type" reason="not available at route grain" />,
    );
    expect(container.querySelector("a")).toBeNull();
    const span = container.querySelector(".chip-off")!;
    expect(span.getAttribute("title")).toBe("not available at route grain");
  });

  // `title` reaches a mouse only -- neither a keyboard user (the span stays non-focusable, by
  // design) nor a screen reader gets it from `title` alone. The reason must also be in the DOM
  // text a screen reader actually reads. Named for the mutant that keeps `title` but drops the
  // sr-only text: that bug leaves the test above green, since it only checks the title attribute.
  it("states the inert reason in text a screen reader reads, not only in title", () => {
    const { container } = render(
      <Chip href={null} label="Aircraft type" reason="not available at route grain" />,
    );
    const span = container.querySelector(".chip-off")!;
    expect(span.textContent).toContain("not available at route grain");
    // Still not focusable and not interactive -- an inert option stays a non-anchor.
    expect(span.tagName).toBe("SPAN");
    expect(span.getAttribute("tabindex")).toBeNull();
  });

  it("marks a derived measure so it is distinguishable from an additive one", () => {
    const { container } = render(<Chip href="/x" label="Load factor" derived />);
    expect(container.querySelector(".chip-derived")).not.toBeNull();
  });

  it("does not mark an additive measure as derived", () => {
    // Named for the mutant that hard-codes className = "chip chip-derived" unconditionally:
    // that bug left the test above green, since nothing checked the negative case.
    const { container } = render(<Chip href="/x" label="Seats" />);
    expect(container.querySelector(".chip-derived")).toBeNull();
  });
});

describe("ChipRow", () => {
  it("labels the row with its URL key, so the interface teaches the format", () => {
    const { container } = render(<ChipRow urlKey="d" label="Group by"><span /></ChipRow>);
    expect(container.querySelector(".chip-key")!.textContent).toBe("d");
  });
});
