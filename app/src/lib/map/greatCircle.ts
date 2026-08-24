/**
 * Great-circle interpolation on the unit sphere -- pure spherical math, no dependency on any
 * projection. Ported from the committed design mockup, `docs/design/mockups/map-network.html`
 * (its inline `<script>`, `gc`, lines 39-52 of the script). Projection is applied by the
 * *caller*, after interpolation -- this module must never import `./albers` or anything else.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

const R = Math.PI / 180;

/**
 * Interpolates `steps + 1` points along the great-circle arc from `a` to `b` via slerp on the
 * unit sphere. A great circle between two points at equal latitude bows POLEWARD of the
 * straight line between them -- that bow is the entire reason to do this instead of a lerp on
 * (lat, lon) directly.
 *
 * `om < 1e-9` guards coincident (or antipodal-adjacent) endpoints, where `sin(om) === 0` would
 * otherwise divide by zero and produce NaN for every point on the path. 359 of 1,047 airports
 * have same-airport rows upstream (excluded before this module by Task 6, but this function
 * itself must stay safe regardless of what calls it).
 */
export function greatCircle(a: GeoPoint, b: GeoPoint, steps: number): GeoPoint[] {
  const toVec = (lat: number, lon: number): [number, number, number] => [
    Math.cos(lat * R) * Math.cos(lon * R),
    Math.cos(lat * R) * Math.sin(lon * R),
    Math.sin(lat * R),
  ];
  const A = toVec(a.lat, a.lon);
  const B = toVec(b.lat, b.lon);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const om = Math.acos(dot);

  const out: GeoPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (om < 1e-9) {
      out.push({ lat: a.lat, lon: a.lon });
      continue;
    }
    const s1 = Math.sin((1 - t) * om) / Math.sin(om);
    const s2 = Math.sin(t * om) / Math.sin(om);
    const x = s1 * A[0] + s2 * B[0];
    const y = s1 * A[1] + s2 * B[1];
    const z = s1 * A[2] + s2 * B[2];
    out.push({
      lat: Math.asin(z / Math.hypot(x, y, z)) / R,
      lon: Math.atan2(y, x) / R,
    });
  }
  return out;
}

/** Steps scale with how long the arc actually is ON SCREEN, not with its angular distance: a
 * 40px hop needs a handful of points and a transcontinental arc needs dozens.
 *
 * RE-MEASURED against the real served page (M7 Task 10; the figures this comment carried
 * before that -- "192,231 fixed 48, 132,178 adaptive, 77,384 flat 12" -- were a pre-Task-8
 * design-spec projection, never re-measured once the real page existed, and were roughly 2×
 * every real number below). Measured on ORD's 267 drawn arcs (268 destinations minus the
 * excluded same-airport row) against the actual composite-Albers projection this map ships
 * with (960px wide, so a transcontinental arc projects to only ~700px): a flat 48 emits
 * 189,274 bytes of polyline; THIS (adaptive) emits 64,287, not merely "with no visible change
 * to the long arcs" but because a long arc on a 960px-wide canvas needs ~32 steps at
 * PX_PER_STEP=22, never reaching the 48 cap at all -- the savings are the many short regional
 * arcs floored at 4 steps AND the few long arcs settling around 32 rather than 48. A flat 12
 * is 77,572 -- WORSE than adaptive's 64,287, not better as the old comment claimed, because
 * most of ORD's arcs are short enough that adaptive's floor of 4 beats a flat 12 outright; it
 * would still visibly polygonize the long arcs it does not help. Cap 48 is the mockup's
 * original constant; floor 4 keeps a short arc a curve rather than a segment. */
export const MAX_STEPS = 48;
export const MIN_STEPS = 4;
const PX_PER_STEP = 22;

export function stepsFor(projectedLengthPx: number): number {
  const raw = Math.round(projectedLengthPx / PX_PER_STEP);
  return Math.max(MIN_STEPS, Math.min(MAX_STEPS, raw));
}
