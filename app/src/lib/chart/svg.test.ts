import { describe, expect, it } from "vitest";
import { renderPlotToSvg } from "@/lib/chart/svg";
import * as Plot from "@observablehq/plot";

describe("renderPlotToSvg", () => {
  it("returns serialized SVG markup containing the plotted data", () => {
    const svg = renderPlotToSvg({
      marks: [
        Plot.areaY(
          [
            { x: 1, y: 10 },
            { x: 2, y: 20 },
          ],
          { x: "x", y: "y" },
        ),
      ],
    });
    // Falsifiable: a renderer that returned "" , or returned the jsdom document rather than
    // the SVG node, or failed to serialize, fails all three.
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).toContain("</svg>");
    expect(svg).toMatch(/<path[^>]+d="/);
  });

  it("does not leak a document between calls", () => {
    // Falsifiable: a module-level shared document accumulates children across calls, so the
    // second render would contain the first's paths too. Counts must be equal, not merely > 0.
    const one = renderPlotToSvg({ marks: [Plot.dot([{ x: 1, y: 1 }], { x: "x", y: "y" })] });
    const two = renderPlotToSvg({ marks: [Plot.dot([{ x: 1, y: 1 }], { x: "x", y: "y" })] });
    expect(two.length).toBe(one.length);
  });
});
