/**
 * Composite Albers USA projection -- five panels, zero dependencies.
 *
 * Ported from the committed design mockup, `docs/design/mockups/map-network.html` (its
 * inline `<script>`, `albersRaw`/`regionOf`/`PARAMS`/`RECTS`/the per-panel fit loop/`proj`).
 * The mockup shipped three panels (`us`/`ak`/`hi`) and two region tests written in
 * lower-48-centric terms that silently misfile six real, fact-present airports. This module
 * carries the mockup's math across unchanged and adds two panels (`pac`, `car`) plus
 * longitude normalization to fix that. Full measurement and reasoning:
 * `docs/data/invariants.md` § Airport coordinates, and the six that are east of the
 * antimeridian. Contract: `docs/design/system.md` § The map § Projection.
 */

export type Panel = "us" | "ak" | "hi" | "pac" | "car";

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Albers conic parameters: standard parallels `p1`/`p2`, central meridian `lam0`, origin latitude `phi0`. */
export interface PanelParams {
  p1: number;
  p2: number;
  lam0: number;
  phi0: number;
}

export interface PanelFit {
  k: number;
  ox: number;
  oy: number;
}

type PanelRect = [number, number, number, number];

const R = Math.PI / 180;

/**
 * BTS carries six fact-present airports east of the antimeridian: GUM, UAM, ROP, TIQ, SPN
 * (all ~144-146 degrees) and Alaska's own SYA (Eareckson AS, Shemya, at +174.11 -- the
 * western Aleutians genuinely cross the antimeridian). `regionOf`'s tests are all written in
 * western-hemisphere terms, so every call site normalizes first: without this, SYA fails the
 * `lon < -129` Alaska test and falls to the conterminous panel 270 degrees from its central
 * meridian, stretching the fit and smearing the lower 48. See
 * `docs/data/invariants.md` § Airport coordinates.
 */
export function normalizeLon(lon: number): number {
  return lon > 0 ? lon - 360 : lon;
}

/**
 * Which panel a point belongs to. Callers MUST pass an already-normalized longitude
 * (`normalizeLon(lon)`), never the raw value.
 *
 * Ordered most-specific first (`pac`, `car`, `hi`, `ak`), `us` last as the unconditional
 * fallback -- the mockup's two-panel-plus-fallback shape is preserved, but two more specific
 * panels are inserted ahead of it so they never fall through:
 *
 * - `pac` catches Guam/Saipan/Tinian/Rota (normalized lon ~ -214 to -215, lat ~13-15) AND
 *   American Samoa (lat -14.3, lon -170.7) AND Midway (lat 28.2, lon -177.4) -- all far west
 *   and south of Hawai'i proper. Testing this before `hi` is what keeps the mockup's
 *   `lon < -150 && lat < 30` Hawai'i test from also catching Samoa and Midway, which used to
 *   stretch a "Hawai'i" panel across 42 degrees of latitude when Hawai'i itself spans 2.3.
 * - `car` catches Puerto Rico and the USVI (lat 17.70-18.49, lon -67.15 to -64.71), which sit
 *   east of every conterminous airport (PQI, Maine, -68.05) and 6.86 degrees south of the
 *   southernmost (EYW, Key West, 24.56) -- no single conterminous rectangle can hold both
 *   without also swallowing the Caribbean, so it needs its own panel and its own tested-early
 *   branch rather than falling into `us`.
 */
export function regionOf(lat: number, lon: number): Panel {
  if (lat < 30 && lon < -160) return "pac";
  if (lat < 25 && lon > -70) return "car";
  if (lat < 30 && lon < -150) return "hi";
  if (lat > 51 && lon < -129) return "ak";
  return "us";
}

/** Raw (unscaled, unfit) Albers equal-area conic projection for one panel's parameters. */
export function albersRaw(lat: number, lon: number, p: PanelParams): [number, number] {
  const p1 = p.p1 * R;
  const p2 = p.p2 * R;
  const lam0 = p.lam0 * R;
  const phi0 = p.phi0 * R;
  const n = (Math.sin(p1) + Math.sin(p2)) / 2;
  const C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1);
  const rho0 = Math.sqrt(C - 2 * n * Math.sin(phi0)) / n;
  const rho = Math.sqrt(C - 2 * n * Math.sin(lat * R)) / n;
  const th = n * (lon * R - lam0);
  // y negated: raw Albers grows northward, screen y grows downward
  return [rho * Math.sin(th), -(rho0 - rho * Math.cos(th))];
}

/** Standard parallels / central meridian / origin latitude, one entry per panel. */
export const PANEL_PARAMS: Record<Panel, PanelParams> = {
  us: { p1: 29.5, p2: 45.5, lam0: -96, phi0: 37.5 },
  ak: { p1: 55, p2: 65, lam0: -154, phi0: 50 },
  hi: { p1: 8, p2: 18, lam0: -157, phi0: 20 },
  // Guam/Saipan/Tinian/Rota cluster around normalized lon -214.3 to -215.2, lat 13.5-15.1;
  // American Samoa (-170.7, -14.3) and Midway (-177.4, 28.2) fall in the same panel (see
  // `regionOf`) but well outside that cluster, so the parallels bracket the dense cluster
  // rather than the panel's full, sparse extent -- the fit loop below only ever scales to
  // whatever points actually land in the panel for a given page, never the whole Pacific.
  pac: { p1: 10, p2: 18, lam0: -214.7, phi0: 14 },
  // Puerto Rico + USVI: lat 17.70-18.49, lon -67.15 to -64.71.
  car: { p1: 17, p2: 19, lam0: -65.9, phi0: 18 },
};

// Canvas 960x500 (mockup's W/H), 16px outer pad. us/ak/hi rects are the mockup's own,
// unchanged; pac/car are new, placed in the same bottom strip as hi (y 392-468), each 100px
// wide, laid out left to right after ak (36-176) and hi (192-292) with the mockup's own
// 16px gutter: pac 308-408, car 424-524 -- all comfortably inside the 960-wide canvas.
const PANEL_RECTS: Record<Panel, PanelRect> = {
  us: [26, 18, 934, 424],
  ak: [36, 322, 176, 468],
  hi: [192, 392, 292, 468],
  pac: [308, 392, 408, 468],
  car: [424, 392, 524, 468],
};

const PANEL_ORDER: Panel[] = ["us", "ak", "hi", "pac", "car"];

/**
 * Fits each panel's own points into its own screen rect independently (same-scale-per-panel,
 * not one global scale) and returns a `Map` that OMITS any panel with zero points -- most
 * airports never touch `pac` or `car`, and a page must not draw a labelled empty inset frame
 * for a panel nothing in its network reaches.
 */
export function fitPanels(points: GeoPoint[]): Map<Panel, PanelFit> {
  const withPanel = points.map((pt) => {
    const lon = normalizeLon(pt.lon);
    return { lat: pt.lat, lon, panel: regionOf(pt.lat, lon) };
  });

  const fits = new Map<Panel, PanelFit>();
  for (const panel of PANEL_ORDER) {
    const raw = withPanel
      .filter((pt) => pt.panel === panel)
      .map((pt) => albersRaw(pt.lat, pt.lon, PANEL_PARAMS[panel]));
    if (raw.length === 0) continue;

    const xs = raw.map((p) => p[0]);
    const ys = raw.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const [rx0, ry0, rx1, ry1] = PANEL_RECTS[panel];
    const dx = x1 - x0 || 1;
    const dy = y1 - y0 || 1;
    const k = Math.min((rx1 - rx0) / dx, (ry1 - ry0) / dy);
    fits.set(panel, {
      k,
      ox: rx0 + (rx1 - rx0 - (x1 - x0) * k) / 2 - x0 * k,
      oy: ry0 + (ry1 - ry0 - (y1 - y0) * k) / 2 - y0 * k,
    });
  }
  return fits;
}

/**
 * Project one (lat, lon) to screen coordinates using panel fits already computed by
 * `fitPanels`. Falls back to the `us` panel's fit and parameters when the point's own panel
 * has no fit (nothing of the current network landed in it) -- mirrors the mockup's
 * `FIT[rg]||FIT.us` fallback so a lone Alaska or Hawai'i destination on an otherwise
 * conterminous network never throws.
 */
export function project(lat: number, lon: number, fits: Map<Panel, PanelFit>): [number, number] {
  const lon2 = normalizeLon(lon);
  const panel = regionOf(lat, lon2);
  const hasOwnFit = fits.has(panel);
  const fit = hasOwnFit ? fits.get(panel) : fits.get("us");
  if (!fit) {
    // No fit at all -- fitPanels was given no points. Total function, degenerate output.
    return [0, 0];
  }
  const params = hasOwnFit ? PANEL_PARAMS[panel] : PANEL_PARAMS.us;
  const [x, y] = albersRaw(lat, lon2, params);
  return [x * fit.k + fit.ox, y * fit.k + fit.oy];
}
