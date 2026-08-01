/**
 * Thin reader over the generated basemap module (`basemapPaths.generated.ts`, produced by
 * `app/scripts/build-basemap.mjs` -- see `make basemap`). No projection or simplification
 * logic lives here; that all happened once, at generation time, against a FIXED set of
 * reference points (`BASEMAP_FIT_POINTS`) rather than any one page's subject -- see the
 * generator's own header comment for why that is what keeps the coastline from moving
 * page to page.
 *
 * A per-page network map (`app/src/lib/map/networkMap.ts`) must project its own arcs with
 * `fitPanels(BASEMAP_FIT_POINTS)` VERBATIM, for any panel that fit has an entry for, rather
 * than unioning subject points into this array before fitting -- `fitPanels` scales to the
 * min/max extent of whatever it is given, and a subject point outside `BASEMAP_FIT_POINTS`'s
 * own extent (an airport seaward of a simplified coastline, the ordinary case) would change
 * that extent, and therefore the scale, for every point -- arcs AND the already-baked
 * coastline alike. An earlier draft of this file recommended exactly that union; it was
 * wrong, and M7 Task 8's own header records the confirmed defect and the fix.
 */
import type { Panel } from "./albers";
import { BASEMAP_FIT_POINTS, BASEMAP_PATHS } from "./basemapPaths.generated";

export { BASEMAP_FIT_POINTS };

/**
 * Returns the `<path>` elements for exactly the requested panels, in a fixed
 * (`us`, `ak`, `hi`, `pac`, `car`) order regardless of the order `panels` is given in --
 * pure and call-independent, since every coordinate was already projected and baked into
 * `BASEMAP_PATHS` at generation time. `pac`/`car` currently always emit "" (see the
 * generator's header for why Natural Earth 1:110m has no coastline for either).
 */
const PANEL_ORDER: Panel[] = ["us", "ak", "hi", "pac", "car"];

export function basemapPathsFor(panels: Panel[]): string {
  const requested = new Set(panels);
  return PANEL_ORDER.filter((panel) => requested.has(panel))
    .map((panel) => BASEMAP_PATHS[panel])
    .join("");
}
