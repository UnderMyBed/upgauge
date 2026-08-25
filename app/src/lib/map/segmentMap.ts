/**
 * The point-to-point map contract, shared by every consumer in epic #5.
 *
 * WHY THIS FILE EXISTS AHEAD OF ITS IMPLEMENTATION: `renderNetworkMap` is hub-and-spoke --
 * `ArcDatum` carries a single endpoint because the near end is always `origin`. All three
 * remaining maps (#107 carrier network, #108 aircraft network, #110 diff) are point-to-point,
 * and three separate tasks produce values of this shape before the renderer that consumes them
 * exists. Declaring the types once, up front, is what lets those tasks be written in parallel
 * against one seam instead of three guesses at it.
 *
 * #104 adds `renderSegmentMap` and `reachedPanelsFor` to this file and reimplements
 * `renderNetworkMap` on top of them. `renderNetworkMap` and `NetworkMapInput` KEEP their
 * current signatures, which is what makes `/airport`'s byte-identical guard possible.
 */

/** One end of a segment. `code` is the display code; coordinates come from
 *  `map_airport_coords.sql`, whose `lat`/`lon` are NOT NULL for all fact-present airports.
 *
 *  Six fact-present airports carry a POSITIVE longitude (GUM, UAM, ROP, TIQ, SPN, and Alaska's
 *  SYA at +174.11). Every consumer must `normalizeLon` before `regionOf` -- `regionOf` does not
 *  do it itself (albers.ts:48-50, 71-77). */
export interface GeoNode {
  code: string;
  lat: number;
  lon: number;
}

/** One undirected route pair, carrying BOTH endpoints. This is the whole of the difference
 *  from `ArcDatum`, and the reason the renderer needs generalizing.
 *
 *  `loadFactor` is null when it cannot be computed, and null is NOT zero -- `arcs.ts` draws a
 *  null-load-factor arc solid rather than dashed. Compute it as
 *  `SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)`, never `AVG(load_factor)`. */
export interface SegmentDatum {
  from: GeoNode;
  to: GeoNode;
  seats: number;
  departures: number;
  loadFactor: number | null;
}

export interface SegmentMapInput {
  segments: SegmentDatum[];
  /** Human-readable window, e.g. "2025-06 → 2026-05". Rendered on the map face. */
  window: string;
  /** How many routes exist BEFORE the cap -- the TRUE count. Returning the capped count here
   *  makes the disclosure read "400 of 400" and is the mutant #105 exists to kill. The renderer
   *  cannot derive this: the query that produced these segments carried a LIMIT, so the true
   *  total is only knowable upstream (`db.ts:251-254`). `NetworkMapInput` has no equivalent
   *  field, which is why `AIRPORT_NETWORK_LIMIT` can truncate silently today.
   *
   *  THE DRAWN COUNT IS NOT AN INPUT. It is `lines.length` -- what the renderer actually drew
   *  after filtering self-segments. An earlier revision took it from the caller, and the two
   *  numbers could then contradict each other inside ONE `aria-label`: "1 route drawn as
   *  great-circle arcs ... 2 of 10 routes drawn." That is the compound-claim failure CLAUDE.md
   *  records for `/watch/new-routes`, where each clause has to be re-derived rather than
   *  triaged by how true it sounds. Deriving it closes the gap by construction instead of by
   *  contract, and `totalRoutes` still comes from the caller, so #105's capped-count mutant
   *  stays killable. */
  totalRoutes: number;
  /** Routes the producer could not draw because every filing behind them was quarantined --
   *  excluded from `totalRoutes` and from the drawn count alike, so without this field they vanish
   *  from the map entirely: not an arc, not a row in any count, no trace that anything was
   *  there. Measured (#105): 34 such groups over the trailing 12, and every one of them
   *  PERFORMED DEPARTURES -- quarantined `zero_seats`, a passenger aircraft that flew and filed
   *  zero seats. Two views have no map at all for this reason.
   *
   *  CLAUDE.md: quarantined rows are "excluded from aggregates but surfaced in the UI with
   *  count + reason. Showing the dirt is a trust feature."
   *
   *  REQUIRED, not optional. A producer written against an optional field compiles, renders,
   *  and silently omits the disclosure -- which is the exact failure the field exists to
   *  prevent. A compile error in #105/#109 is loud; a missing sentence is not. The hub path
   *  never sees this interface, so requiring it costs `renderNetworkMap` nothing. */
  quarantinedRoutes: number;
  /** Optional caption under the window line -- the diff map's per-panel label. */
  title?: string;
  /** Seats from rows whose two endpoints are the SAME airport. Such a row can never be an arc
   *  -- its great circle has zero angular length -- but its seats must still reach the reader,
   *  or the map's own stated total falls out of step with the stat strip above it on the page.
   *
   *  REQUIRED, for the reason `NetworkMapInput` makes it required: a producer that leaves it
   *  off an optional field compiles and silently drops the disclosure, which is precisely what
   *  the field exists to prevent. Pass `0` to say "none", explicitly.
   *
   *  A same-airport pair is NOT counted in `totalRoutes`, and the renderer's own drawn count
   *  excludes it by construction (`drawableSegments`) -- it is not one of the routes. That is why this map's note cannot
   *  borrow the hub map's "included in this total" wording: there is no total on this map face
   *  that carries these seats, and stating them here is the only place they surface at all.
   *
   *  Measured for the point-to-point maps (#105): 598,829 same-airport seats across 759
   *  carrier x aircraft-type groups over the trailing 12. Dropping them silently in the
   *  generalization would have lost an honesty property the hub map already had. */
  sameAirportSeats: number;
  basemapPaths?: string;
}

/** ONE shared cap across all three point-to-point maps, never per-map.
 *
 *  It lives in this file rather than in any one map's module because it is a property of the
 *  ENGINE's legibility budget, not of any single query: past ~400 arcs on a 960x500 canvas the
 *  picture is ink rather than structure, and a cap that differed per map would make two maps of
 *  the same network disagree about what "the whole network" is. `carrierTypeNetwork.ts` (#105)
 *  re-exports this rather than declaring its own. */
export const NETWORK_ARC_CAP = 400;
