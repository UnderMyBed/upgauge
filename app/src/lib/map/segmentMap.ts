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
import { fitPanels, normalizeLon, project, regionOf } from "./albers";
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
  /** `null` means "such a pair exists and its seat count CANNOT be stated" -- every filing
   *  behind it was quarantined, so `sum(seats) FILTER (WHERE NOT is_quarantined)` returned NULL.
   *  That is a THIRD state, distinct from `0` ("no seats withheld") and from a positive count,
   *  and #121 exists because a `?? 0` collapsed it into the first: the map would say nothing was
   *  being withheld while a pair was being withheld by an unstateable amount.
   *
   *  LATENT on today's warehouse -- the quarantined same-airport pair is real (`8V`'s VEE-VEE),
   *  but every producer folds it in with stateable pairs, so no panel actually returns NULL
   *  (measured across all 115 carriers). The state is admitted because the producer's own SQL
   *  can return it, not because a page shows it. Still REQUIRED: pass `0` to say "none". */
  sameAirportSeats: number | null;
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
const HEIGHT = 500;

/** Vertical step of the footer stack. The stack is bottom-anchored, so a map with one line puts
 * that line exactly where every map has always put it. */
const FOOTER_LINE_HEIGHT = 12;

/** How many airports get a text label. Labelling every node on a busy network would bury the
 * map in text; 8 is the density this 960x500 canvas was reviewed and shipped at.
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
  ak: [36, 322, 176, 468],
  hi: [192, 392, 292, 468],
  // #111: reshaped AND relocated. Real Guam + Northern Marianas geometry is 0.2052:1 -- five
  // times taller than wide -- and 216px of height is what puts Tinian and Saipan 6px apart.
  // The top-left margin is the only place a rect that tall does not sit underneath the opaque
  // lower-48 landmass, where its frame and MARIANAS label were painted over. The one inset
  // outside the bottom tray.
  pac: [40, 30, 84, 246],
  // #111: Midway. No committed geometry -- Natural Earth carries it only inside a feature that
  // also spans the Caribbean -- so it keeps the subject-derived fit. The frame is still drawn,
  // or the arc reaching Midway floats in unlabelled space.
  nwhi: [368, 392, 408, 468],
  // #111: American Samoa. 181 wide, not 163: the 2.1419:1 aspect that produced 163 was measured
  // under PANEL_PARAMS.pac. Under its own parallels it is 2.3801:1 on the 3-decimal reference
  // points fitPanels actually reads.
  sam: [736, 392, 917, 468],
  // Widened by M7 Task 7b to match albers.ts's own PANEL_RECTS.car -- see that file's
  // comment for the measurement (real PR/USVI geometry is ~3.89:1 wide, not the original
  // rect's 1.32:1). Keep this literal in sync with PANEL_RECTS.car; a frame border drawn to
  // a different rect than the one the coastline was actually fit to would visibly not match
  // the landmass inside it.
  car: [424, 392, 720, 468],
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
export function sameAirportNote(seats: number | null, total: SameAirportTotal): string | null {
  const tail = total === "included" ? "included in this total." : "and from the route counts.";
  // THE UNSTATEABLE CASE IS NOT THE EMPTY ONE (#121). A pair exists, it is being withheld from
  // the arcs, and its seats cannot be summed because every filing behind it failed an invariant.
  // Saying nothing here -- which `seats <= 0` would do once the type admits null -- withholds
  // the one disclosure this field exists to make; saying "0 same-airport seats" would assert a
  // measurement nobody has. So it gets its own sentence, in the form CLAUDE.md requires for
  // quarantine everywhere else: the fact, then the reason, never a clamp.
  if (seats === null) {
    return (
      `Same-airport seats excluded from the arcs above, ${tail} The amount cannot be stated: ` +
      `every filing behind them failed an invariant, never clamped.`
    );
  }
  if (seats <= 0) return null;
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
}

/**
 * Draw order (mirrors the mockup, and is itself part of the contract): inset frames for panels
 * the network actually reaches -> the injected basemap, if any -> arcs, thinnest first ->
 * nodes, each with its label if it has one -> the subject marker -> the footer stack.
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

  // Inset frames -- only for panels with at least one point in them, and `us` is never framed.
  for (const { panel, label } of INSETS) {
    if (!fits.has(panel)) continue;
    const [x0, y0, x1, y1] = INSET_RECTS[panel];
    body += `<rect x="${x0 - 6}" y="${y0 - 6}" width="${x1 - x0 + 12}" height="${y1 - y0 + 12}" fill="none" stroke="var(--rule-2)" style="stroke-width:1"/>`;
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
    // `stroke-dasharray` omitted entirely when `dash` is empty (the solid, above-both-floors
    // case -- most arcs) rather than emitted as `stroke-dasharray=""`. Browsers treat the empty
    // attribute as "no dashing," identically to its absence, so this was never a rendering bug
    // -- but it is invalid SVG, and it cost ~5 KB of no-op attribute bytes on a busy hub.
    const dashAttr = stroke.dash === "" ? "" : ` stroke-dasharray="${stroke.dash}"`;
    body += `<polyline points="${pts}" fill="none" stroke="${stroke.stroke}" stroke-width="${stroke.width.toFixed(2)}"${dashAttr} stroke-opacity="${stroke.opacity}" stroke-linecap="round"/>`;
  }

  for (const node of plan.nodes) {
    const [x, y] = project(node.lat, node.lon, fits);
    body += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${node.belowFloor ? 1.3 : 2}" fill="${node.belowFloor ? "var(--ink-3)" : "var(--ink)"}"/>`;
    if (plan.labelled.has(node.code)) {
      body += `<text x="${fmt(x + 5)}" y="${fmt(y + 3)}" font-size="9" font-weight="600" fill="var(--ink)">${esc(node.code)}</text>`;
    }
  }

  if (plan.marker !== null) {
    const [ox, oy] = project(plan.marker.lat, plan.marker.lon, fits);
    body += `<circle cx="${fmt(ox)}" cy="${fmt(oy)}" r="4.5" fill="var(--field)" stroke="var(--signal)" style="stroke-width:1.8"/>`;
    body += `<text x="${fmt(ox - 7)}" y="${fmt(oy - 8)}" text-anchor="end" font-size="11" font-weight="600" fill="var(--signal)">${esc(plan.marker.code)}</text>`;
  }

  // The footer stack is bottom-anchored: the LAST line sits on the canvas floor and earlier
  // lines stack upward from it, so a map with one line puts that line exactly where every map
  // has always put it.
  plan.footerLines.forEach((line, i) => {
    const y = HEIGHT - 6 - (plan.footerLines.length - 1 - i) * FOOTER_LINE_HEIGHT;
    const style = line.emphasis ? ` font-weight="600" fill="var(--ink)"` : ` fill="var(--ink-2)"`;
    body += `<text x="8" y="${y}" font-size="10"${style}>${esc(line.text)}</text>`;
  });

  return (
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" ` +
    `role="img" aria-label="${esc(plan.ariaLabel)}" ` +
    `style="font-family:var(--font-mono);font-variant-numeric:tabular-nums" ` +
    `xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  );
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
 * Stacking them as extra footer rows is wrong for a measured reason -- the inset frames run to
 * y=474 while the footer grows upward from y=494 in 12px steps, so the third row lands inside a
 * labelled inset.
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
  });
}

// `NodeMark` and `renderMapCore` are what `networkMap.ts` builds on. `MapPlan` and
// `FooterLine` stay module-private: nothing outside this file constructs one by name.
export type { NodeMark };
export { renderMapCore };
