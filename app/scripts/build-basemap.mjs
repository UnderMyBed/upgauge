#!/usr/bin/env node
/**
 * Generates `app/src/lib/map/basemapPaths.generated.ts` from the committed
 * `app/geo/ne_110m_us.json`, `app/geo/ne_50m_car.json` and `app/geo/ne_50m_pac.json` -- the
 * coastline + state-outline paths the network map's arcs (M7 Task 6) are drawn over.
 *
 * INPUT (committed, not fetched here -- `make verify` must work offline and
 * reproducibly):
 *   `app/geo/ne_110m_us.json`, Natural Earth 1:110m Cultural Vectors, Admin 1 -- States,
 *   Provinces (https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-1-states-provinces/),
 *   fetched as GeoJSON from the nvkelso/natural-earth-vector mirror
 *   (https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_1_states_provinces.geojson),
 *   filtered to the 51 US features (`iso_a2 == 'US'`: 50 states + DC). Feeds the `us`/`ak`/
 *   `hi` panels.
 *
 *   `app/geo/ne_50m_car.json` (M7 Task 7b), Natural Earth 1:50m Cultural Vectors, Admin 0 --
 *   Countries (https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/),
 *   same mirror
 *   (https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson),
 *   filtered to `SOVEREIGNT == 'United States of America'` AND `NAME in ('Puerto Rico',
 *   'U.S. Virgin Is.')` -- 2 features, feeds ONLY the `car` panel. Admin-0 countries, not
 *   Admin-1 states/provinces: PR/USVI are not an Admin-1 unit of any country in Natural
 *   Earth at any resolution (confirmed absent from both the 1:50m and 1:10m Admin-1
 *   states/provinces files). 1:110m's own Admin-0-countries file carries a lone "Puerto
 *   Rico" (9 points, no separate USVI at all) -- 1:50m is the first resolution with BOTH
 *   territories as distinct, multi-island features (PR 69 points: main island + Vieques +
 *   Culebra; USVI 19 points: St. Thomas + St. Croix + St. John) -- verified by fetching and
 *   inspecting both before choosing. Natural Earth is public domain
 *   (https://www.naturalearthdata.com/about/terms-of-use/ -- "No permission is needed to use
 *   Natural Earth. Crediting the authors is unnecessary."). Full provenance for each file is
 *   recorded again in its own `_source` field.
 *
 *   `app/geo/ne_50m_pac.json` (M9 #111), the SAME source layer, scale and mirror as
 *   `ne_50m_car.json`, filtered to `SOVEREIGNT == 'United States of America'` AND `NAME in
 *   ('Guam', 'N. Mariana Is.', 'American Samoa')` -- 3 features, feeding the `pac` and `sam`
 *   panels. AN EARLIER VERSION OF THIS HEADER SAID THAT FILE HAD NO ENTRY FOR THEM, and it
 *   was wrong for a whole milestone: Guam (12 points), N. Mariana Is. (46 points across 6
 *   rings) and American Samoa (8 points) are all in the very file `ne_50m_car.json` was cut
 *   from. The claim was never checked; it is now, and the check is the committed file.
 *
 *   MIDWAY is the one gap left, and the honest reason is SCOPE, not absence. 1:50m genuinely
 *   has no Midway. 1:10m does, but only inside a 13-ring `U.S. Minor Outlying Is.` feature
 *   whose other rings include Navassa Island in the CARIBBEAN, and `main()` below classifies a
 *   WHOLE feature by `regionOf` of its first ring's first point -- so taking that feature whole
 *   would project Navassa into the Pacific inset. A ring-level filter WOULD extract Midway, and
 *   these inputs are already hand-filtered artifacts (`ne_50m_pac.json`'s `_source` records a
 *   `NAME in (...)` predicate), so that is the same class of operation rather than a new one.
 *   What rules it out is that RING INDICES ARE NOT STABLE across a Natural Earth refresh: a
 *   committed input meaning "ring 4 of this feature" silently becomes a different island when
 *   upstream reorders, and this repo has already paid for a fixture that stopped exercising
 *   what it named. Given the header directly above this one was wrong for a milestone about
 *   what the source contains, the distinction is worth spelling out. Midway
 *   therefore has its own panel (`nwhi`) with no reference points at all, keeps `project()`'s
 *   subject-derived fallback, and the gap is disclosed on the page itself
 *   (`app/src/components/NetworkMap.tsx`'s `nwhi`-empty caption) and in
 *   `docs/design/system.md` § The map. That is a real, documented limitation, not a bug.
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
 * generator produced a fit for (us/ak/hi/pac/car/sam as of #111), and may fall back to a fit
 * derived from its own subject points ONLY for a panel with zero committed reference points
 * (`nwhi` alone -- Midway; see above).
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
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { fitPanels, normalizeLon, project, regionOf } from "../src/lib/map/albers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GEO_PATH = path.join(REPO_ROOT, "app", "geo", "ne_110m_us.json");
const CAR_GEO_PATH = path.join(REPO_ROOT, "app", "geo", "ne_50m_car.json");
const PAC_GEO_PATH = path.join(REPO_ROOT, "app", "geo", "ne_50m_pac.json");
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

/**
 * A SECOND epsilon, for `ne_50m_pac.json` only, and the reason it exists rather than the
 * shared one being lowered.
 *
 * 0.05 deg is ~5.5km, which is ~1.93px at `pac`'s k of 2211. Four of the six Northern Mariana
 * rings are islands smaller than that tolerance, so RDP did not merely thin them -- it
 * collapsed each to `M a L b L a Z`, a two-point segment with ZERO ENCLOSED AREA. A hairline
 * with no fill, where the map claims an island. Measured, unsimplified vs drawn at 0.05:
 * Agrihan 4.92 -> 0, Anatahan 4.61 -> 0, Pagan 5.88 -> 0, and ROTA 8.23 -> 0.
 *
 * Rota is the one that makes this a defect rather than a rounding note. It is ~19km across,
 * it is inhabited, `ROP` files 4,672 seats GUM-ROP and 16,270 SPN-ROP over the trailing 12,
 * it has its own `/airport/ROP` page, and it is one of the four airports the whole `pac` rect
 * redesign exists to keep 6px apart -- so the map was drawing its destination dot on top of a
 * hairline. An earlier version of this file's own comment asserted the opposite ("the reason
 * is not RDP ... a per-input epsilon would buy nothing") and named the four rings wrongly,
 * putting Farallon de Pajaros (which is not in this file at all) where Rota actually was.
 *
 * 0.01 deg is ~0.39px at that k. Measured at it: every MP ring regains real fill (Rota 7.98
 * of its unsimplified 8.23, the smallest ring 4.40), and Tutuila keeps all 8 of its source
 * vertices instead of 5. Finer buys almost nothing -- 0.005 moves Rota by 0.25px^2 and costs
 * Saipan four more points.
 *
 * PER INPUT, never global: lowering `RDP_EPSILON_DEG` would rewrite every `us`/`ak`/`hi`/`car`
 * path, and those four panels' bytes are pinned (`basemap.test.ts`). This is the same shape as
 * the decision to add a second, finer SOURCE for one panel in M7 Task 7b -- one panel's
 * geometry needed something the shared setting could not give it, so that panel got its own.
 *
 * It does NOT move any fit: `loadReferencePointsAndFits` builds `referencePoints` from the RAW
 * rings, before any simplification, so `k`/`ox`/`oy` and every projected airport are identical
 * either way. Only the drawn `d` attributes change.
 */
const PAC_RDP_EPSILON_DEG = 0.01;

/** Which epsilon each committed input's features are simplified at. Keyed by `postal`, which
 * is unique across all three files, and read with a THROW rather than a default -- a feature
 * whose input is not listed here is a wiring bug, and silently simplifying it at 0.05 is
 * exactly the kind of default-for-missing this project refuses. */
function epsilonIndex(inputs) {
  const byPostal = new Map();
  for (const { features, epsilonDeg } of inputs) {
    for (const feature of features) byPostal.set(feature.properties.postal, epsilonDeg);
  }
  return byPostal;
}

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

/** Normalizes to 3 decimals (~110m, matching `ne_110m_us.json`'s own committed precision).
 *
 * Applied to `referencePoints` BEFORE `fitPanels` runs, which is the whole point: the emitted
 * `BASEMAP_FIT_POINTS` then round-trips to the same numbers this file fit on, so a caller
 * doing `fitPanels(BASEMAP_FIT_POINTS)` reproduces the fit the coastline was baked against
 * exactly. Rounding only on the way OUT would make that claim false for `ne_50m_car.json`,
 * which is committed at 4 decimals -- the lossy-copy bug M7's final review found.
 *
 * Exported for symmetry with `loadReferencePointsAndFits` and to keep it testable, NOT
 * because any test currently imports it -- `basemap.test.ts` imports only
 * `loadReferencePointsAndFits`, and an earlier version of this comment claimed otherwise. */
export function round3(n) {
  const r = Number(n.toFixed(3));
  return r === 0 ? 0 : r; // normalize -0 to 0, same reasoning as fmt/fmt2's "-0" guards
}

/** Reads both committed geo files, merges and sorts their features exactly the way `main()`
 * does, and returns `{ features, referencePoints, fits }` -- the same three values `main()`
 * uses to build both `BASEMAP_PATHS` and `BASEMAP_FIT_POINTS`. Exported (rather than kept
 * private inside `main()`) so a test can call the REAL production code path instead of
 * re-implementing it -- the same reason `sql/` is shared between the pipeline and the app,
 * and `albers.ts` is shared between this generator and the runtime it feeds. */
export function loadReferencePointsAndFits() {
  const raw = JSON.parse(readFileSync(GEO_PATH, "utf8"));
  const rawCar = JSON.parse(readFileSync(CAR_GEO_PATH, "utf8"));
  const rawPac = JSON.parse(readFileSync(PAC_GEO_PATH, "utf8"));
  const epsilonByPostal = epsilonIndex([
    { features: raw.features, epsilonDeg: RDP_EPSILON_DEG },
    { features: rawCar.features, epsilonDeg: RDP_EPSILON_DEG },
    { features: rawPac.features, epsilonDeg: PAC_RDP_EPSILON_DEG },
  ]);
  // Three committed inputs, two resolutions (110m for the 51 US states/DC, 50m for the 2
  // Caribbean and 3 Pacific territories -- see this file's header for why the 110m file
  // carries none of the five). Concatenated BEFORE sorting so the merged array is ordered
  // purely by postal code, not by which file a feature happened to come from -- sort order
  // must not depend on array-concatenation order for the output to be deterministic.
  // "AS"/"GU"/"MP"/"PR"/"VI" interleave alphabetically among the state codes (e.g. "PR" sorts
  // between "PA" and "RI", "AS" between "AR" and "AZ"); regionOf still classifies every
  // feature into the right panel below regardless of where in this list it lands.
  const features = [...raw.features, ...rawCar.features, ...rawPac.features].sort((a, b) =>
    a.properties.postal.localeCompare(b.properties.postal),
  );

  // The fixed reference set: every raw (lat, lon) coordinate in the committed geography,
  // in the same deterministic (sorted-feature, ring-order, point-order) walk the paths
  // themselves are built from. This is what makes the fit page-independent -- see the
  // header comment above.
  //
  // ROUNDED TO 3 DECIMALS HERE, before `fits` is computed from them, not only when they are
  // later serialized into `BASEMAP_FIT_POINTS` (final whole-branch review, Important #6).
  // `ne_110m_us.json` is already committed at 3 decimals, so this is a no-op for the us/ak/hi
  // panels -- but `ne_50m_car.json` and `ne_50m_pac.json` are committed at 4 decimals, so without this
  // the fit baked into every coastline path would be derived from RAW 4-decimal car points
  // while `BASEMAP_FIT_POINTS` -- what a per-page network map actually calls
  // `fitPanels()` on at runtime -- carried only the fmt2-rounded 3-decimal copies. The two
  // fits would then differ by whatever that rounding moved the extent (measured: sub-pixel,
  // <=0.1px, for car -- not a visible defect, but an unguarded gap in the "bit-for-bit
  // identical input" invariant the whole Task 8 fit fix rests on). Rounding here instead
  // makes `referencePoints` -- and therefore `fits` -- and `BASEMAP_FIT_POINTS` the exact
  // same numbers, so `fitPanels(BASEMAP_FIT_POINTS)` at runtime is provably bit-for-bit the
  // fit used to project every coastline path below, not merely close to it. See
  // `basemap.test.ts`'s "generator's own fit matches fitPanels(BASEMAP_FIT_POINTS)" test.
  const referencePoints = [];
  for (const feature of features) {
    for (const ring of ringsOf(feature.geometry)) {
      for (const [lon, lat] of ring) {
        referencePoints.push({ lat: round3(lat), lon: round3(lon) });
      }
    }
  }

  const fits = fitPanels(referencePoints);
  return { features, referencePoints, fits, epsilonByPostal };
}

function main() {
  const { features, referencePoints, fits, epsilonByPostal } = loadReferencePointsAndFits();

  /** @type {Record<string, string[]>} */
  const pathsByPanel = { us: [], ak: [], hi: [], pac: [], nwhi: [], car: [], sam: [] };

  for (const feature of features) {
    const rings = ringsOf(feature.geometry);
    // Classify the whole feature by its first ring's first point -- every state's
    // geometry sits entirely inside one `regionOf` region (no state straddles a panel
    // boundary), so a single representative point is exact, not an approximation.
    const [lon0, lat0] = rings[0][0];
    const panel = regionOf(lat0, normalizeLon(lon0));
    if (!fits.has(panel)) continue; // no fit for this panel; shouldn't happen if it has points

    const epsilonDeg = epsilonByPostal.get(feature.properties.postal);
    if (epsilonDeg === undefined) {
      throw new Error(`no RDP epsilon registered for feature ${feature.properties.postal}`);
    }

    const dParts = [];
    for (const ring of rings) {
      const simplified = rdpRing(ring, epsilonDeg);
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

  const panelOrder = ["us", "ak", "hi", "pac", "nwhi", "car", "sam"];
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
 * GENERATED by app/scripts/build-basemap.mjs (\`make basemap\`) from THREE committed inputs:
 * app/geo/ne_110m_us.json (us/ak/hi), app/geo/ne_50m_car.json (car -- Puerto Rico + the USVI,
 * M7 Task 7b) and app/geo/ne_50m_pac.json (pac -- Guam + the Northern Marianas; sam --
 * American Samoa, M9 #111). \`nwhi\` (Midway) has no input and is empty on purpose.
 * DO NOT HAND-EDIT -- your changes will be overwritten. See build-basemap.mjs's header for
 * both sources, their licenses, and why this is committed rather than fetched at build time.
 */
import type { Panel, GeoPoint } from "./albers";

export const BASEMAP_PATHS: Record<Panel, string> = {
${pathsLiteral}
};

/**
 * The fixed reference points every panel's coastline was fit to (raw lat/lon, 3 decimals,
 * matching app/geo/ne_110m_us.json's own precision). A per-page network map
 * (app/src/lib/map/networkMap.ts, M7 Task 8) must reuse \`fitPanels(BASEMAP_FIT_POINTS)\`
 * VERBATIM for any panel it has an entry for (us/ak/hi/pac/car/sam as of #111, since
 * ne_50m_car.json's and ne_50m_pac.json's points feed this same array) rather than re-deriving
 * one from its own subject points -- and must NOT union subject points into this array before
 * fitting (\`fitPanels([...BASEMAP_FIT_POINTS, ...subjectPoints])\`, an earlier draft's wrong
 * recommendation): a subject point outside this array's own extent changes fitPanels's
 * scale for every point, arcs and this already-baked coastline alike. See
 * build-basemap.mjs's header for the full reasoning. A panel with no entry here (\`nwhi\`
 * alone -- Midway) has no coastline to align to, so a subject-derived fit is the legitimate
 * fallback.
 */
export const BASEMAP_FIT_POINTS: GeoPoint[] = [
${pointsLiteral}
];
`;

  writeFileSync(OUT_PATH, out);
  console.log(`wrote ${OUT_PATH} (${Buffer.byteLength(out, "utf8")} bytes)`);
}

// Run only when executed directly (`node build-basemap.mjs`, what `make basemap` does) --
// NOT when `loadReferencePointsAndFits` is imported by `basemap.test.ts`, which must not
// rewrite the committed generated artifact as a side effect of running the unit suite.
// (That direction is pinned: the artifact's sha256 is unchanged across a full basemap test
// run.)
//
// `pathToFileURL`, NOT `file://${process.argv[1]}`. The naive form string-compares a URL
// against a raw filesystem path, and those differ the moment the path contains anything a
// URL must percent-encode -- a single space in the checkout path is enough. Measured:
// argv[1] `/tmp/dir with space/guard.mjs` against import.meta.url
// `file:///tmp/dir%20with%20space/guard.mjs` -- the naive comparison is FALSE and `main()`
// silently never runs.
//
// That failure is worse than it looks, which is why this carries a comment. The script would
// exit 0 having written NOTHING, and `make verify`'s basemap step (`make basemap` followed by
// `git diff --exit-code --stat` on the generated artifact) would then PASS -- not because the
// artifact reproduced, but because nothing regenerated it. The reproducibility gate would
// degrade to vacuous without ever going red. Found by M7's final re-review; recorded on
// CLAUDE.md's M8 list before being fixed here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
