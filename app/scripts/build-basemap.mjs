#!/usr/bin/env node
/**
 * Generates `app/src/lib/map/basemapPaths.generated.ts` from the committed
 * `app/geo/ne_110m_us.json` -- the coastline + state-outline paths the network map's arcs
 * (M7 Task 6) are drawn over.
 *
 * INPUT (committed, not fetched here -- `make verify` must work offline and
 * reproducibly):
 *   `app/geo/ne_110m_us.json`, Natural Earth 1:110m Cultural Vectors, Admin 1 -- States,
 *   Provinces (https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-1-states-provinces/),
 *   fetched as GeoJSON from the nvkelso/natural-earth-vector mirror
 *   (https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_1_states_provinces.geojson),
 *   filtered to the 51 US features (`iso_a2 == 'US'`: 50 states + DC). Natural Earth is
 *   public domain (https://www.naturalearthdata.com/about/terms-of-use/ -- "No permission
 *   is needed to use Natural Earth. Crediting the authors is unnecessary."). Full
 *   provenance is recorded again in `app/geo/ne_110m_us.json`'s own `_source` field.
 *
 *   Natural Earth 1:110m has no separate Admin-1 entry for Guam/Saipan/Tinian/Rota/American
 *   Samoa/Midway (the `pac` panel) or Puerto Rico/the USVI (`car`) -- at this scale those
 *   territories are not resolvable as distinct polygons, so this generator emits no
 *   coastline for either panel. That's a real, documented limitation, not a bug: any point
 *   landing in `pac`/`car` still projects correctly via `albers.ts`'s `project()`, which
 *   falls back to the `us` panel's fit when its own panel has no fit -- the arc just has no
 *   coastline drawn under it.
 *
 * WHY COMMITTED, NOT FETCHED AT BUILD TIME: `make verify` builds twice and diffs every
 * artifact byte-for-byte; a build step that reaches the network is not reproducible (no
 * guarantee the remote file is unchanged, reachable, or even the same bytes twice in one
 * run). Committing the input mirrors this project's Parquet-writer discipline
 * (`docs/data/invariants.md`): fetch once, simplify, commit, and every subsequent build
 * reads the same committed bytes.
 *
 * PROJECTION: this script imports the app's own `albers.ts` (`project`, `fitPanels`,
 * `normalizeLon`, `regionOf`) rather than reimplementing the projection -- a basemap
 * projected by separate math from the arcs would be subtly, invisibly misaligned. Node's
 * built-in TypeScript type-stripping (unflagged since Node 23.6) imports the `.ts` file
 * directly; `albers.ts` uses only erasable syntax (types/interfaces, no enums or parameter
 * properties), so no transpile step is needed.
 *
 * FIXED REFERENCE POINTS, NOT THE SUBJECT'S ARCS: the brief's own words -- "the basemap is
 * fitted to fixed panel rectangles, not to the subject's arcs, otherwise the coastline
 * would move from page to page." `fitPanels` (Task 4) already takes any `GeoPoint[]`; the
 * fixed-ness is a property of WHAT this generator passes it, not a new albers.ts parameter.
 * This script fits every panel to every raw coordinate in the committed geography
 * (`BASEMAP_FIT_POINTS`, exported from the generated module) -- the full extent of each
 * state's own landmass -- and bakes the resulting screen coordinates directly into the
 * generated file. `basemapPathsFor` therefore takes no points at all: there is no
 * per-call fit, so the coastline provably cannot move between pages.
 *
 * A per-page network map (`app/src/lib/map/networkMap.ts`, M7 Task 8) must reuse `fitPanels(
 * BASEMAP_FIT_POINTS)` VERBATIM -- identical input, identical output -- for any panel this
 * generator produced a fit for (us/ak/hi today), and may fall back to a fit derived from its
 * own subject points ONLY for a panel with zero committed reference points (pac/car).
 *
 * AN EARLIER DRAFT OF THIS COMMENT RECOMMENDED THE WRONG FIX, and it is worth recording why,
 * since the wrong version shipped (unfixed) for one task: it said a per-page map "must call
 * `fitPanels([...BASEMAP_FIT_POINTS, ...subjectPoints])`, never `fitPanels(subjectPoints)`
 * alone." That union is NOT equivalent to reusing the fit verbatim. `fitPanels` derives its
 * scale `k` and offsets from the MIN/MAX EXTENT of whatever points it is given; this
 * generator already baked the coastline's pixels in at `fitPanels(BASEMAP_FIT_POINTS)`'s own
 * extent, and unioning in a subject point that falls OUTSIDE that extent -- a coastal airport
 * seaward of a simplified coastline, the ordinary case, since simplification pulls the line
 * inward rather than the exception -- changes the extent, which changes `k` for every point,
 * arcs and the already-baked coastline alike. A different `k` from the one that projected
 * the coastline is exactly the misalignment this design exists to prevent, so the union
 * recommendation silently reopens the bug it claims to close. `basemap.test.ts`'s "does not
 * move when a subject's own points are unioned in" test only ever exercised an IN-BOUNDS
 * point (SEA), which cannot distinguish the correct rule from the wrong one -- see that
 * file's own second test for a point that does.
 *
 * DETERMINISM / BYTE-STABILITY (the requirement, not a nicety -- mirrors this project's
 * `threads = 1` Parquet-writer discipline): no `Date`, no `Math.random`, no iteration over
 * a `Set`/`Map` for output order. Features are explicitly sorted by their own `postal`
 * code before any other processing; rings and points are walked in the array order the
 * (already-sorted, committed) input GeoJSON stores them in; RDP simplification is a pure
 * function of its input; every coordinate is rounded with `.toFixed(1)` (screen pixels --
 * 1 decimal is far finer than this canvas needs, and avoids the "-0"/exponential-notation
 * traps a bare `Math.round(x * 10) / 10` has). `make basemap` run twice must produce a
 * byte-identical `basemapPaths.generated.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fitPanels, normalizeLon, project, regionOf } from "../src/lib/map/albers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GEO_PATH = path.join(REPO_ROOT, "app", "geo", "ne_110m_us.json");
const OUT_PATH = path.join(REPO_ROOT, "app", "src", "lib", "map", "basemapPaths.generated.ts");

// Ramer-Douglas-Peucker simplification, applied to each ring in RAW (lat, lon) degrees,
// before projection. `epsilonDeg` is in degrees (~0.05 deg is ~5.5km at the equator);
// small enough to keep every state's shape recognizable at a ~900x400px canvas, and it
// materially shrinks Alaska's and Maine's especially convoluted coastlines. Endpoints of
// every ring are always kept; recursion never reorders points, so output order is exactly
// input order minus the dropped points -- deterministic by construction.
function rdp(points, epsilonDeg) {
  if (points.length < 3) return points;

  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const norm = Math.hypot(dx, dy) || 1;

  let maxDist = -1;
  let maxIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const dist = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm;
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist <= epsilonDeg) {
    return [points[0], points[points.length - 1]];
  }

  const left = rdp(points.slice(0, maxIdx + 1), epsilonDeg);
  const right = rdp(points.slice(maxIdx), epsilonDeg);
  return [...left.slice(0, -1), ...right];
}

const RDP_EPSILON_DEG = 0.05;

// GeoJSON rings are CLOSED -- the first coordinate is repeated as the last, so the plain
// `rdp` above (which measures perpendicular distance from the chord between a ring's own
// first and last point) sees a zero-length chord for every ring: `dx = dy = 0`, so the
// numerator `dy*px - dx*py + x2*y1 - y2*x1` is 0 for every point, `maxDist` never exceeds
// the epsilon, and the whole ring collapses to its one duplicated point. (Caught by
// running the generator once and reading its own output -- every state came out as
// `M x,y L x,y Z`, a single point, not a mutant-discipline test; recorded in the Task 7
// report as a finding, not merely fixed silently.)
//
// Fix: split the ring at an arbitrary interior point (its own midpoint by index) into two
// OPEN polylines that share their two endpoints, run ordinary `rdp` on each independently,
// then splice them back together. Both endpoints are real ring vertices, never coincident
// with each other, so neither half's chord is degenerate.
function rdpRing(ringWithClosingDuplicate, epsilonDeg) {
  const pts = ringWithClosingDuplicate.slice(0, -1); // drop the repeated closing point
  const n = pts.length;
  if (n < 3) return ringWithClosingDuplicate;

  const k = Math.floor(n / 2);
  const half1 = rdp(pts.slice(0, k + 1), epsilonDeg); // pts[0] .. pts[k]
  const half2 = rdp([...pts.slice(k), pts[0]], epsilonDeg); // pts[k] .. pts[n-1] .. pts[0]
  // half1 ends at pts[k]; half2 starts at pts[k] -- drop half1's copy, not half2's, so the
  // merged ring still ends on pts[0] (re-closing it).
  return [...half1.slice(0, -1), ...half2];
}

function ringsOf(geometry) {
  if (geometry.type === "Polygon") {
    return geometry.coordinates;
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flat();
  }
  throw new Error(`unsupported geometry type: ${geometry.type}`);
}

function fmt(n) {
  const fixed = n.toFixed(1);
  // Avoid a signed zero ("-0.0") -- harmless on screen but a source of non-determinism if
  // a future refactor ever hashes or diffs coordinate strings semantically.
  return fixed === "-0.0" ? "0.0" : fixed;
}

function main() {
  const raw = JSON.parse(readFileSync(GEO_PATH, "utf8"));
  const features = [...raw.features].sort((a, b) =>
    a.properties.postal.localeCompare(b.properties.postal),
  );

  // The fixed reference set: every raw (lat, lon) coordinate in the committed geography,
  // in the same deterministic (sorted-feature, ring-order, point-order) walk the paths
  // themselves are built from. This is what makes the fit page-independent -- see the
  // header comment above.
  const referencePoints = [];
  for (const feature of features) {
    for (const ring of ringsOf(feature.geometry)) {
      for (const [lon, lat] of ring) {
        referencePoints.push({ lat, lon });
      }
    }
  }

  const fits = fitPanels(referencePoints);

  /** @type {Record<string, string[]>} */
  const pathsByPanel = { us: [], ak: [], hi: [], pac: [], car: [] };

  for (const feature of features) {
    const rings = ringsOf(feature.geometry);
    // Classify the whole feature by its first ring's first point -- every state's
    // geometry sits entirely inside one `regionOf` region (no state straddles a panel
    // boundary), so a single representative point is exact, not an approximation.
    const [lon0, lat0] = rings[0][0];
    const panel = regionOf(lat0, normalizeLon(lon0));
    if (!fits.has(panel)) continue; // no fit for this panel; shouldn't happen if it has points

    const dParts = [];
    for (const ring of rings) {
      const simplified = rdpRing(ring, RDP_EPSILON_DEG);
      const screenPts = simplified.map(([lon, lat]) => project(lat, lon, fits));
      const [first, ...rest] = screenPts;
      const M = `M${fmt(first[0])},${fmt(first[1])}`;
      const L = rest.map(([x, y]) => `L${fmt(x)},${fmt(y)}`).join("");
      dParts.push(`${M}${L}Z`);
    }
    const d = dParts.join(" ");
    pathsByPanel[panel].push(
      `<path data-panel="${panel}" data-name="${feature.properties.postal}" d="${d}" />`,
    );
  }

  const panelOrder = ["us", "ak", "hi", "pac", "car"];
  const pathsLiteral = panelOrder
    .map((panel) => `  ${panel}: ${JSON.stringify(pathsByPanel[panel].join(""))},`)
    .join("\n");

  const pointsLiteral = referencePoints
    .map((p) => `  { lat: ${fmt2(p.lat)}, lon: ${fmt2(p.lon)} },`)
    .join("\n");

  // Reference points are the RAW committed coordinates (not screen coords), rounded to 3
  // decimals -- matching app/geo/ne_110m_us.json's own committed precision (~110m). This
  // keeps the generated file's reference-point section a faithful, re-derivable copy of
  // the input rather than a second, independently-rounded copy.
  function fmt2(n) {
    const fixed = n.toFixed(3);
    return fixed === "-0.000" ? "0.000" : fixed;
  }

  const out = `/**
 * GENERATED by app/scripts/build-basemap.mjs (\`make basemap\`) from app/geo/ne_110m_us.json.
 * DO NOT HAND-EDIT -- your changes will be overwritten. See build-basemap.mjs's header for
 * the source, license, and why this is committed rather than fetched at build time.
 */
import type { Panel, GeoPoint } from "./albers";

export const BASEMAP_PATHS: Record<Panel, string> = {
${pathsLiteral}
};

/**
 * The fixed reference points every panel's coastline was fit to (raw lat/lon, 3 decimals,
 * matching app/geo/ne_110m_us.json's own precision). A per-page network map
 * (app/src/lib/map/networkMap.ts, M7 Task 8) must reuse \`fitPanels(BASEMAP_FIT_POINTS)\`
 * VERBATIM for any panel it has an entry for (us/ak/hi today) rather than re-deriving one
 * from its own subject points -- and must NOT union subject points into this array before
 * fitting (\`fitPanels([...BASEMAP_FIT_POINTS, ...subjectPoints])\`, an earlier draft's wrong
 * recommendation): a subject point outside this array's own extent changes fitPanels's
 * scale for every point, arcs and this already-baked coastline alike. See
 * build-basemap.mjs's header for the full reasoning. A panel with no entry here (pac/car)
 * has no coastline to align to, so a subject-derived fit is the legitimate fallback.
 */
export const BASEMAP_FIT_POINTS: GeoPoint[] = [
${pointsLiteral}
];
`;

  writeFileSync(OUT_PATH, out);
  console.log(`wrote ${OUT_PATH} (${Buffer.byteLength(out, "utf8")} bytes)`);
}

main();
