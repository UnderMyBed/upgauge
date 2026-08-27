/**
 * Composite Albers USA projection -- seven panels, zero dependencies.
 *
 * Ported from the committed design mockup, `docs/design/mockups/map-network.html` (its
 * inline `<script>`, `albersRaw`/`regionOf`/`PARAMS`/`RECTS`/the per-panel fit loop/`proj`).
 * The mockup shipped three panels (`us`/`ak`/`hi`) and two region tests written in
 * lower-48-centric terms that silently misfile six real, fact-present airports. This module
 * carries the mockup's math across unchanged and adds four panels (`pac`, `nwhi`, `car`,
 * `sam`) plus longitude normalization to fix that. Full measurement and reasoning:
 * `docs/data/invariants.md` § Airport coordinates, and the six that are east of the
 * antimeridian. Contract: `docs/design/system.md` § The map § Projection.
 */

export type Panel = "us" | "ak" | "hi" | "pac" | "nwhi" | "car" | "sam";

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
 * Ordered most-specific first (`sam`, `pac`, `nwhi`, `car`, `hi`, `ak`), `us` last as the
 * unconditional fallback -- the mockup's two-panel-plus-fallback shape is preserved, but four
 * more specific panels are inserted ahead of it so they never fall through:
 *
 * - `sam`, `pac` and `nwhi` are the three-way split of what was ONE `lat < 30 && lon < -160`
 *   test. Their union is exactly that predicate again, so nothing can move into or out of
 *   `us`/`ak`/`hi`/`car` because of the split -- a property worth stating because it is what
 *   makes the split provably fit-preserving for the other four panels, not merely observed to
 *   be. They are three panels rather than one because a SINGLE Albers fit cannot carry them:
 *   the Marianas, American Samoa and Midway span roughly 5,000 km, and one panel scaled to
 *   that extent puts Saipan and Tinian -- 18 km apart, and an undirected route carrying 78,420
 *   seats over the trailing 12 -- 2.73px apart even at the full width of a 960x500 canvas. The
 *   seat figure is `fct_route_month`'s, because the map draws one arc per UNDIRECTED route;
 *   `fct_segment_month`'s directed halves are 39,908 and 38,512, and quoting either as a route
 *   total understates the arc by half. Measured; the
 *   arithmetic is in `PANEL_RECTS` below.
 *   - `sam` is American Samoa (PPG, lat -14.3, lon -170.7), the one territory in this dataset
 *     south of the equator. Testing it before `hi` is what keeps the mockup's
 *     `lon < -150 && lat < 30` Hawai'i test from also catching it, which used to stretch a
 *     "Hawai'i" panel across 42 degrees of latitude when Hawai'i itself spans 2.3.
 *   - `pac` is the Marianas -- Guam/Rota/Tinian/Saipan (normalized lon ~ -214 to -215, lat
 *     13.5-15.1) plus the uninhabited northern islands. `lon < -200` is NOT "everything past
 *     the antimeridian", which is what an earlier draft of this line claimed: normalized, it
 *     is raw longitude east of 160E, not east of 180E. The band between them (raw 160E-180E,
 *     lat < 30) falls through to `nwhi` and would render inside a frame labelled MIDWAY.
 *     Nothing is there today -- all 1,047 fact-present airports were classified to check --
 *     but `dim_airport` already carries AWK (Wake), KWA and MAJ, so the boundary is left where
 *     it is DELIBERATELY rather than tightened to -180 on hypothetical data: at -180 those
 *     three would instead take `pac`'s baked Marianas fit and project off the canvas entirely,
 *     which is a worse failure than a wrong label. Either way the prose now matches the code.
 *   - More generally, `regionOf`'s predicates are far wider than the extents the baked fits
 *     cover, and that gap changed character when `pac` and `sam` gained geometry: before, a
 *     far-Pacific newcomer got a subject-derived fit and landed inside its frame; now it takes
 *     a fit scaled to the Marianas or to Tutuila and lands wherever that puts it. A
 *     counterfactual Chuuk (TKK, 7.46 / 151.84) would draw at (315.7, 465.4) -- a
 *     plausible-looking dot in the Gulf of
 *     Mexico rather than an obvious absence. Not reachable on today's data; worth knowing
 *     before adding a Pacific airport.
 *   - `nwhi` is the Northwestern Hawaiian Islands: Midway (MDY, lat 28.2, lon -177.4) and Kure.
 *     It has NO committed coastline and deliberately keeps none -- Natural Earth carries Midway
 *     only inside a feature that also spans the Caribbean (`app/geo/ne_50m_pac.json`'s own
 *     `_source` records why that cannot be cut apart here) -- so `fitPanels(BASEMAP_FIT_POINTS)`
 *     produces no fit for it and a page reaching it takes the subject-derived fallback in
 *     `segmentMap.ts`'s `renderMapCore`, which is the ONLY panel that branch still serves.
 *     Folding Midway into `pac` instead is not a simplification, it is a regression: `pac`'s
 *     baked fit is scaled to the Marianas' own extent, so Midway projects to (1367.6, -429.7)
 *     -- off the canvas entirely -- and `/airport/MDY?y=2021` loses its own subject. (That
 *     coordinate, and the American Samoa one in `PANEL_RECTS`, are counterfactuals under THIS
 *     commit's `pac` fit specifically: `ox`/`oy` move with the rect, so a figure quoted from
 *     an earlier revision of that rect is a true statement about a layout that no longer
 *     exists. Re-derive, never copy.) The gap is stated on the page itself
 *     (`NetworkMap.tsx`'s caption), never silently drawn wrong.
 * - `car` catches Puerto Rico and the USVI (lat 17.70-18.49, lon -67.15 to -64.71), which sit
 *   east of every conterminous airport (PQI, Maine, -68.05) and 6.86 degrees south of the
 *   southernmost (EYW, Key West, 24.56) -- no single conterminous rectangle can hold both
 *   without also swallowing the Caribbean, so it needs its own panel and its own tested-early
 *   branch rather than falling into `us`.
 */
export function regionOf(lat: number, lon: number): Panel {
  if (lat < 0 && lon < -160) return "sam";
  if (lat < 30 && lon < -200) return "pac";
  if (lat < 30 && lon < -160) return "nwhi";
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
  // The Marianas: Guam/Saipan/Tinian/Rota cluster around normalized lon -214.3 to -215.2, lat
  // 13.5-15.1, and the committed coastline reaches lat 18.81 for the northern islands. These
  // parallels are UNCHANGED from when this panel also held American Samoa and Midway, and that
  // is deliberate: retuning them to bracket the Marianas alone (p1 14.2, p2 17.9) moves the
  // ratio that actually matters here -- Tinian-Saipan over Guam-Saipan -- from 0.08628 to
  // 0.08637, a 0.1% difference that no rect can express. A gratuitous reprojection of geometry
  // that is about to be committed is a cost with no benefit.
  pac: { p1: 10, p2: 18, lam0: -214.7, phi0: 14 },
  // Midway (-177.4, 28.2) and Kure. No committed geometry, so this is only ever used with a
  // subject-derived fit (`networkMap.ts`); it still needs real parallels, because `project`
  // reads PANEL_PARAMS for any panel that HAS a fit, however that fit was derived.
  nwhi: { p1: 27, p2: 29, lam0: -177.4, phi0: 28.2 },
  // Puerto Rico + USVI: lat 17.70-18.49, lon -67.15 to -64.71.
  car: { p1: 17, p2: 19, lam0: -65.9, phi0: 18 },
  // American Samoa: Tutuila spans lat -14.36 to -14.26, lon -170.82 to -170.57. Its own
  // parallels, not `pac`'s, and not because of distortion over a 30 km island: under `pac`'s
  // lam0 of -214.7 Samoa sits 44 degrees off the central meridian, and `albersRaw`'s
  // `th = n * (lon - lam0)` term then rotates it by n * 44 = 10.6 degrees (n = 0.24133 for
  // `pac`'s parallels; 10.62 at the panel's nominal longitude, 10.65 worst across Tutuila's
  // own span). Under `sam`'s own lam0 the same quantity is 0.03 degrees. A sheared island is a
  // drawing of somewhere else. Southern standard parallels give a negative `n`; the resulting
  // orientation was checked rather than assumed (north maps to smaller screen y, east to
  // larger x -- `albers.test.ts`'s "puts a northern point above a southern one" pair is
  // repeated against THESE parameters, not just the `us` ones, because a negative `n` is
  // exactly where that could differ).
  sam: { p1: -14.4, p2: -14.2, lam0: -170.7, phi0: -14.3 },
};

// Canvas 960x500 (mockup's W/H), 16px outer pad. us/ak/hi rects are the mockup's own,
// unchanged. `nwhi` (368-408), `car` (424-720) and `sam` (736-917) sit in the bottom inset
// tray with ak (36-176) and hi (192-292), left to right, all five ending on the tray's shared
// 468 baseline. Frames are drawn at rect +/- 6px (`networkMap.ts`), so the mockup's own 16px
// rect-to-rect gutter leaves 4px between neighbouring frames: ak->hi, nwhi->car and car->sam
// all measure it. hi->nwhi does NOT -- that gap is 76px, because it is where `pac` used to sit
// before it left the tray, and nothing was moved up to close it. `pac` is the one inset NOT in
// the tray; see below for why.
//
// `car`'s width was widened by M7 Task 7b once real geometry existed to check the original
// 100x76 square against (Task 4/7's own open item -- there was nothing to measure it
// against before). Puerto Rico + the USVI's combined raw-Albers extent under `PANEL_PARAMS
// .car` is dx=0.0557, dy=0.0143 (measured directly against the committed
// `ne_50m_car.json`), an aspect ratio of ~3.89:1 -- far wider than tall, since the two
// territories span ~3.4 degrees of longitude but only ~0.8 degrees of latitude. The old
// 100x76 rect (aspect 1.32:1) forced `fitPanels`'s `k = min(w/dx, h/dy)` to bind on WIDTH,
// leaving the coastline only ~26px tall inside a 76px-tall frame -- a thin horizontal sliver
// floating in the middle of a mostly-empty labelled box, not a rendering bug but a
// misleading rectangle. Widened to 296px (76 * 3.89, rounded) so both dimensions bind
// together and the coastline fills its frame the same way every other panel's does; height
// (392-468, matching hi) is unchanged so the bottom inset row keeps one shared baseline.
//
// `pac` got the same treatment, for the OPPOSITE mismatch, once its own geometry existed
// (`ne_50m_pac.json`). Guam + the Northern Marianas' raw-Albers extent under `PANEL_PARAMS
// .pac` is dx=0.019902, dy=0.096983 -- an aspect of 0.2052:1, five times TALLER than wide,
// because the chain is a ~617 km north-south arc only ~129 km across. The old 100x76
// placeholder (aspect 1.32:1) bound on height and left the islands a 15.6px-wide sliver.
//
// AND THEN IT HAD TO MOVE, which is the part worth reading. A 44x216 rect grown upward from
// the tray (308,252)-(352,468) is a correct SIZE in the wrong PLACE: its frame lands inside
// the conterminous panel, whose drawn coastline occupies x[153.3, 806.7] y[18.0, 424.0], and
// `globals.css`'s `.map svg path[data-panel]` fills every basemap path with OPAQUE
// `--panel-2`. Draw order in `renderNetworkMap` is frames, then basemap, then arcs -- so the
// lower 48 paints straight over the frame border and the label. Measured on a 0.1px grid:
// 3,163 px^2 of drawn landmass inside that rect -- 33.3% of it -- and ALL EIGHT glyph
// positions of "MARIANAS" (drawn at rect x0-4, y0+6) inside drawn Arizona or New Mexico. Two
// of the panel's OWN islands (MP rings 0 and 3, 3.91 and 1.20 px^2) sat on top of that land in
// the identical fill. An inset that is not legible is exactly what `networkMap.ts`'s INSETS
// comment calls a lie. On a served /airport/SFO it also swallowed ABQ and ELP and was crossed
// by 27 of 147 arcs that had no business in the Pacific.
//
// `fitPanels`'s `k` depends only on a rect's WIDTH and HEIGHT, never its position, so
// relocating preserved every measured figure verbatim -- TIQ-SPN still 6.232px, GUM-ROP still
// 31.447px. It went to the top-left margin, which the tray never uses and no lower-48 coastline
// reaches (`us` land spans x[153.3, 806.7]): frame (34,24)-(90,252), 0 px^2 of drawn land, all
// eight label glyphs clear, and on a served /airport/SFO exactly one arc crosses it -- SFO-GUM,
// which terminates inside it and must. `basemap.test.ts` asserts the land property against the
// real drawn subpaths, per panel, because the earlier frame-vs-frame check iterated the six
// INSET panels and `us` -- the unframed one that paints the land -- was in neither list.
//
// Height, not width, is what this rect is really buying, and the number is forced rather than
// chosen. `dy` is the chain's latitude span in radians, which no projection parameter can
// change, so `k` is capped at `h / 0.096978` however wide the rect gets (that is the extent
// over the ROUNDED `BASEMAP_FIT_POINTS` `fitPanels` actually reads, not the raw 4-decimal
// 0.096983 -- immaterial here, but it is the same distinction the `sam` paragraph below
// exists to correct) (to bind on width
// instead you would need `h >= 4.873w`, the same constraint again). Tinian and Saipan are
// 0.002819 raw units apart -- 18 km, and an undirected route filing 78,420 seats over the
// trailing 12 (`fct_route_month`; the directed segment halves are 39,908 and 38,512) --
// so drawing them 6px apart, one node diameter of clear air at r=2, needs k >= 2129 and
// therefore h >= 206.4px. Hence 44x216 at k=2211: Tinian-Saipan 6.23px, Guam-Rota 31.45px,
// Guam-Saipan 72.23px, and the islands fill 44.0 x 214.4px of the frame.
//
// The three-territory panel this replaces could not have satisfied that at ANY size: with
// American Samoa in the same fit the extent is dx=0.840302, dy=0.485097, so a `pac` rect
// filling the whole canvas less the 16px pad caps k at 964.7 and leaves Tinian and Saipan
// 2.73px apart. That is why `sam` is a panel and not a rect change -- see `regionOf`.
//
// `sam` is 181x76: the tray's own height, and the width its extent asks for so both dimensions
// bind -- 76 * 2.3801, rounded, exactly the derivation `car`'s 296 uses. TWO THINGS HAVE TO BE
// RIGHT HERE, and an earlier revision of this line got both wrong.
//
// Measure the extent under the PANEL'S OWN PARAMETERS. That line said 2.1419:1, which is
// American Samoa under `PANEL_PARAMS.pac` -- the sheared projection the `sam` entry above
// exists to avoid -- and sized the rect to 163px off it, whereupon WIDTH bound alone and
// Tutuila sat in a 7.5px letterbox under a comment claiming both dimensions bound.
//
// And measure it on the same points `fitPanels` actually reads, which are `BASEMAP_FIT_POINTS`
// -- rounded to 3 decimals by the generator before the fit is taken (see build-basemap.mjs's
// `round3`). Off the raw 4-decimal committed file the aspect is 2.3884 and the arithmetic says
// 182; off the rounded points it is 2.3801 and says 181. At 181 height binds at k=42272.46 and
// the extent fills 180.9 x 76.0, one tenth of a pixel of slack. At 182 the same k leaves 1.1px.
//
// Known limitation, stated rather than hidden, and now purely a SOURCE limitation: Natural
// Earth's 1:50m Tutuila is 8 vertices, and at `PAC_RDP_EPSILON_DEG` all 8 survive, so this
// frame draws 50.5px of outline per source vertex against the 4.4px `hi` and 6.0px `car`
// manage on that same denominator (drawn perimeter over source vertices -- mixing it with a
// drawn-vertex denominator is what produced an earlier "6-10px" band here). The shape is
// coarse at this scale because the source is, not because anything was thrown away: the drawn
// outline spans 180.5 x 75.6px inside an extent fitted to 180.9 x 76.0. It is sized for the
// tray anyway because the frame has to hold PPG's 2px node and its 9px label, and a
// fidelity-matched box would be about 30x13px -- smaller than the word printed on top of it.
//
// `nwhi` is 40x76 and has no geometry at all; a single-point subject fit degenerates to
// `k = min(w, h)` and centres Midway in the frame, which is exactly what it did inside `pac`
// before this split.
//
// EXPORTED (M9 #111) so a test can assert a projected airport lands inside its own panel
// against THIS table rather than a third hand-copy of it. `segmentMap.ts`'s `INSET_RECTS` is
// still a deliberate hand-copy and is still not imported from here; keep the two in sync.
export const PANEL_RECTS: Record<Panel, PanelRect> = {
  us: [26, 18, 934, 424],
  ak: [36, 322, 176, 468],
  hi: [192, 392, 292, 468],
  pac: [40, 30, 84, 246],
  nwhi: [368, 392, 408, 468],
  car: [424, 392, 720, 468],
  sam: [736, 392, 917, 468],
};

const PANEL_ORDER: Panel[] = ["us", "ak", "hi", "pac", "nwhi", "car", "sam"];

/**
 * Fits each panel's own points into its own screen rect independently (same-scale-per-panel,
 * not one global scale) and returns a `Map` that OMITS any panel with zero points -- most
 * airports never touch `pac`, `nwhi`, `car` or `sam`, and a page must not draw a labelled
 * empty inset frame for a panel nothing in its network reaches.
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
