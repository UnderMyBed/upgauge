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
  /** How many routes were drawn, and how many exist. `drawn < total` is what the disclosure
   *  line reports; equal values render no disclosure line.
   *
   *  `totalRoutes` is the TRUE count BEFORE the cap. Returning the capped count here makes the
   *  disclosure read "400 of 400" and is the mutant #105 exists to kill. Note that
   *  `NetworkMapInput` has no equivalent field, which is why `AIRPORT_NETWORK_LIMIT` can
   *  truncate silently today. */
  drawnRoutes: number;
  totalRoutes: number;
  /** Seats on rows whose two endpoints are the SAME airport. Such a row cannot be a segment:
   *  its great circle has zero length, so `greatCircle`'s degenerate branch would emit
   *  `steps + 1` identical points drawing an invisible mark (networkMap.ts:57-65 has the
   *  measurement). The producer therefore keeps same-airport rows out of `segments` AND out of
   *  `totalRoutes` -- but their seats must still reach the reader, or the map's stated total
   *  falls out of step with the page around it. Disclosed in the footer, never drawn, exactly
   *  as `NetworkMapInput.sameAirportSeats` already does it for the hub map.
   *
   *  Measured at (carrier, aircraft type, undirected pair) grain over the trailing 12: 759
   *  such groups carrying 598,829 seats. */
  sameAirportSeats?: number;
  /** Optional caption under the window line -- the diff map's per-panel label. */
  title?: string;
  basemapPaths?: string;
}

/** ONE cap across all three point-to-point maps -- the carrier network (#107), the aircraft
 *  network (#108) and the diff panels (#110) -- never a per-map number. It lives here, in the
 *  shared contract file, so that #109 can reference it without depending on #105's module.
 *
 *  400, not 600: measured over the trailing 12 at (carrier, aircraft type, undirected pair)
 *  grain, 36 of 215 (carrier, type) combos exceed 400 and 17 exceed 600, median 47, worst
 *  1,622. So a 400 cap leaves 179 of 215 (83.3%) views uncapped and fires the disclosure line
 *  on one view in six. (Issue #105's "198 of 215 (92%)" is `215 - 17`, the 600-cap arithmetic
 *  applied to a 400 cap.) Those figures describe the population BEFORE same-airport pairs are
 *  excluded, which is the population the cap decision was made against; the drawable
 *  population is 213 combos, worst 1,559. */
export const NETWORK_ARC_CAP = 400;
