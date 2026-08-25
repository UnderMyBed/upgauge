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
   *  truncate silently today.
   *
   *  NOTHING CROSS-CHECKS `drawnRoutes` AGAINST `segments.length`, deliberately. The renderer
   *  cannot derive `totalRoutes` (the query that produced these segments carried a LIMIT, so
   *  the true total is only knowable upstream -- `db.ts:251-254`), and it must not throw on
   *  the served path. So a producer that draws 400 segments while claiming `drawnRoutes: 399`
   *  renders a false sentence and nothing here catches it. #105 and #109 own that assertion;
   *  both compute `drawnRoutes` as `min(total, cap)`. */
  drawnRoutes: number;
  totalRoutes: number;
  /** Routes the producer could not draw because every filing behind them was quarantined --
   *  excluded from `drawnRoutes` and `totalRoutes` alike, so without this field they vanish
   *  from the map entirely: not an arc, not a row in any count, no trace that anything was
   *  there. Measured (#105): 34 such groups over the trailing 12, and every one of them
   *  PERFORMED DEPARTURES -- quarantined `zero_seats`, a passenger aircraft that flew and filed
   *  zero seats. Two views have no map at all for this reason.
   *
   *  CLAUDE.md: quarantined rows are "excluded from aggregates but surfaced in the UI with
   *  count + reason. Showing the dirt is a trust feature." Optional, so the hub path -- which
   *  has no equivalent field -- is untouched. */
  quarantinedRoutes?: number;
  /** Optional caption under the window line -- the diff map's per-panel label. */
  title?: string;
  /** Seats from rows whose two endpoints are the SAME airport. Such a row can never be an arc
   *  -- its great circle has zero angular length -- but its seats must still reach the reader,
   *  or the map's own stated total falls out of step with the stat strip above it on the page.
   *  Optional because a producer that filed none passes nothing; `NetworkMapInput` carries the
   *  same field as a required scalar for the same reason (see its own doc for the measurement).
   *
   *  A same-airport pair is NOT counted in `drawnRoutes` or `totalRoutes` -- it is not one of
   *  the routes, and the producer excludes it from both. That is why this map's note cannot
   *  borrow the hub map's "included in this total" wording: there is no total on this map face
   *  that carries these seats, and stating them here is the only place they surface at all.
   *
   *  Measured for the point-to-point maps (#105): 598,829 same-airport seats across 759
   *  carrier x aircraft-type groups over the trailing 12. Dropping them silently in the
   *  generalization would have lost an honesty property the hub map already had. */
  sameAirportSeats?: number;
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
 * The correct rule: for a panel `BASEMAP_FITS` has an entry for (us/ak/hi/car today -- Task 7b
 * added `ne_50m_car.json`'s Puerto Rico/USVI polygons, so `car` now has committed geometry too
 * and its reference points feed this same `fitPanels(BASEMAP_FIT_POINTS)` call), reuse that fit
 * VERBATIM -- identical input, identical output, so an arc and the coastline beneath it were
 * fit exactly once. For a panel with zero committed reference points (pac alone, as of Task
 * 7b -- no Guam/CNMI/American Samoa/Midway polygons at this scale, `build-basemap.mjs`'s
 * header), there is no coastline to align to, so a subject-derived fit is the legitimate,
 * documented fallback -- see the merge in `renderMapCore` below. An airport that then lands
 * slightly outside the simplified coastline renders slightly outside it; that is
 * geographically honest and must not be "fixed" by rescaling.
 */
const BASEMAP_FITS: Map<Panel, PanelFit> = fitPanels(BASEMAP_FIT_POINTS);

const WIDTH = 960;
const HEIGHT = 500;

/** Vertical step of the footer stack. Only a map with a `title` has more than one line, so on
 * every other map this constant is unreachable and the window line sits at `HEIGHT - 6`
 * exactly where it always has. */
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
const INSET_RECTS: Record<Exclude<Panel, "us">, [number, number, number, number]> = {
  ak: [36, 322, 176, 468],
  hi: [192, 392, 292, 468],
  pac: [308, 392, 408, 468],
  // Widened by M7 Task 7b to match albers.ts's own PANEL_RECTS.car -- see that file's
  // comment for the measurement (real PR/USVI geometry is ~3.89:1 wide, not the original
  // rect's 1.32:1). Keep this literal in sync with PANEL_RECTS.car; a frame border drawn to
  // a different rect than the one the coastline was actually fit to would visibly not match
  // the landmass inside it.
  car: [424, 392, 720, 468],
};

/** Order and label text for the four insets. `us` never gets a frame -- it is the base map
 * itself, not an inset of it, matching the mockup, which only ever framed `ak`/`hi`. "An
 * inset that isn't labelled is a lie" is the mockup's own comment; system.md states it as a
 * standing rule, not a note about one page. */
const INSETS: { panel: Exclude<Panel, "us">; label: string }[] = [
  { panel: "ak", label: "ALASKA" },
  { panel: "hi", label: "HAWAI‘I" },
  { panel: "pac", label: "PACIFIC" },
  { panel: "car", label: "CARIBBEAN" },
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
 * to quarantining a `load_factor > 1.0` row is clamping it, which this project refuses. */
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
 */
export function arcsSentence(drawn: number, crossPanelCount: number, noun: string): string {
  const plural = drawn === 1 ? "" : "s";
  return crossPanelCount === 0
    ? `${drawn} ${noun}${plural} drawn as great-circle arcs, thinnest to heaviest by seats.`
    : `${drawn} ${noun}${plural} drawn thinnest to heaviest by seats -- ` +
        `${drawn - crossPanelCount} as great-circle arcs, ${crossPanelCount} as straight lines across a panel boundary (a great circle cannot cross one).`;
}

/** Which panel one endpoint belongs to, normalizing longitude first -- `regionOf` does not do
 * it itself, and six fact-present airports carry a positive longitude (`GeoNode`'s doc). */
function panelOf(node: GeoNode): Panel {
  return regionOf(node.lat, normalizeLon(node.lon));
}

/** One drawn airport disc. `belowFloor` is resolved by the BUILDER, not here, because the two
 * maps compute it from different denominators -- see `renderSegmentMap`'s `tallyNodes`. */
interface NodeMark {
  code: string;
  lat: number;
  lon: number;
  belowFloor: boolean;
}

interface FooterLine {
  text: string;
  /** A caption that NAMES which map you are looking at outranks the window note beside it --
   * the diff map's three panels are otherwise identical chrome, so its label cannot render in
   * the same muted weight as a footnote. */
  emphasis?: boolean;
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
  // for a panel with no committed basemap reference points -- `pac` alone today. For every
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
 * Every panel this network's own endpoints land in, normalized across the antimeridian exactly
 * as `fitPanels`/`project` require. Drives which panels' coastline `basemapPathsFor` is asked
 * for -- a page must not ship the Pacific or Caribbean outline when nothing in its own network
 * reaches either.
 *
 * Counts BOTH endpoints of EVERY segment, self-segments included. A self-segment draws no arc
 * (its great circle has zero length) but its airport is genuinely part of the network, and the
 * asymmetry is deliberate: a coastline drawn under a panel with no marks on it is scenery,
 * while a MISSING coastline under a drawn arc reads as a rendering defect.
 */
export function reachedPanelsFor(segments: SegmentDatum[]): Panel[] {
  const points: GeoPoint[] = [];
  for (const s of segments) {
    points.push({ lat: s.from.lat, lon: s.from.lon }, { lat: s.to.lat, lon: s.to.lon });
  }
  return panelsFor(points);
}

/** The segments that actually become arcs. A row whose two endpoints are the same airport has
 * a great circle of zero angular length, and `greatCircle`'s degenerate branch would emit
 * `steps + 1` identical points -- several hundred bytes drawing an invisible mark. Its seats
 * are NOT dropped; they reach the reader through `sameAirportSeats`. */
export function drawableSegments(segments: SegmentDatum[]): SegmentDatum[] {
  return segments.filter((s) => s.from.code !== s.to.code);
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
 * Deduped by `code`, first-seen coordinates winning. Two tallies for one code cannot disagree
 * about position by construction: coordinates come from a single `map_airport_coords.sql`
 * lookup keyed on `airport_id`, so one code resolves to one pair of coordinates for the whole
 * of a render. This does not throw on a disagreement because a renderer on the served path
 * must not, and there is no honest thing to draw instead.
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
      const existing = byCode.get(end.code);
      if (existing === undefined) {
        byCode.set(end.code, {
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

  const points: GeoPoint[] = [];
  for (const s of lines) {
    points.push({ lat: s.from.lat, lon: s.from.lon }, { lat: s.to.lat, lon: s.to.lon });
  }

  // The disclosure states the two counts and makes no claim about WHICH routes were drawn --
  // the renderer is not told the ranking the producer capped on, and inventing one ("the
  // heaviest N") would be a claim it cannot support.
  const disclosure =
    input.drawnRoutes < input.totalRoutes
      ? `${input.drawnRoutes.toLocaleString("en-US")} of ${input.totalRoutes.toLocaleString("en-US")} routes drawn.`
      : null;
  const note = sameAirportNote(input.sameAirportSeats ?? 0, "excluded");
  const quarantined = quarantinedNote(input.quarantinedRoutes ?? 0);

  // Order: what window, then what was capped, then what could not be drawn, then what is not an
  // arc at all -- widest claim first, each one narrowing what the reader is looking at.
  const disclosures = [disclosure, quarantined, note].filter((s): s is string => s !== null);

  const footerLines: FooterLine[] = [
    { text: [input.window, ...disclosures].join(" · ") },
  ];
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

export type { MapPlan, NodeMark, FooterLine };
export { renderMapCore };
