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
 * renders. `svg.test.ts` pins it, so a future Plot release that starts appending fails a
 * test instead of leaking memory in production.
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
