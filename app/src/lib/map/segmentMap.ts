/**
 * The point-to-point map engine, and the contract shared by every consumer in epic #5.
 *
 * WHY THIS FILE EXISTS: `renderNetworkMap` was hub-and-spoke -- `ArcDatum` carries a single
 * endpoint because the near end is always `origin`. All three remaining maps (#107 carrier
 * network, #108 aircraft network, #110 diff) are point-to-point, and three separate tasks
 * produce values of this shape. Declaring the types once, up front, is what let those tasks be
 * written in parallel against one seam instead of three guesses at it.
 *
 * HOW THE TWO MAPS RELATE (#104): `renderMapCore` below owns everything geometric -- the
 * basemap fit, the inset frames, the cross-panel test, great-circle-vs-straight, the stroke
 * encoding, node marks, the footer stack, the `<svg>` envelope -- and owns no policy at all.
 * It draws exactly the `MapPlan` it is handed. `renderSegmentMap` (here) and
 * `renderNetworkMap` (`networkMap.ts`) are both thin builders over it, each supplying its own
 * node ordering, label ranking, subject marker and wording.
 *
 * That indirection is deliberate, and it is NOT what the wave-2 plan first described ("
 * `renderNetworkMap` is reimplemented on top of `renderSegmentMap`"). Calling
 * `renderSegmentMap` directly from the hub path would mean pushing hub-only fields -- an
 * origin marker, `sameAirportSeats`, caller-order node emission -- into `SegmentMapInput`,
 * which #105 and #109 are already writing against. A shared core with two builders keeps the
 * pinned contract clean and still guarantees there is exactly ONE copy of the geometry.
 *
 * `renderMapCore` and the helpers below it are exported for `networkMap.ts` and for tests, not
 * as part of the map contract wave 2 consumes: that is `renderSegmentMap`, `reachedPanelsFor`,
 * the three types, and `NETWORK_ARC_CAP`. A page never calls the core directly.
 *
 * `renderNetworkMap` and `NetworkMapInput` KEEP their current signatures, which is what makes
 * `/airport`'s byte-identical guard possible (`networkGolden.fixture.ts`).
 */

import type { GeoPoint, Panel, PanelFit } from "./albers";
import { fitPanels, normalizeLon, PANEL_RECTS, project, regionOf } from "./albers";
import { greatCircle, stepsFor } from "./greatCircle";
import { strokeFor, DEPARTURE_FLOOR } from "./arcs";
import { BASEMAP_FIT_POINTS } from "./basemap";

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
 *  from `ArcDatum`, and the reason the renderer needed generalizing.
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
  /** The quantity this segment's panel was RANKED and CUT on, when that quantity is not one of
   *  the fields above. Only the diff map's downgauged panel has one: the fall in gauge, in seats
   *  per departure, computed as a ratio of sums over each window.
   *
   *  It exists because a panel can be ordered by something it cannot draw. `arcs.ts` spends width
   *  on seats, dash on load factor and dotted-muted on the departure floor -- none of them is the
   *  fall -- so on that panel the ink is anti-correlated with the ranking (measured: r = -0.29 to
   *  -0.39 inside the drawn 400). Without this field no surface can state the ranked quantity in
   *  an `aria-label` and no consumer test can check the ordering except by inferring it from row
   *  position, which is the "looks plausible and encodes nothing" trap CLAUDE.md names.
   *
   *  OPTIONAL, and the obligation is a rule rather than something to infer from that: a producer
   *  whose panel ranks on a quantity NOT among the fields above MUST supply it. Absent means
   *  exactly "this panel ranks on a field it already carries" -- added and dropped rank on
   *  `seats` -- which is why it is not required the way `quarantinedRoutes` and `sameAirportSeats`
   *  are. Those two are always meaningful, so an absent value is always a lost disclosure;
   *  requiring this one would force an explicit `null` onto every segment of every seats-ranked
   *  map to express nothing at all.
   *
   *  Absence, never 0: 0 is a route whose ranked quantity did not move.
   *
   *  `null` AND ABSENT ARE THE SAME STATEMENT, and this sentence is the resolution of a real
   *  ambiguity rather than a restatement of the type. The paragraph above says "absent means
   *  this panel ranks on a field it already carries", but the only producer in the repo
   *  (`carrierDiff.ts`'s `toSegment`) assigns `rankedBy: row.gauge_fall` UNCONDITIONALLY, so
   *  added and dropped segments arrive with the key PRESENT and the value `null`. The type
   *  permits both spellings, so nothing goes red, and a consumer writing the natural reading of
   *  the contract -- `"rankedBy" in seg`, or `seg.rankedBy !== undefined` -- concludes that
   *  EVERY panel ranks on gauge fall and states so on all three. Two readings of one field is
   *  the drifting-duplicate failure this file keeps paying for, so it is settled here, once:
   *  `null` is how a SQL NULL spells this absence, and translating it into a missing key at the
   *  producer would be a second encoding of one fact.
   *
   *  THE ONLY CORRECT CONSUMER PREDICATE IS `typeof seg.rankedBy === "number"`. It is the only
   *  one that is true for exactly the panels that have a ranked quantity under both spellings.
   *  `DiffMap.tsx` keys its ranking disclosure on it against a producer-shaped fixture, so both
   *  wrong predicates are killable rather than merely discouraged. */
  rankedBy?: number | null;
}

export interface SegmentMapInput {
  segments: SegmentDatum[];
  /** Human-readable window, e.g. "2025-06 → 2026-05". PAINTED INTO THE SVG, which cannot wrap:
   *  keep it under ~158 characters or it is clipped at the frame edge with nothing in the
   *  markup recording that it happened (`disclosureNotes` carries the budget and its caveats).
   *  Every producer's window is ~17 characters, so this is a ceiling, not a constraint anyone
   *  is near. */
  window: string;
  /** The TRUE pre-cap count of DRAWABLE routes. Quarantined pairs and same-airport pairs are
   *  BOTH excluded from it -- each surfaces through its own field instead (`quarantinedRoutes`,
   *  `sameAirportSeats`), and counting them here would put a route in the denominator that this
   *  map can never draw, so the disclosure could never reach "N of N". A group whose every pair
   *  is quarantined has `totalRoutes: 0`, not 3 (#105 measured `F4` x `489` as exactly that).
   *
   *  Stated HERE, on the field it constrains, and not only on the neighbouring fields that
   *  mention it: this epic already produced one bug from that shape, where two documents gave
   *  `totalRoutes` opposite meanings and #105 and #109 each followed a different one.
   *
   *  Returning the CAPPED count here instead makes the disclosure read "400 of 400" and is the
   *  mutant #105 exists to kill. The renderer cannot derive this: the query that produced these
   *  segments carried a LIMIT, so the true total is only knowable upstream (`db.ts:251-254`).
   *  `NetworkMapInput` has no equivalent field, which is why `AIRPORT_NETWORK_LIMIT` can
   *  truncate silently today. That is about the CAP alone: #114 gave the hub map its own
   *  `quarantinedRoutes`, so the quarantine half of this disclosure exists on both maps -- it
   *  is the "N of M" half that the hub still cannot state.
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
   *  never sees this interface, so requiring it costs `renderNetworkMap` nothing.
   *
   *  `NetworkMapInput.quarantinedRoutes` (#114) is the SAME quantity and is OPTIONAL there,
   *  which is a concurrency concession and not a disagreement about the rule -- that field's
   *  own doc carries the trade and the live tests that stand in for the compile error. */
  quarantinedRoutes: number;
  /** Optional caption under the window line -- the diff map's per-panel label. PAINTED INTO THE
   *  SVG on its own footer row, which cannot wrap: same ~158-character ceiling as `window`, and
   *  the two are the only unbounded strings this engine paints. #109's captions ("Added",
   *  "Dropped", "Downgauged") are nowhere near it. */
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
   *  excludes it by construction (`drawableSegments`) -- it is not one of the routes. That is
   *  why this map's note cannot borrow the hub map's "included in this total" wording: there is
   *  no total on this map face that carries these seats, and stating them here is the only
   *  place they surface at all.
   *
   *  Measured for the point-to-point maps (#105): 598,829 same-airport seats across 759
   *  carrier x aircraft-type groups over the trailing 12. Dropping them silently in the
   *  generalization would have lost an honesty property the hub map already had. */
  sameAirportSeats: number;
  basemapPaths?: string;
  /** SMALL MULTIPLES ONLY (#123): the exact window to emit, replacing the one this map would
   *  compute for itself.
   *
   *  A set of maps compared by POSITION has to share a frame, and each map's own window is the
   *  panels it reaches unioned with THE INK IT ACTUALLY EMITS -- so one panel holding an airport
   *  whose label rides above the `us` band (BLI is the real one) lifts that panel alone and the
   *  set renders at three different heights under one heading. The set measures every member
   *  with `segmentMapWindow`, unions the results, and hands the union back here.
   *
   *  Nothing else should supply it: on a single map the computed window is already exactly
   *  right, and an override is only ever a widening agreed among siblings. */
  cropWindow?: CropWindow;
}

/** ONE shared cap across all three point-to-point maps, never per-map.
 *
 *  It lives in this file rather than in any one map's module because it is a property of the
 *  ENGINE's legibility budget, not of any single query: past ~400 arcs on a 960px-wide canvas the
 *  picture is ink rather than structure, and a cap that differed per map would make two maps of
 *  the same network disagree about what "the whole network" is. `carrierTypeNetwork.ts` (#105)
 *  re-exports this rather than declaring its own. */
export const NETWORK_ARC_CAP = 400;

/**
 * THE FIT THE COASTLINE WAS BAKED AGAINST -- computed once, at module load, from the same
 * fixed reference points `basemap.ts`'s generator used (`fitPanels(BASEMAP_FIT_POINTS)`,
 * bit-for-bit identical input). This is the fix for a real, confirmed defect (M7 Task 8):
 * an earlier draft called `fitPanels(points)` with ONLY the subject's own endpoints, which is
 * a DIFFERENT fit than the one `basemapPaths.generated.ts`'s coordinates were baked with --
 * every arc was scaled/offset relative to a landmass drawn at a different scale,
 * geographically wrong on every render despite passing every existing test (none of which
 * asserted on absolute screen position).
 *
 * The WRONG fix -- and it was the fix this codebase's own generator comment, header, and
 * `basemap.ts` all recommended before Task 8 -- is `fitPanels([...BASEMAP_FIT_POINTS,
 * ...subjectPoints])`. `fitPanels` derives its scale `k` and offsets from the min/max extent
 * of whatever points it is given; the coastline's pixels are already baked in at
 * `fitPanels(BASEMAP_FIT_POINTS)`'s own extent, and a subject point that falls OUTSIDE that
 * extent (a coastal airport seaward of a simplified coastline -- the ordinary case, since
 * simplification pulls the line inward, not the exception) changes the extent, which changes
 * `k` for every point, arcs and the already-baked coastline alike. A different `k` from the
 * one that projected the coastline is exactly the misalignment this exists to prevent, so the
 * union recommendation reopens the bug it claims to close.
 *
 * The correct rule: for a panel `BASEMAP_FITS` has an entry for (us/ak/hi/pac/car/sam -- every
 * panel with committed geometry, and every one of their reference points feeds this same
 * `fitPanels(BASEMAP_FIT_POINTS)` call), reuse that fit VERBATIM -- identical input, identical
 * output, so an arc and the coastline beneath it were fit exactly once. For a panel with zero
 * committed reference points (`nwhi` alone -- Natural Earth carries Midway only inside a
 * feature that also spans the Caribbean, which `build-basemap.mjs` cannot split apart; its
 * header records why), there is no coastline to align to, so a subject-derived fit is the
 * legitimate, documented fallback -- see the merge in `renderMapCore` below. An airport that
 * then lands slightly outside the simplified coastline renders slightly outside it; that is
 * geographically honest and must not be "fixed" by rescaling.
 */
const BASEMAP_FITS: Map<Panel, PanelFit> = fitPanels(BASEMAP_FIT_POINTS);

const WIDTH = 960;
/** Frames are drawn at rect +/- this, and a cropped canvas is padded by it. ONE constant for
 *  both, because the crop's whole job is to be the window the frames live in: two literals
 *  would let the canvas and the border it is drawn around disagree by a pixel each time one
 *  moved. */
const FRAME_PAD = 6;

/** The strip below the drawn map that a ONE-LINE footer sits in -- the only vertical space on
 *  the canvas that is not a panel. A map reaching the tray therefore ends exactly at `HEIGHT`
 *  and puts its footer exactly where every map has always put it; a shorter map carries this
 *  same band under ITS OWN floor instead of leaving the difference blank, which is #123's
 *  second symptom. */
const FOOTER_BAND = 26;

/** The strip a footer of `lines` lines needs. The stack is bottom-anchored and grows UPWARD, so
 *  every line after the first eats another `FOOTER_LINE_HEIGHT` out of the map above it.
 *
 *  RESERVING ONE LINE'S WORTH FOR A THREE-LINE STACK IS A DEFECT, and a measured one: a
 *  captioned map reaching the tray -- the shape EVERY `DiffMap` panel takes, since
 *  `diffPanelTitle` always sets a title -- put its upper footer line's ascent box at y=516
 *  against the `car` frame's bottom edge of 518, printing text across the CARIBBEAN border.
 *  That predates the crop, which anchored the stack to a fixed canvas floor and let it grow up
 *  into the map. It is fixed here rather than merely documented because the crop now OWNS the
 *  bottom edge: reserving the space the stack actually needs is this function's whole job.
 *
 *  `HEIGHT` stays the one-line canvas, so a multi-line map's window can exceed it. That is
 *  correct -- the viewBox is a window, not a clip -- and every gate that bounds the RECTS
 *  against 544 still holds, because no panel moved. */
function footerBand(lines: number): number {
  return FOOTER_BAND + Math.max(0, lines - 1) * FOOTER_LINE_HEIGHT;
}

/**
 * The vertical band a panel's ink can occupy, read from `PANEL_RECTS` -- the table `fitPanels`
 * fits into, never `INSET_RECTS`, which is chrome. That is what makes the band a COMPLETE
 * cover of the coastline: every basemap path was fit into its panel's rect by construction, so
 * the rect (grown by the frame pad for a framed panel) contains every drawn coastline pixel
 * without this function having to parse the injected path string.
 *
 * `us` is the unframed one -- it IS the base map, not an inset of it -- so its band is the bare
 * rect. Every other panel's band is the frame the renderer actually draws.
 */
function panelBand(panel: Panel): [number, number] {
  const [, y0, , y1] = PANEL_RECTS[panel];
  return panel === "us" ? [y0, y1] : [y0 - FRAME_PAD, y1 + FRAME_PAD];
}

/**
 * The full canvas: the deepest panel band plus the footer band. 544 today -- the bottom tray's
 * frame floor of 518, plus 26.
 *
 * DERIVED, NOT DECLARED, and it did not start that way. Written as a literal it was DEAD within
 * one change: once #123 made the emitted `viewBox` a crop computed from the panel bands and the
 * ink, nothing read `HEIGHT` at render time any more, and setting it back to the old 500 broke
 * no test at all -- a constant that looks like the canvas, is quoted as the canvas in three
 * comments, and controls nothing. Deriving it removes the class: it cannot disagree with the
 * rects, because it is a function of them.
 *
 * The independent check lives where it can still fail: `albers.test.ts` restates 544 as a
 * literal and asserts every frame fits inside it, so growing a rect moves this value and
 * reddens that pin instead of silently making the map taller.
 */
export const HEIGHT =
  Math.max(...(Object.keys(PANEL_RECTS) as Panel[]).map((p) => panelBand(p)[1])) + FOOTER_BAND;

/** Vertical step of the footer stack. The stack is bottom-anchored, so a map with one line puts
 * that line exactly where every map has always put it. */
const FOOTER_LINE_HEIGHT = 12;

/** How many airports get a text label. Labelling every node on a busy network would bury the
 * map in text; 8 is the density this canvas was reviewed and shipped at.
 *
 * The COUNT is shared between the hub and point-to-point maps; the RANKING KEY is not, and
 * that distinction is the whole of #104's label work. On a hub, each destination has exactly
 * one arc, so "top 8 arcs by seats" and "top 8 airports by seats" name the same eight things.
 * Point-to-point they do not: an airport with three mid-weight segments can outrank one with a
 * single heavier segment, and ranking by arc would label the wrong airport while leaving the
 * busier one bare. So `renderSegmentMap` ranks airports by SUMMED incident seats, and
 * `renderNetworkMap` keeps its per-arc ranking, which on its own data is the same answer. */
export const TOP_LABEL_COUNT = 8;

/**
 * Screen rects for the four labelled insets, mirroring `albers.ts`'s own (unexported)
 * `PANEL_RECTS` layout table verbatim. Not derivable from `fitPanels`'s return value, which
 * carries only each panel's data-dependent SCALE and OFFSET (`k`/`ox`/`oy`), not its fixed
 * on-canvas frame -- and Task 6 must not edit Task 4's file to export the constant. Keep the
 * two literal tables in sync if the canvas layout ever changes; this copy is chrome only
 * (drawing the frame border), never projection math, which `fitPanels`/`project` alone own.
 */
/** MERGE (#104 x #111). #104 relocated this table here from `networkMap.ts`; #111 changed three
 *  of its values and added `nwhi`/`sam`. EXPORTED because #111's sync gate in
 *  `networkMap.test.ts` asserts it deep-equals `albers.ts`'s `PANEL_RECTS` minus `us` -- a frame
 *  drawn to a different rect than the one the coastline was fit to would visibly not match the
 *  landmass inside it, and #111 edited both tables by hand, which is exactly the operation that
 *  gate exists to catch. The follow-up #111 names is to import `PANEL_RECTS` and delete this. */
export const INSET_RECTS: Record<Exclude<Panel, "us">, [number, number, number, number]> = {
  // #122 moved the five tray rects down 44px so `car`'s frame clears the `us` rect; `pac` did
  // not move. Widths and heights are untouched, so no panel was re-fit -- see `PANEL_RECTS`.
  ak: [36, 366, 176, 512],
  hi: [192, 436, 292, 512],
  // #111: reshaped AND relocated. Real Guam + Northern Marianas geometry is 0.2052:1 -- five
  // times taller than wide -- and 216px of height is what puts Tinian and Saipan 6px apart.
  // The top-left margin is the only place a rect that tall does not sit underneath the opaque
  // lower-48 landmass, where its frame and MARIANAS label were painted over. The one inset
  // outside the bottom tray.
  pac: [40, 30, 84, 246],
  // #111: Midway. No committed geometry -- Natural Earth carries it only inside a feature that
  // also spans the Caribbean -- so it keeps the subject-derived fit. The frame is still drawn,
  // or the arc reaching Midway floats in unlabelled space.
  nwhi: [368, 436, 408, 512],
  // #111: American Samoa. 181 wide, not 163: the 2.1419:1 aspect that produced 163 was measured
  // under PANEL_PARAMS.pac. Under its own parallels it is 2.3801:1 on the 3-decimal reference
  // points fitPanels actually reads.
  sam: [736, 436, 917, 512],
  // Widened by M7 Task 7b to match albers.ts's own PANEL_RECTS.car -- see that file's
  // comment for the measurement (real PR/USVI geometry is ~3.89:1 wide, not the original
  // rect's 1.32:1). Keep this literal in sync with PANEL_RECTS.car; a frame border drawn to
  // a different rect than the one the coastline was actually fit to would visibly not match
  // the landmass inside it.
  car: [424, 436, 720, 512],
};

/** Order and label text for the insets below. `us` never gets a frame -- it is the base map
 * itself, not an inset of it, matching the mockup, which only ever framed `ak`/`hi`. "An
 * inset that isn't labelled is a lie" is the mockup's own comment; system.md states it as a
 * standing rule, not a note about one page. */
const INSETS: { panel: Exclude<Panel, "us">; label: string }[] = [
  { panel: "ak", label: "ALASKA" },
  { panel: "hi", label: "HAWAI‘I" },
  // #111: "PACIFIC" -> "MARIANAS". A panel holding only the Marianas cannot keep a name that
  // covers the two beside it.
  { panel: "pac", label: "MARIANAS" },
  { panel: "nwhi", label: "MIDWAY" },
  { panel: "car", label: "CARIBBEAN" },
  { panel: "sam", label: "AMERICAN SAMOA" },
];

/** Escapes text that lands inside SVG markup, whether as element content or as an attribute
 * value -- codes and window strings are effectively a closed, safe alphabet today, but this
 * function is what keeps that true rather than assumed. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n: number): string {
  return n.toFixed(1);
}

/** Where the seats this note discloses land relative to a total the reader can actually see.
 *
 * `"included"` -- the surrounding page states a SEATS total that carries them (`/airport`'s
 * stat strip). The note exists so the arc count and that total can visibly disagree without
 * reading as an error.
 *
 * `"excluded"` -- the map states ROUTE counts, and a same-airport pair is not one of the routes
 * counted (`SegmentMapInput.sameAirportSeats`). "Included in this total" would point a reader
 * at a total that neither exists on this map face nor contains these seats; stating the seats
 * here is the only place they surface at all. */
export type SameAirportTotal = "included" | "excluded";

/** One sentence, written once, used on the visible window/note line AND in `aria-label` --
 * the number is per-subject, and two independently-authored copies of one measurement is
 * exactly how they drift (the same reasoning `AircraftMixChart.tsx`'s `gapNote` and Other-band
 * share note already apply). `null` when there is nothing to disclose, so both call sites can
 * skip the sentence with one check rather than two.
 *
 * Shared by BOTH maps since #104. The FACT is identical either way -- these seats are real and
 * they are not drawn -- so it stays one sentence with one owner. Only the clause naming what
 * does carry them differs, because on a hub something does and here nothing does, and a shared
 * tail would make one of the two maps state something false. */
export function sameAirportNote(seats: number, total: SameAirportTotal): string | null {
  if (seats <= 0) return null;
  const tail = total === "included" ? "included in this total." : "and from the route counts.";
  return `${seats.toLocaleString("en-US")} same-airport seats excluded from the arcs above, ${tail}`;
}

/** Count + reason, the form CLAUDE.md requires for quarantine everywhere else in this app
 * (`ReasonCode.tsx`'s "Quarantined — failed an invariant", the entity pages' "N quarantined
 * rows excluded from these totals, never clamped"). A map has no reason-code gutter to put the
 * reason in, so it goes inline. "Never clamped" is load-bearing, not decoration: the alternative
 * to quarantining a `load_factor > 1.0` row is clamping it, which this project refuses.
 *
 * Shared by BOTH maps since #114, exactly as `sameAirportNote` has been since #104. The FACT is
 * identical either way -- these route pairs exist, every filing behind them failed an invariant,
 * and none of them is drawn -- so it stays one sentence with one owner. `networkMap.ts` reaches
 * it through `networkDisclosureNotes`; a second copy of this wording in that file is the drift
 * this module's own "ONE OWNER PER SENTENCE" rule exists to prevent. */
export function quarantinedNote(routes: number): string | null {
  return routes > 0
    ? `${routes.toLocaleString("en-US")} quarantined route${routes === 1 ? "" : "s"} not drawn — failed an invariant, never clamped.`
    : null;
}

/**
 * The arcs half of a map's accessible description, written once and shared by both maps so
 * their wording cannot drift.
 *
 * `crossPanelCount` is NOT cosmetic (M7 final whole-branch review, Important #5): a great
 * circle is discontinuous across a panel boundary, so those are drawn as straight lines
 * instead (system.md's own rule) -- calling ALL of them "great-circle arcs" is wrong for
 * exactly those, and a screen-reader user gets no other account of the map at all. `0` (the
 * common case) keeps the sentence exactly as it was; only a nonzero count changes the wording,
 * and it names the exact number rather than a vague "some".
 *
 * Direction is NOT part of the claim (M7 re-review finding 4): the boundary can be crossed
 * either way -- a conterminous subject crosses INTO an inset (PDX-HNL), an inset-origin
 * subject crosses OUT of its own inset into the conterminous panel. "Into an inset panel" was
 * true only for the first and false for the second, so the wording names the BOUNDARY, never
 * a panel kind, and holds for both directions.
 *
 * `noun` is the only thing that differs between the two maps: a hub map draws one arc per
 * DESTINATION, a point-to-point map one per ROUTE. Neither noun is right for the other map.
 *
 * BOTH BRANCHES PLURALIZE, and the same-panel one is the one that matters: 55 airports have
 * exactly one drawn route on the served default window and 54 of them are same-panel, so the
 * cross-panel branch -- the one with a fixture -- serves exactly one page (PPG). An earlier
 * revision pluralized the cross-panel branch alone and the commit claimed "both halves", which
 * is the /watch/new-routes failure verbatim: a compound claim triaged by how true a clause
 * sounds instead of each clause re-derived. Nothing in the suite could see it, because the
 * golden takes the cross-panel branch (9 destinations, 5 crossings) and the only test touching
 * the other string asserted the defect.
 */
export function arcsSentence(drawn: number, crossPanelCount: number, noun: string): string {
  const plural = drawn === 1 ? "" : "s";
  const curved = drawn - crossPanelCount;
  return crossPanelCount === 0
    ? `${drawn} ${noun}${plural} drawn as great-circle arc${plural}, thinnest to heaviest by seats.`
    : `${drawn} ${noun}${plural} drawn thinnest to heaviest by seats -- ` +
        `${curved} as great-circle arc${curved === 1 ? "" : "s"}, ${crossPanelCount} as straight line${crossPanelCount === 1 ? "" : "s"} across a panel boundary (a great circle cannot cross one).`;
}

/** Which panel one endpoint belongs to, normalizing longitude first -- `regionOf` does not do
 * it itself, and six fact-present airports carry a positive longitude (`GeoNode`'s doc). */
function panelOf(node: GeoNode): Panel {
  return regionOf(node.lat, normalizeLon(node.lon));
}

interface FooterLine {
  text: string;
  /** A caption that NAMES which map you are looking at outranks the window note beside it --
   * the diff map's three panels are otherwise identical chrome, so its label cannot render in
   * the same muted weight as a footnote. */
  emphasis?: boolean;
}

/** One drawn airport disc. `belowFloor` is resolved by the BUILDER, not here, because the two
 * maps compute it from different denominators -- see `renderSegmentMap`'s `tallyNodes`. */
interface NodeMark {
  code: string;
  lat: number;
  lon: number;
  belowFloor: boolean;
}

/**
 * Everything the core draws, fully resolved. Every field is a decision the BUILDER has already
 * made: `lines` are already in draw order and already filtered, `nodes` are already deduped and
 * already in emission order, `footerLines` and `ariaLabel` are already worded. The core applies
 * no sort, no filter and no policy of its own -- which is what lets the hub builder reproduce
 * its pre-#104 bytes exactly while the segment builder imposes a different order.
 */
interface MapPlan {
  lines: SegmentDatum[];
  /** The `fitPanels` input. Supplied explicitly rather than derived from `lines` because the
   * hub map draws its origin disc even when it has no drawable arc at all -- deriving the fit
   * from `lines` alone would put that disc at (0,0) with no coastline under it. */
  points: GeoPoint[];
  nodes: NodeMark[];
  labelled: ReadonlySet<string>;
  /** The subject disc: a field-coloured circle ringed in the signal colour, the one departure
   * from the ink/ink-3 palette every other mark uses. `null` for a point-to-point map, which
   * genuinely has no subject airport -- not a mode flag, an absence. */
  marker: GeoNode | null;
  footerLines: FooterLine[];
  ariaLabel: string;
  basemapPaths?: string;
  /** An exact window to emit instead of the computed one. See `SegmentMapInput.cropWindow`. */
  cropWindow?: CropWindow;
}

/** A running vertical extent of everything the core emits. Seeded empty and widened per mark. */
interface InkExtent {
  top: number;
  bottom: number;
}

/** The emitted `viewBox`'s vertical window. */
export interface CropWindow {
  top: number;
  bottom: number;
}

/**
 * THE CANVAS IS CROPPED TO THE PANELS THAT CARRY POINTS (#123, absorbing #124), and this is
 * the only thing about it that changes -- the `viewBox` WINDOW, never the projection.
 * `fitPanels(BASEMAP_FIT_POINTS)` is still called with bit-identical input and every drawn
 * point keeps the coordinate it has always had; the M7 Task 8 rule that a per-page fit reuses
 * the coastline's baked fit VERBATIM is untouched, and unioning subject points into that fit
 * remains the wrong answer it has always been. Cropping a window moves nothing. Re-fitting
 * would move everything.
 *
 * WHY IT EXISTS: `renderMapCore` already emits an inset FRAME only for a panel the network
 * reaches (`fits.has(panel)` below). The canvas was not subject to the same rule, so an
 * Alaska-only network drew a small ALASKA inset under ~320px of empty conterminous panel --
 * measured on `/airport/BET`, `/airport/A18`, `/airport/JZM` and `/airport/OQZ`. One predicate
 * now decides both, which is why this reads `fits` rather than re-deriving reach.
 *
 * VERTICAL ONLY. The footer stack is painted at x=8 and runs the full 960px -- `SegmentMap.tsx`
 * documents the 158-character budget as a hard requirement, because those sentences reach the
 * reader nowhere else. A horizontal crop would clip disclosure copy, so there is none, and a
 * `us`-reaching map is very nearly full width anyway.
 *
 * THE BANDS ARE UNIONED WITH THE INK ACTUALLY EMITTED, so clipping is structurally impossible
 * rather than empirically absent. A great circle bows outside the rect between its endpoints, a
 * node's label runs below its centre, and the subject marker's own code is drawn at y-8 in
 * 11px -- 19px above a point that `panelContainment.test.ts` only guarantees is inside the
 * rect. Bands alone would clip all three on the right page.
 *
 * The TOP is clamped at 0 because that guarantee is gated: `panelContainment.test.ts` asserts
 * every subject disc AND its label sit inside the canvas, so this clamp can only ever remove
 * blank margin. The BOTTOM is not clamped -- the footer band is added under whatever the map's
 * own floor turns out to be, so the disclosure can never end up under the canvas edge.
 *
 * BOTH HALVES BIND, and each has its own case, because a panel's rect bounds a point and not
 * the ink that point paints:
 *
 *   TOP -- `renderMapCore` draws the subject's own code at y-8 in 11px type, so on
 *   `/airport/BLI`, the northernmost fact-present `us` airport, that ink reaches y=2.93 against
 *   a `us` band top of 18. Without the union the label is sliced off.
 *
 *   BOTTOM -- the subject disc is r=4.5 with a 1.8 stroke centred on it, so it reaches 5.4 past
 *   its own point, and a node label's descender reaches 5.0. `/airport/EYW` is the case: EYW
 *   projects to y=423.14, less than a pixel above the `us` band floor of 424 -- it is what
 *   `US_EXTENT_ANCHORS` exists to keep inside the rect -- so its disc reaches 428.50 and the
 *   served window is `0 12 960 443` with this term and `0 12 960 438` without it.
 *
 * `networkMap.test.ts` holds both. Note what does NOT decide which term wins: `FOOTER_BAND` is
 * added AFTER `Math.max(bandBottom, ink.bottom)`, so comparing it against the 5.4px overhang
 * says nothing about whether the ink term binds. It reads like an argument for deleting the
 * term, and it is not one.
 */
function cropWindow(
  reached: Iterable<Panel>,
  ink: InkExtent,
  footerLines: number,
): { top: number; height: number; bottom: number } {
  const bands = [...new Set(reached)].map(panelBand);

  // A MAP THAT REACHES NO PANEL AT ALL GETS THE WHOLE CANVAS, and this arm is not defensive
  // padding -- it is a live, linked page. `fetchCarrierTypeNetwork` DELIBERATELY returns a
  // non-null input with zero segments on two arms (`carrierTypeNetwork.ts`): a pair whose every
  // route is quarantined, and one whose only filing is same-airport. `/carrier/F4?type=SHORT360`
  // and `/aircraft/AS350-B2?carrier=8E` are both of those, and the second is one click from its
  // own page's `MapPicker`. The whole reason those arms return a map rather than `null` is that
  // the disclosure has to reach the reader -- returning null "hides a data-quality fact behind a
  // missing panel" -- so this is exactly where a broken canvas costs the most.
  //
  // Without the arm, `Math.min(...[])` is `Infinity` and `Math.max(...[])` is `-Infinity`: the
  // page served `viewBox="0 Infinity 960 -Infinity"` with the quarantine sentence painted at
  // `y="-Infinity"`. That is this module's own "a map that lies by omission", reached by the
  // crop rather than by the producer. `ink` is empty here too and cannot rescue it -- with no
  // points there are no arcs, no nodes and no marker, so both bounds are the empty interval.
  //
  // The full canvas is the right answer rather than a nominal box: it is what these pages served
  // before the crop existed, it puts the footer back on the floor every other map uses, and
  // there is no drawn content whose extent could argue for anything smaller.
  const band = footerBand(footerLines);
  if (bands.length === 0) return { top: 0, height: HEIGHT + band - FOOTER_BAND, bottom: HEIGHT + band - FOOTER_BAND };

  const bandTop = Math.min(...bands.map((b) => b[0]));
  const bandBottom = Math.max(...bands.map((b) => b[1]));
  const top = Math.max(0, Math.floor(Math.min(bandTop, ink.top) - FRAME_PAD));
  const bottom = Math.ceil(Math.max(bandBottom, ink.bottom) + band);
  return { top, height: bottom - top, bottom };
}

/**
 * Draw order (mirrors the mockup, and is itself part of the contract): inset frames for panels
 * the network actually reaches -> the injected basemap, if any -> arcs, thinnest first ->
 * nodes, each with its label if it has one -> the subject marker -> the footer stack.
 *
 * The footer is emitted LAST for a second reason since #123: its baseline is anchored to the
 * cropped canvas's floor, which is not known until every other mark has been measured.
 */
function renderMapCore(plan: MapPlan): string {
  // subjectFits decides WHICH panels this map reaches, and its own fit values are the FALLBACK
  // for a panel with no committed basemap reference points -- `nwhi` (Midway) alone. For every
  // other panel the value actually projected with is BASEMAP_FITS's, the one the coastline was
  // baked against, never a fit re-derived from this one page's own endpoints. See
  // BASEMAP_FITS's own comment for why the naive union is wrong rather than merely different.
  const subjectFits = fitPanels(plan.points);
  const fits = new Map<Panel, PanelFit>();
  for (const panel of subjectFits.keys()) {
    fits.set(panel, BASEMAP_FITS.get(panel) ?? subjectFits.get(panel)!);
  }

  let body = "";

  // Every mark's vertical reach, accumulated as it is drawn, so `cropWindow` can union it with
  // the panel bands. Seeded to the empty interval (+/-Infinity), never to the canvas: seeding
  // it to 0/HEIGHT would make the union always return the whole canvas and quietly disable the
  // crop, which is precisely the "gate that passes for the wrong reason" shape.
  const ink: InkExtent = { top: Infinity, bottom: -Infinity };
  const mark = (top: number, bottom: number) => {
    if (top < ink.top) ink.top = top;
    if (bottom > ink.bottom) ink.bottom = bottom;
  };

  // Inset frames -- only for panels with at least one point in them, and `us` is never framed.
  for (const { panel, label } of INSETS) {
    if (!fits.has(panel)) continue;
    const [x0, y0, x1, y1] = INSET_RECTS[panel];
    body += `<rect x="${x0 - FRAME_PAD}" y="${y0 - FRAME_PAD}" width="${x1 - x0 + 2 * FRAME_PAD}" height="${y1 - y0 + 2 * FRAME_PAD}" fill="none" stroke="var(--rule-2)" style="stroke-width:1"/>`;
    body += `<text x="${x0 - 4}" y="${y0 + 6}" font-size="8" letter-spacing="0.1em" fill="var(--ink-3)">${esc(label)}</text>`;
  }

  // The basemap is an injected input, never an import -- the caller supplies whichever panels'
  // paths it wants drawn. Rendered beneath the arcs, and omitted entirely (no wrapper, no
  // empty group) when absent.
  if (plan.basemapPaths) {
    body += plan.basemapPaths;
  }

  const maxSeats = plan.lines.length === 0 ? 0 : Math.max(...plan.lines.map((s) => s.seats));

  for (const s of plan.lines) {
    const fromXY = project(s.from.lat, s.from.lon, fits);
    const toXY = project(s.to.lat, s.to.lon, fits);

    let path: [number, number][];
    if (panelOf(s.from) !== panelOf(s.to)) {
      // A great circle cannot cross a panel boundary -- the projection is discontinuous
      // there -- so this is drawn as a straight line across the boundary instead (system.md).
      path = [fromXY, toXY];
    } else {
      const steps = stepsFor(Math.hypot(toXY[0] - fromXY[0], toXY[1] - fromXY[1]));
      path = greatCircle(
        { lat: s.from.lat, lon: s.from.lon },
        { lat: s.to.lat, lon: s.to.lon },
        steps,
      ).map((p) => project(p.lat, p.lon, fits));
    }

    const pts = path.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
    const stroke = strokeFor(s, maxSeats);
    // EVERY vertex, not just the endpoints: a great circle bows away from the straight line
    // between them, so an endpoint-only extent understates the arc by the whole of its bulge.
    // Half the stroke width, because a polyline is centred on its path.
    for (const [, y] of path) mark(y - stroke.width / 2, y + stroke.width / 2);
    // `stroke-dasharray` omitted entirely when `dash` is empty (the solid, above-both-floors
    // case -- most arcs) rather than emitted as `stroke-dasharray=""`. Browsers treat the empty
    // attribute as "no dashing," identically to its absence, so this was never a rendering bug
    // -- but it is invalid SVG, and it cost ~5 KB of no-op attribute bytes on a busy hub.
    const dashAttr = stroke.dash === "" ? "" : ` stroke-dasharray="${stroke.dash}"`;
    body += `<polyline points="${pts}" fill="none" stroke="${stroke.stroke}" stroke-width="${stroke.width.toFixed(2)}"${dashAttr} stroke-opacity="${stroke.opacity}" stroke-linecap="round"/>`;
  }

  for (const node of plan.nodes) {
    const [x, y] = project(node.lat, node.lon, fits);
    const r = node.belowFloor ? 1.3 : 2;
    body += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="${node.belowFloor ? "var(--ink-3)" : "var(--ink)"}"/>`;
    mark(y - r, y + r);
    if (plan.labelled.has(node.code)) {
      body += `<text x="${fmt(x + 5)}" y="${fmt(y + 3)}" font-size="9" font-weight="600" fill="var(--ink)">${esc(node.code)}</text>`;
      mark(...textBand(y + 3, 9));
    }
  }

  if (plan.marker !== null) {
    const [ox, oy] = project(plan.marker.lat, plan.marker.lon, fits);
    body += `<circle cx="${fmt(ox)}" cy="${fmt(oy)}" r="4.5" fill="var(--field)" stroke="var(--signal)" style="stroke-width:1.8"/>`;
    body += `<text x="${fmt(ox - 7)}" y="${fmt(oy - 8)}" text-anchor="end" font-size="11" font-weight="600" fill="var(--signal)">${esc(plan.marker.code)}</text>`;
    // The disc's own stroke is 1.8 centred on r=4.5, so its outer edge is 5.4 from the centre.
    mark(oy - 5.4, oy + 5.4);
    mark(...textBand(oy - 8, 11));
  }

  const computed = cropWindow(fits.keys(), ink, plan.footerLines.length);
  // An explicit window replaces the computed one WHOLESALE rather than being unioned with it.
  // The caller supplying it has already unioned this map's own window into it -- that is the
  // only way it can be produced (`segmentMapWindow`) -- so unioning again would be a no-op that
  // reads as though the override were advisory. It is not: a small multiple needs every panel
  // to emit the IDENTICAL box, and "widen to at least this" cannot guarantee that.
  const crop = plan.cropWindow
    ? { ...plan.cropWindow, height: plan.cropWindow.bottom - plan.cropWindow.top }
    : computed;

  // The footer stack is bottom-anchored: the LAST line sits on the CROPPED canvas's floor and
  // earlier lines stack upward from it, so a map with one line puts that line exactly where
  // every map has always put it -- `crop.bottom` is `HEIGHT` on any map that reaches the tray.
  // Anchoring it to `HEIGHT` instead would leave the disclosure off the bottom of a cropped
  // canvas, which is the one thing a shorter map must not cost the reader.
  plan.footerLines.forEach((line, i) => {
    const y = crop.bottom - 6 - (plan.footerLines.length - 1 - i) * FOOTER_LINE_HEIGHT;
    const style = line.emphasis ? ` font-weight="600" fill="var(--ink)"` : ` fill="var(--ink-2)"`;
    body += `<text x="8" y="${y}" font-size="10"${style}>${esc(line.text)}</text>`;
  });

  return (
    `<svg viewBox="0 ${crop.top} ${WIDTH} ${crop.height}" width="${WIDTH}" height="${crop.height}" ` +
    `role="img" aria-label="${esc(plan.ariaLabel)}" ` +
    `style="font-family:var(--font-mono);font-variant-numeric:tabular-nums" ` +
    `xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  );
}

/** The vertical ink box of one text run, from its BASELINE and font size. Both bounds are
 *  deliberate OVER-estimates -- a full font-size of ascent, and 0.3 of one of descent, against
 *  IBM Plex Mono's real 0.78/0.22 -- so the crop errs toward showing blank rather than toward
 *  shaving a glyph. Same over-estimate idiom, and the same reason, as
 *  `panelContainment.test.ts`'s on-canvas check. */
function textBand(baseline: number, fontSize: number): [number, number] {
  return [baseline - fontSize, baseline + 0.3 * fontSize];
}

/**
 * Which panels a set of points lands in, in `albers.ts`'s own panel order.
 *
 * Derived from `fitPanels` rather than from a hand-copied `PANEL_ORDER`: `fitPanels` already
 * iterates that table and already omits a panel with zero points, and a `Map` preserves
 * insertion order -- so this reads the ordering from the module that owns it instead of adding
 * a third copy of it (`albers.ts`'s is unexported and `basemap.ts` already keeps one).
 */
export function panelsFor(points: GeoPoint[]): Panel[] {
  return [...fitPanels(points).keys()];
}

/**
 * Every panel this network's DRAWN endpoints land in, normalized across the antimeridian
 * exactly as `fitPanels`/`project` require. Drives which panels' coastline `basemapPathsFor` is
 * asked for -- a page must not ship the Pacific or Caribbean outline when nothing in its own
 * network reaches either.
 *
 * SELF-SEGMENTS ARE EXCLUDED, via the same `drawableSegments` the renderer filters through, so
 * that this function and `renderSegmentMap` answer the identical question. They did not always:
 * this counted every endpoint while the renderer fitted only drawable ones, and a panel reached
 * ONLY by a self-segment then got a coastline from this function and no inset frame or label
 * from the renderer. `[SEA->PDX, HNL->HNL]` drew Hawai'i's landmass with no "HAWAI'I" frame
 * around it -- an unframed, unlabelled landmass, against the rule `INSETS` states ten lines
 * above: an inset that isn't labelled is a lie. Worse downstream, a component copying
 * `NetworkMap.tsx`'s `midwayHasNoBasemap` condition would caption "The Midway inset has no
 * coastline under its arcs" on a map drawing no Midway inset and no arcs there.
 *
 * The invariant to keep: this returns EXACTLY the panels `renderSegmentMap` fits and frames for
 * the same segments -- never a superset, never a subset.
 *
 * This is not the hub map's problem, and `networkPanels` does not share the filter: a hub
 * self-arc carries the ORIGIN's own coordinates, so its panel is already in the set. The
 * generalization introduced this one by giving a self-segment two endpoints that need not be
 * anywhere near the rest of the network.
 */
export function reachedPanelsFor(segments: SegmentDatum[]): Panel[] {
  return panelsFor(fitPointsOf(drawableSegments(segments)));
}

/** Both endpoints of every segment given, as bare `GeoPoint`s -- the `fitPanels` input. One
 * copy, so `reachedPanelsFor` and `renderSegmentMap` cannot drift on what "the map's points"
 * means. */
function fitPointsOf(segments: SegmentDatum[]): GeoPoint[] {
  const points: GeoPoint[] = [];
  for (const s of segments) {
    points.push({ lat: s.from.lat, lon: s.from.lon }, { lat: s.to.lat, lon: s.to.lon });
  }
  return points;
}

/**
 * Airport identity, as ONE key function -- `drawableSegments` compares two of them and
 * `tallyNodes` keys its `Map` on one, so the two genuinely cannot answer it differently.
 *
 * An earlier revision claimed exactly that while `tallyNodes` keyed on `end.code` directly, so
 * the extraction documented a seam it had not made: changing this to an id would have moved the
 * filter and left the dedupe on the display code, drawing two arcs and one dot for two distinct
 * airports. Both call sites now route through `airportKey`, which is the property the comment
 * always claimed.
 *
 * KEYED ON THE DISPLAY CODE, which is NOT what CLAUDE.md asks for: "Key on `AIRLINE_ID` and
 * `AIRPORT_ID`, never letter codes." This is the one place in the map engine that departs from
 * that rule, and it departs because `GeoNode` carries no id to key on -- `NetworkMapInput` has
 * none either (`ArcDatum` is code/lat/lon), and it is pinned, so the hub adapter could not
 * supply one without breaking `/airport`'s byte-identical guard.
 *
 * SAFE TODAY, MEASURED: zero display-code collisions among the 1,047 fact-present airports.
 * `dim_airport` carries 20+ overall -- `AUS` is both 10423 and 16440 -- but none of the
 * colliding pairs is fact-present, so no two endpoints the producers can emit share a code.
 *
 * WHAT BREAKS IF ONE EVER BECOMES FACT-PRESENT, and it is not a wrong pixel: a legitimate route
 * between two DISTINCT airports would be read as a self-segment and dropped -- silently
 * narrowing the map, and putting the drawn count below what the producer expects. Producers key
 * on `airport_id` (#105 excludes on `route_key_low = route_key_high`, the fact table's own id),
 * so the two disagree exactly then.
 *
 * REQUIRED OF PRODUCERS: derive any "did the renderer draw what I expected" assertion from an
 * id-keyed count, and let a mismatch degrade to a narrower map rather than throwing. An
 * assertion that throws turns this into a 500 on a served page for a condition that is not a
 * bug in the producer -- the strictly worse direction. The renderer itself never throws here.
 */
function airportKey(node: GeoNode): string {
  return node.code;
}

function sameAirport(a: GeoNode, b: GeoNode): boolean {
  return airportKey(a) === airportKey(b);
}

/** The segments that actually become arcs. A row whose two endpoints are the same airport has
 * a great circle of zero angular length, and `greatCircle`'s degenerate branch would emit
 * `steps + 1` identical points -- several hundred bytes drawing an invisible mark. Its seats
 * are NOT dropped; they reach the reader through `sameAirportSeats`. Identity is `sameAirport`'s
 * to decide -- read its comment before assuming this compares ids. */
export function drawableSegments(segments: SegmentDatum[]): SegmentDatum[] {
  return segments.filter((s) => !sameAirport(s.from, s.to));
}

/**
 * Ascending by seats, so the caller draws thinnest first and heaviest last (system.md: "Thin
 * arcs draw first so heavy ones sit on top").
 *
 * This is an ORDERING property, not a filter -- the SET of stroke widths produced is identical
 * whether or not this sort runs, so a test asserting only that set would pass under a dropped
 * sort. Only the drawn SEQUENCE distinguishes correct from buggy.
 *
 * The tiebreak is `from.code` then `to.code`, which is `arcOrder`'s tiebreak generalized: on a
 * hub every segment shares one `from`, so it falls through to `to.code` and reproduces
 * `arcOrder` exactly. That equivalence is what lets `/airport`'s golden stay byte-identical.
 */
export function segmentOrder(segments: SegmentDatum[]): SegmentDatum[] {
  return [...segments].sort(
    (a, b) =>
      a.seats - b.seats ||
      a.from.code.localeCompare(b.from.code) ||
      a.to.code.localeCompare(b.to.code),
  );
}

/** How many of the drawn lines cross a panel boundary. Computed from the same predicate the
 * core's draw loop uses, so the accessible wording and what actually got drawn cannot drift. */
export function crossPanelCount(lines: SegmentDatum[]): number {
  return lines.filter((s) => panelOf(s.from) !== panelOf(s.to)).length;
}

interface NodeTally {
  code: string;
  lat: number;
  lon: number;
  seats: number;
  departures: number;
}

/**
 * One tally per distinct airport, summing every segment incident on it.
 *
 * Deduped by `code`, first-seen coordinates winning -- the SAME identity `sameAirport` decides,
 * and its comment is the one that explains why this is a display code rather than an
 * `airport_id` and what a fact-present collision would cost. Two tallies for one code cannot
 * disagree about position TODAY, but the reason is not that the coordinate lookup is keyed on
 * `airport_id` -- being id-keyed is what makes two coordinate pairs for one display code
 * POSSIBLE, not impossible. The load-bearing reason is upstream and gated:
 * `pipeline/tests/test_resolution_invariants.py:82` asserts no display code is held by more
 * than one FACT-PRESENT airport, and would go red at the producer before such a pair could
 * reach a map. (`dim_airport WHERE is_latest` carries 20 codes held by several ids -- `AUS`,
 * `BER`, `HYD`, `DUR` among them -- and none of those ids is fact-present.) This does not throw
 * on a disagreement because a renderer on the served path must not, and there is no honest
 * thing to draw instead.
 *
 * Departures are SUMMED, which is what makes the below-floor mark mean the same thing on both
 * maps: a hub destination has exactly one incident arc, so the sum IS that arc's departures and
 * `/airport`'s bytes do not move; point-to-point, "this airport is barely served" is a claim
 * about everything flying into it, not about whichever segment happened to be listed first.
 */
function tallyNodes(lines: SegmentDatum[]): NodeTally[] {
  const byCode = new Map<string, NodeTally>();
  for (const s of lines) {
    for (const end of [s.from, s.to]) {
      const existing = byCode.get(airportKey(end));
      if (existing === undefined) {
        byCode.set(airportKey(end), {
          code: end.code,
          lat: end.lat,
          lon: end.lon,
          seats: s.seats,
          departures: s.departures,
        });
      } else {
        existing.seats += s.seats;
        existing.departures += s.departures;
      }
    }
  }
  return [...byCode.values()];
}

/**
 * The sentences a point-to-point map must disclose, in order: what the cap elided, what could
 * not be drawn at all, and what is not an arc. Widest claim first, each narrowing what the
 * reader is looking at.
 *
/**
 * WHY THESE ARE TEXT AND NOT A `<text>`: an outermost `<svg>` gets `overflow: hidden` from the
 * UA stylesheet, and `.map svg { max-width: 100% }` (`globals.css`) scales the box without
 * changing the viewBox -- so a run past `WIDTH` is painted outside the viewport at EVERY
 * viewport width, silently. Nothing in the markup records it: a `toContain` assertion passes on
 * a string that is present and unpaintable, and `app/smoke.sh` curls bytes, so neither gate can
 * see it.
 *
 * The budget: `--font-mono` is `next/font/google`'s `IBM_Plex_Mono({ subsets: ["latin"] })`
 * (`app/src/app/layout.tsx:13-18`) -- monospaced, so at `font-size="10"` from `x="8"` a line
 * holds `(960 - 8) / (0.6 * 10) = 158` characters. That 0.6em advance is IBM Plex Mono's single
 * advance width (`unitsPerEm` 1000, one `hmtx` entry of 600), and it holds for LATIN-SUBSET code
 * points only. It is NOT a universal bound: `→` (U+2192) is outside Google's `latin`
 * unicode-range, renders from whatever fallback the browser picks, and appears in every window
 * string this engine paints. Verify against `layout.tsx`'s font, never against
 * `app/src/lib/og/fonts/IBMPlexMono-Regular.ttf` -- that is a 98-glyph subset built for the OG
 * card renderer, a different file, and `→` is absent from it entirely.
 *
 * Measured against the real warehouse, the three sentences blew that budget on 12 of the 355
 * wave-2 views -- `/aircraft/CE-206%2F7` ran to 1,208px and lost its last 41 characters at the
 * frame edge while its `aria-label` carried the whole thing. A screen reader got the disclosure
 * and the person looking at the map did not, which is the exact inversion these sentences exist
 * to prevent. Shortening them was not available: the reason clause and the "and from the route
 * counts" clause are each there because an earlier round found the map lying without them.
 * Stacking them as extra footer rows is wrong for the WIDTH reason above and not for a
 * stacking one -- three rows of ~158-character prose is the same clipped text on three lines.
 * It used to also collide: frames ran to y=474 while the footer grew upward from a fixed y=494
 * in 12px steps, so a third row landed inside a labelled inset. That is no longer true --
 * `footerBand` reserves a line's height for every row, so the top of a three-row stack clears
 * the deepest frame by the same 10px a single row does. The width argument is the whole
 * argument now.
 *
 * So the component renders these as HTML beneath the map, where text wraps at any width -- the
 * shape `AircraftMixChart.tsx:81-99` already uses for `rampNote`/`gapNote` and
 * `NetworkMap.tsx:39-46` for its `pac` caption. Nothing needs them inside the raster:
 * `airport/[code]/opengraph-image.tsx:51` excludes the map from the OG card.
 * `renderSegmentMap` puts the identical sentences in the `aria-label` and nowhere else, which is
 * the established shape rather than an oversight -- `AircraftMixChart.tsx` says so in as many
 * words, "stated on the chart, not only in the aria-label."
 *
 * ONE PROSE SENTENCE IS STILL PAINTED, deliberately: the hub map joins `sameAirportNote` into
 * its footer (`networkMap.ts`), which `/airport` has shipped since M7 and whose worst case is
 * bounded -- a 7-digit seat count gives 17 + 3 + 81 = 101 characters against the 158 budget.
 * The rule is "prose that grows with the number of disclosures does not go in the SVG", not
 * "no prose ever".
 *
 * A COMPONENT THAT DOES NOT RENDER THESE SHIPS A MAP THAT LIES BY OMISSION. The `aria-label`
 * would carry a disclosure the person looking at the map never sees, which is the exact
 * inversion these sentences exist to prevent.
 *
 * The drawn count is derived here, never taken from the caller, for the reason `totalRoutes`
 * gives: two counts of one quantity in one description is a compound claim.
 */
export function disclosureNotes(input: SegmentMapInput): string[] {
  const drawn = drawableSegments(input.segments).length;
  const capped =
    drawn < input.totalRoutes
      ? `${drawn.toLocaleString("en-US")} of ${input.totalRoutes.toLocaleString("en-US")} route${input.totalRoutes === 1 ? "" : "s"} drawn.`
      : null;
  return [capped, quarantinedNote(input.quarantinedRoutes), sameAirportNote(input.sameAirportSeats, "excluded")].filter(
    (s): s is string => s !== null,
  );
}

/**
 * Renders a complete point-to-point map as an `<svg>…</svg>` string.
 *
 * NODE EMISSION ORDER IS IMPOSED HERE, NOT INHERITED. `tallyNodes` returns airports in the
 * order the caller happened to list their segments, and that order is not reproducible
 * upstream -- the pivot's `ORDER BY seats DESC` carries no tiebreak column, so tied seats are
 * SQL-unspecified and two runs over the same data can list them differently. Sorting ascending
 * by summed seats (tiebreak `code`) makes the rendered bytes a function of the DATA rather than
 * of the array, and it is the same rule the arcs already follow: heaviest last, so the busiest
 * airport's label paints over a quieter one rather than under it.
 */
export function renderSegmentMap(input: SegmentMapInput): string {
  const lines = segmentOrder(drawableSegments(input.segments));
  const tally = tallyNodes(lines);

  const nodes: NodeMark[] = [...tally]
    .sort((a, b) => a.seats - b.seats || a.code.localeCompare(b.code))
    .map((n) => ({
      code: n.code,
      lat: n.lat,
      lon: n.lon,
      belowFloor: n.departures < DEPARTURE_FLOOR,
    }));

  const labelled = new Set(
    [...tally]
      .sort((a, b) => b.seats - a.seats || a.code.localeCompare(b.code))
      .slice(0, TOP_LABEL_COUNT)
      .map((n) => n.code),
  );

  const points = fitPointsOf(lines);

  // The disclosure states the two counts and makes no claim about WHICH routes were drawn --
  // the renderer is not told the ranking the producer capped on, and inventing one ("the
  // heaviest N") would be a claim it cannot support.
  const disclosures = disclosureNotes(input);

  const footerLines: FooterLine[] = [{ text: input.window }];
  if (input.title !== undefined) {
    footerLines.push({ text: input.title, emphasis: true });
  }

  const ariaLabel = [
    input.title === undefined
      ? `Route map, ${input.window}.`
      : `${input.title}. Route map, ${input.window}.`,
    arcsSentence(lines.length, crossPanelCount(lines), "route"),
    ...disclosures,
  ].join(" ");

  return renderMapCore({
    lines,
    points,
    nodes,
    labelled,
    marker: null,
    footerLines,
    ariaLabel,
    basemapPaths: input.basemapPaths,
    cropWindow: input.cropWindow,
  });
}

/**
 * WHETHER THIS MAP DRAWS AN ARC -- the predicate the legend rail's "Arc rendering" group has to
 * ask, and not the same question as "is there a map" (#123).
 *
 * Every row in that group describes an ARC: width scales with seats, dashed is below the load
 * factor floor, dotted-muted is below the departure floor, and one paragraph explains why a
 * cross-panel arc is a straight line. A map can render with none of them -- a hub map still
 * paints its origin disc, and `fetchCarrierTypeNetwork` deliberately returns a map with zero
 * segments so its quarantine disclosure reaches the reader -- and on those pages the rail was
 * explaining three encodings the reader cannot see. Same rule as the fleet-shading group one
 * module over: the test is "was it DRAWN", never "is there data for it".
 *
 * `drawableSegments` is the renderer's OWN filter, the one that decides which polylines are
 * emitted, so this cannot answer differently from the map beside it.
 */
export function segmentArcsDrawn(input: SegmentMapInput): boolean {
  return drawableSegments(input.segments).length > 0;
}

/**
 * The window `renderSegmentMap` WOULD emit for this input -- read back off its own output.
 *
 * ASKING THE RENDERER IS THE POINT, not a shortcut. The window is the reached panels' bands
 * unioned with every mark the renderer emits: arc vertices including a great circle's bow, node
 * label boxes, the subject marker and its code. A second implementation that recomputed that
 * would be a copy of the drawing pass, and the two would drift the first time a mark changed
 * shape -- the exact failure `mixChartDraws` exists to prevent one module over. This renders
 * once and parses the one attribute it needs, so there is only ever one answer.
 *
 * It costs a second render of each panel in a set, and the reason that is affordable is NOT
 * that diff panels are small -- they are capped AT `NETWORK_ARC_CAP` like any other map, which
 * `DiffMap`'s own `countNote` says out loud ("on OO's added panel that would read 400 instead of
 * 1,624"). It is affordable because rendering is cheap. Measured on a 400-arc captioned panel,
 * 20 iterations after warmup: `renderSegmentMap` 1.83ms, `segmentMapWindow` 2.29ms -- so the
 * worst case, three capped panels on `/carrier/OO`, pays about 6.9ms extra, a rounding error
 * beside the DuckDB work that produced the diff. `DiffMap` is the only caller and no other
 * surface pays it at all. (A machine measurement, so it rots; the ORDER of magnitude is the
 * claim, and re-measure before quoting it.)
 */
export function segmentMapWindow(input: SegmentMapInput): CropWindow {
  const svg = renderSegmentMap(input);
  const box = svg.match(/viewBox="0 ([\d.-]+) \d+ ([\d.-]+)"/);
  // FAIL LOUD, WITH THE REASON. This runs on the served `/carrier` path, so a non-null assertion
  // here is a bare `TypeError` on a real page -- a 500 whose message names neither this function
  // nor the string it could not read. It is unreachable today only because `renderMapCore` always
  // emits a finite `viewBox`, and that became true only when the zero-segment arm was added to
  // `cropWindow`: this parse is downstream of an invariant that was violated in production once
  // already. Say what broke.
  if (box === null) {
    throw new Error(
      `segmentMapWindow: no parsable viewBox in the rendered map (got ${svg.slice(0, 120)})`,
    );
  }
  const [, top, height] = box.map(Number);
  return { top, bottom: top + height };
}

// `NodeMark` and `renderMapCore` are what `networkMap.ts` builds on. `MapPlan` and
// `FooterLine` stay module-private: nothing outside this file constructs one by name.
export type { NodeMark };
export { renderMapCore };
