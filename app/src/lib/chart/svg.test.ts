import { describe, expect, it } from "vitest";
import { renderPlotToSvg, sharedDocumentFootprint } from "@/lib/chart/svg";
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
    // rather than asserted in a comment.
    //
    // The first version of this test could not fail for the reason it named, and svg.ts and
    // hosting.md both claimed it could (M4c final review, F2). It asserted
    // `mark().length === first.length` -- the byte length of the RETURNED, DETACHED node.
    // Appending that node to the shared document does not change the node's own outerHTML, so
    // the regression was invisible to it: a deliberately leaky renderer returned 1,384 bytes
    // on every one of 12 renders while document.body grew to 16,608, and the test was green.
    //
    // It now observes THE DOCUMENT, which is the only place the regression is visible.
    // Falsifiable, and confirmed by mutation: adding `document.body.appendChild(node)` to
    // renderPlotToSvg turns this red on both assertions.
    const before = sharedDocumentFootprint();
    const mark = () => renderPlotToSvg({ marks: [Plot.dot([{ x: 1, y: 1 }], { x: "x", y: "y" })] });
    for (let i = 0; i < 12; i++) mark();
    const after = sharedDocumentFootprint();

    // Nothing was ever attached -- the absolute claim, which also catches a leak from any
    // earlier test in this file, since the document is shared across all of them.
    expect(after.nodes).toBe(0);
    // ...and nothing grew, which is the claim that survives if an empty <head>/<body> ever
    // stops being the baseline (a JSDOM upgrade, say). Both, because either alone is weaker:
    // a renderer that replaced the body's contents each time holds `nodes` at 1 and `bytes`
    // steady, and this pair rejects it on the first assertion.
    expect(after.bytes).toBe(before.bytes);
  });
});
