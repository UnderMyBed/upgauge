/**
 * Arc encoding: how one destination's seats / departures / load factor become a stroke.
 *
 * Ported from the committed design mockup, `docs/design/mockups/map-network.html` (its inline
 * `<script>`, the "arcs, thinnest first" block). `docs/design/system.md` § The map § Arc
 * encoding is the contract this file implements verbatim: seats scale WIDTH, load factor
 * controls DASH, and the 30-departure floor overrides both with a fixed, dotted, muted
 * stroke. Colour is never the sole channel for any of it (CLAUDE.md) -- every stroke drawn
 * here is one of two CSS variables, never a hue, so `app/src/app/globals.css` stays the
 * single source for the ramp (the property M4c's smoke checks already pin for the aircraft
 * mix chart's fills).
 */

/** One destination this arc runs to (or, before `networkMap.ts` filters it, the origin
 * itself, when its own code appears in the `arcs` array as a same-airport row). `loadFactor`
 * is `null` when it cannot be computed (no departures) -- never NaN, never 0, the same
 * "unknown is not the alternative to a number" rule `docs/data/invariants.md` states for
 * gauge. */
export interface ArcDatum {
  code: string;
  lat: number;
  lon: number;
  seats: number;
  departures: number;
  loadFactor: number | null;
}

/** The three fields the stroke encoding actually reads. `ArcDatum` satisfies it, and so does
 * `SegmentDatum` -- which carries two endpoints rather than one `code`/`lat`/`lon`, and so is
 * not an `ArcDatum` however identical its weights are. Narrowing the parameter is what lets
 * ONE copy of the encoding serve both maps; the encoding itself is unchanged. */
export type ArcWeight = Pick<ArcDatum, "seats" | "departures" | "loadFactor">;

/** Below this many trailing-window departures, an arc is drawn dotted, fixed-width, and in
 * the muted `--ink-3` rather than scaled by seats -- system.md's "below the 30-departure
 * floor" row. This overrides the seat-width and load-factor-dash encodings entirely: a floor
 * arc's story is "barely flown," and scaling it by seats or dashing it by load factor would
 * bury that under a second, contradictory signal. */
export const DEPARTURE_FLOOR = 30;

/** Below this load factor, an arc that is ALREADY above the departure floor is dashed rather
 * than solid. Never checked on a floor arc -- see `DEPARTURE_FLOOR`. */
export const LOAD_FACTOR_FLOOR = 0.7;

/**
 * Ascending by seats, so the caller draws thinnest first and heaviest last (system.md:
 * "Thin arcs draw first so heavy ones sit on top").
 *
 * This is an ORDERING property, not a filter -- the set of stroke widths produced is
 * identical whether or not this sort runs, so a test asserting only that set would pass under
 * a dropped sort (CLAUDE.md's standing warning: M4c's stack-order mutant survived exactly this
 * shape of assertion). Only the drawn SEQUENCE distinguishes correct from buggy, which is why
 * every draw-order test reads `stroke-width` values off the document in the order they appear,
 * not as a set.
 *
 * Tiebreak on `code` for determinism: two arcs at an identical seat count must still draw in
 * the same order on every run over the same data.
 *
 * NOT ON ANY RENDER PATH since #104. Both maps draw segments, so the ordering that executes is
 * `segmentMap.ts`'s `segmentOrder` -- which is this comparator generalized (seats, then
 * `from.code`, then `to.code`), and which reduces to exactly this one on a hub, where every
 * segment shares an origin. This is retained as `arcs.test.ts`'s subject: it is the per-arc
 * statement of the rule, and the file that owns the arc encoding is where that rule belongs.
 */
export function arcOrder(arcs: ArcDatum[]): ArcDatum[] {
  return [...arcs].sort((a, b) => a.seats - b.seats || a.code.localeCompare(b.code));
}

export interface ArcStroke {
  width: number;
  dash: string;
  opacity: number;
  stroke: string;
}

/**
 * `0.7 + 2.9·√(seats/max)` scales width by seats -- the mockup's own formula, kept verbatim.
 *
 * Below `DEPARTURE_FLOOR` this is overridden completely: fixed 1px, dotted `"1 3"`, opacity
 * 0.75, `--ink-3`. A floor arc's load factor is never consulted -- its own dash already
 * encodes "barely flown," and checking load factor on top of that would try to draw two
 * independent facts through one channel.
 *
 * Above the floor, `loadFactor < LOAD_FACTOR_FLOOR` dashes the arc (`"5 3"`, opacity 0.62,
 * `--ink`); `loadFactor === null` (no departures to divide by) is treated as "not low" rather
 * than as low or as high -- there is no evidence either way, and dashing on an absence would
 * fabricate the same kind of claim `docs/data/invariants.md` already refuses for gauge.
 *
 * `maxSeats <= 0` (no arcs, or every arc carries zero seats) falls back to a width of 0.7 --
 * the formula's own floor at seats/max = 0 -- rather than dividing by zero and propagating
 * NaN into the rendered attribute.
 */
export function strokeFor(a: ArcWeight, maxSeats: number): ArcStroke {
  if (a.departures < DEPARTURE_FLOOR) {
    return { width: 1, dash: "1 3", opacity: 0.75, stroke: "var(--ink-3)" };
  }
  const ratio = maxSeats > 0 ? a.seats / maxSeats : 0;
  const low = a.loadFactor !== null && a.loadFactor < LOAD_FACTOR_FLOOR;
  return {
    width: 0.7 + 2.9 * Math.sqrt(ratio),
    dash: low ? "5 3" : "",
    opacity: 0.62,
    stroke: "var(--ink)",
  };
}
