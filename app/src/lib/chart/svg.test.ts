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

  it("renders independent output per call, with no carry-over from the previous render", () => {
    // The original form of this test compared two IDENTICAL renders and asserted equal
    // length, claiming to prove a fresh document per call. It could not: Plot never appends
    // to the document it is handed (see svg.ts), so a shared document produces byte-identical
    // output either way, and the regression it named was undetectable. Measured: a shared
    // document grew 0 bytes across 25 renders.
    //
    // Falsifiable as written: two renders with DIFFERENT data must differ, and neither may
    // contain the other's marks. An implementation that carried state between calls -- or one
    // that memoized and returned the first render again -- fails on the exact counts.
    const one = renderPlotToSvg({
      marks: [Plot.dot([{ x: 1, y: 1 }], { x: "x", y: "y" })],
    });
    const three = renderPlotToSvg({
      marks: [
        Plot.dot(
          [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 },
          ],
          { x: "x", y: "y" },
        ),
      ],
    });
    expect((one.match(/<circle/g) ?? []).length).toBe(1);
    expect((three.match(/<circle/g) ?? []).length).toBe(3);
  });

  it("keeps the shared document from accumulating, which is what makes it safe to share", () => {
    // This is the assumption svg.ts's module-level document RESTS on, so it is pinned here
    // rather than asserted in a comment. Falsifiable against the thing that would actually
    // break it: a future Plot release that appends its output into the document instead of
    // returning a detached node. Then render N+1 grows relative to render N and this fails,
    // telling us to go back to a per-call document.
    const mark = () => renderPlotToSvg({ marks: [Plot.dot([{ x: 1, y: 1 }], { x: "x", y: "y" })] });
    const first = mark();
    for (let i = 0; i < 10; i++) mark();
    expect(mark().length).toBe(first.length);
  });
});
