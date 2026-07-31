import { JSDOM } from "jsdom";
import * as Plot from "@observablehq/plot";

/** Render an Observable Plot config to serialized SVG on the server.
 *
 * Plot needs a DOM to build nodes in. The document is created ONCE for the module, not per
 * call, and that is safe for a specific reason: Plot never appends its output into the
 * document it is handed. `plot.js:156` creates the root with d3's `creator("svg")` (the
 * document is used only to resolve the namespace), builds marks into that detached node, and
 * `plot.js:360` returns it still detached. Nothing is ever attached to `document.body`.
 *
 * That is measured, not inferred from reading: a shared document grew 0 bytes across 25
 * renders. `svg.test.ts` pins it through `sharedDocumentFootprint()` below, so a future Plot
 * release that starts appending fails a test instead of leaking memory in production.
 *
 * The first version of that test could not do so, and this comment claimed it could. It
 * asserted the byte length of the RETURNED, DETACHED node across repeated renders -- a value
 * appending to the document does not change. Demonstrated, not inferred: a renderer that did
 * `document.body.appendChild(node)` kept returning 1,384 bytes across 12 renders while
 * `document.body` grew to 16,608, and the test stayed green (M4c final review, F2).
 *
 * A per-call `new JSDOM()` was the first implementation, justified by the opposite claim.
 * It cost 8.59 ms per render against 3.93 ms shared -- `new JSDOM()` alone is 5.21 ms, more
 * than the entire plot -- on a `force-dynamic` page that renders this on every cache miss.
 *
 * Single-threaded and synchronous: `Plot.plot()` never yields, so two concurrent requests
 * cannot interleave inside a render and the shared document needs no locking.
 *
 * Returns markup, not a node, so callers stay free of DOM types and the value can cross
 * into `dangerouslySetInnerHTML` directly. */
const { document } = new JSDOM().window;

export function renderPlotToSvg(config: Plot.PlotOptions): string {
  const node = Plot.plot({ ...config, document });
  return node.outerHTML;
}

/** What the shared document is currently holding. Exported for exactly one caller,
 * `svg.test.ts`, because the property this module's design rests on -- that renders do not
 * accumulate -- is a property OF THE DOCUMENT, and NOTHING about the returned node can
 * observe it. That is what made the previous test inert.
 *
 * A probe rather than the document itself, for two reasons the header above already commits
 * to: exporting the document would put a DOM type on this module's public surface ("callers
 * stay free of DOM types"), and it would hand every future caller a writable handle to the
 * one object whose emptiness is the safety argument.
 *
 * `documentElement`, not `body`: an append to `<head>` -- an injected `<style>`, say -- leaks
 * exactly as much as an append to `<body>` and would slip past a body-only probe. */
export function sharedDocumentFootprint(): { nodes: number; bytes: number } {
  return {
    nodes: document.head.childNodes.length + document.body.childNodes.length,
    bytes: document.documentElement.outerHTML.length,
  };
}
