import { JSDOM } from "jsdom";
import * as Plot from "@observablehq/plot";

/** Render an Observable Plot config to serialized SVG on the server.
 *
 * Plot needs a DOM to build nodes in. A FRESH jsdom document per call, not a module-level
 * one: Plot appends to the document it is given, so a shared document accumulates every
 * chart the process has ever rendered. Cheap enough -- this runs once per chart per request
 * on an always-on box, not in a hot loop.
 *
 * Returns markup, not a node, so callers stay free of DOM types and the value can cross
 * into `dangerouslySetInnerHTML` directly. */
export function renderPlotToSvg(config: Plot.PlotOptions): string {
  const { document } = new JSDOM().window;
  const node = Plot.plot({ ...config, document });
  return node.outerHTML;
}
