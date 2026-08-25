/**
 * Composes the projection (`albers.ts`, Task 4) and the interpolation (`greatCircle.ts`,
 * Task 5) into the actual picture: arc encoding (`arcs.ts`, this task), draw order, and one
 * function returning a complete `<svg>…</svg>` string. Server-rendered markup only, no chart
 * library, no dependency outside `app/src/lib/map/` -- the same "in the served HTML, visible
 * with JS off" property `AircraftMixChart.tsx` established for M4c's chart.
 *
 * Ported from `docs/design/mockups/map-network.html`'s inline `<script>` (lines 53-96 of
 * that file: inset frames, the arc loop, destination nodes, labels, the origin marker).
 * Contract: `docs/design/system.md` § The map § Arc encoding.
 */

import type { GeoPoint, Panel, PanelFit } from "./albers";
import { fitPanels, normalizeLon, project, regionOf } from "./albers";
import { greatCircle, stepsFor } from "./greatCircle";
import { arcOrder, strokeFor, DEPARTURE_FLOOR, type ArcDatum } from "./arcs";
import { BASEMAP_FIT_POINTS } from "./basemap";

/**
 * THE FIT THE COASTLINE WAS BAKED AGAINST -- computed once, at module load, from the same
 * fixed reference points `basemap.ts`'s generator used (`fitPanels(BASEMAP_FIT_POINTS)`,
 * bit-for-bit identical input). This is the fix for a real, confirmed defect (M7 Task 8):
 * an earlier draft of this file called `fitPanels(points)` with ONLY the origin and its own
 * destinations, which is a DIFFERENT fit than the one `basemapPaths.generated.ts`'s
 * coordinates were baked with -- every arc was scaled/offset relative to a landmass drawn at
 * a different scale, geographically wrong on every render despite passing every existing
 * test (none of which asserted on absolute screen position).
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
 * The correct rule: for a panel `BASEMAP_FITS` has an entry for (us/ak/hi/pac/car/sam today --
 * Task 7b added `ne_50m_car.json`'s Puerto Rico/USVI polygons and #111 added
 * `ne_50m_pac.json`'s Guam/Northern Marianas/American Samoa ones, so all six feed this same
 * `fitPanels(BASEMAP_FIT_POINTS)` call), reuse that fit VERBATIM -- identical input, identical
 * output, so an arc and the coastline beneath it were fit exactly once. For a panel with zero
 * committed reference points (`nwhi` alone as of #111 -- Midway, which Natural Earth carries
 * only inside a feature that also spans the Caribbean; `build-basemap.mjs`'s header), there is
 * no coastline to align to, so a subject-derived fit is the legitimate, documented fallback --
 * see the merge in `renderNetworkMap` below. That branch is not dead code kept for symmetry:
 * `/airport/MDY?y=2021` and `/airport/HNL?y=2021` are the pages it carries, and giving Midway
 * the baked `pac` fit instead would project it to (1367.6, -429.7) under this commit's own
 * `pac` fit, off a 960x500 canvas.
 * An airport that lands slightly outside the simplified coastline renders slightly outside it;
 * that is geographically honest and must not be "fixed" by rescaling.
 */
const BASEMAP_FITS: Map<Panel, PanelFit> = fitPanels(BASEMAP_FIT_POINTS);

export interface NetworkMapInput {
  origin: ArcDatum;
  arcs: ArcDatum[];
  window: string;
  /** Seats from rows whose origin and destination are the same airport as `origin.code`
   * (359 of 1,047 fact-present airports carry at least one; ORD alone is 53 rows / 73,082
   * seats over the trailing 12 months -- docs/data/invariants.md § Route identity). Such a
   * row cannot be an arc: its great circle has zero length, and `greatCircle`'s degenerate
   * branch would emit `steps + 1` identical points, several hundred bytes drawing an
   * invisible mark on top of the origin disc. So the caller never puts a same-airport row in
   * `arcs` in the first place (or, if it does, `renderNetworkMap` filters it below) -- but
   * either way its seats must still reach the reader, or the map's own stated total falls out
   * of step with the stat strip directly above it on the page. Both halves are required. */
  sameAirportSeats: number;
  /** Projected coastline path/circle markup, already in screen coordinates. An INJECTED
   * INPUT, never an import -- this stays true of the PATH MARKUP even after Task 7 shipped:
   * a caller supplies whichever panels' paths it wants drawn (`basemapPathsFor`), and this
   * file has no opinion on which those are. The FIT those paths were projected with is a
   * different matter and IS imported now that Task 7's `basemap.ts` exists (`BASEMAP_FITS`,
   * above) -- reusing it verbatim is what keeps this markup and the arcs drawn over it in the
   * same reference frame. Rendered beneath the arcs when present; omitted entirely -- no
   * empty `<g>`, no comment -- when absent. */
  basemapPaths?: string;
}

const WIDTH = 960;
const HEIGHT = 500;

/** How many of the arcs, ranked by seats, get a text label next to their destination node.
 * Mirrors the mockup's own `slice(0,8)` -- labelling every destination on a busy hub would
 * bury the map in text. */
const TOP_LABEL_COUNT = 8;

/**
 * Screen rects for the labelled insets, mirroring `albers.ts`'s `PANEL_RECTS` layout table
 * verbatim. Not derivable from `fitPanels`'s return value, which carries only each panel's
 * data-dependent SCALE and OFFSET (`k`/`ox`/`oy`), not its fixed on-canvas frame. This copy is
 * chrome only (drawing the frame border), never projection math, which `fitPanels`/`project`
 * alone own.
 *
 * THE ORIGINAL REASON FOR THE COPY IS GONE, and saying so matters more than the copy does: it
 * was "Task 6 must not edit Task 4's file to export the constant", and #111 exported
 * `PANEL_RECTS` anyway so a test could assert an airport lands inside its own panel against the
 * real table. What is left is a hand-copy with no justification, kept for one commit only
 * because #104 is concurrently relocating this table into `segmentMap.ts` and collapsing it
 * here would turn a two-literal merge into a structural one. The follow-up is to import
 * `PANEL_RECTS` and delete this.
 *
 * Until then the sync is GATED rather than asked for: `networkMap.test.ts` asserts this table
 * deep-equals `PANEL_RECTS` minus `us`. That is why it is exported -- a frame border drawn to a
 * different rect than the one the coastline was fit to would visibly not match the landmass
 * inside it, and #111 edited both tables by hand, which is precisely the operation the missing
 * gate existed to catch.
 */
export const INSET_RECTS: Record<Exclude<Panel, "us">, [number, number, number, number]> = {
  ak: [36, 322, 176, 468],
  hi: [192, 392, 292, 468],
  // Reshaped AND relocated by #111 to match albers.ts's own PANEL_RECTS.pac -- real Guam +
  // Northern Marianas geometry is 0.2052:1, five times taller than wide, 216px of height is
  // what puts Tinian and Saipan 6px apart, and the top-left margin is the only place a rect
  // that tall does not end up underneath the opaque lower-48 landmass. See that file's comment
  // for both measurements. This is the one inset outside the bottom tray.
  pac: [40, 30, 84, 246],
  // Midway. No committed geometry, so the coastline cannot disagree with this frame -- but the
  // frame must still be drawn, or the arc that reaches Midway floats in unlabelled space.
  nwhi: [368, 392, 408, 468],
  // Widened by M7 Task 7b to match albers.ts's own PANEL_RECTS.car -- see that file's
  // comment for the measurement (real PR/USVI geometry is ~3.89:1 wide, not the original
  // rect's 1.32:1). Keep this literal in sync with PANEL_RECTS.car; a frame border drawn to
  // a different rect than the one the coastline was actually fit to would visibly not match
  // the landmass inside it.
  car: [424, 392, 720, 468],
  // American Samoa (#111), aspect-matched to its 2.3801:1 extent -- measured under
  // PANEL_PARAMS.sam, not PANEL_PARAMS.pac, and on the rounded points fitPanels reads -- at
  // the tray's own height.
  sam: [736, 392, 917, 468],
};

/** Order and label text for the six insets. `us` never gets a frame -- it is the base map
 * itself, not an inset of it, matching the mockup, which only ever framed `ak`/`hi`. "An
 * inset that isn't labelled is a lie" is the mockup's own comment; system.md states it as a
 * standing rule, not a note about one page. */
const INSETS: { panel: Exclude<Panel, "us">; label: string }[] = [
  { panel: "ak", label: "ALASKA" },
  { panel: "hi", label: "HAWAI‘I" },
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

/** One sentence, written once, used on the visible window/note line AND in `aria-label` --
 * the number is per-subject, and two independently-authored copies of one measurement is
 * exactly how they drift (the same reasoning `AircraftMixChart.tsx`'s `gapNote` and Other-band
 * share note already apply). `null` when there is nothing to disclose, so both call sites can
 * skip the sentence with one check rather than two. */
function sameAirportNote(seats: number): string | null {
  return seats > 0
    ? `${seats.toLocaleString("en-US")} same-airport seats excluded from the arcs above, included in this total.`
    : null;
}

/** What the map shows, for a reader who cannot see it -- the subject, the window, how many
 * destinations are drawn, and the same-airport seats excluded from the arcs but not the
 * total. Mirrors `AircraftMixChart.tsx`'s `describe()`: written once, read by both the visible
 * key and `aria-label`, so the two cannot drift.
 *
 * `crossPanelCount` is NOT cosmetic (final whole-branch review, Important #5): a great circle
 * is discontinuous across a panel boundary, so `renderNetworkMap` draws those destinations as
 * straight lines across the boundary instead (system.md's own rule) -- calling ALL of them
 * "great-circle arcs" is wrong for exactly those, and a screen-reader user gets no other
 * account of the map at all. `0` (the common case -- most airports have no cross-panel
 * destination) keeps the sentence exactly as before; only a nonzero count changes the wording,
 * and it names the exact number rather than a vague "some".
 *
 * Direction is NOT part of the claim (re-review finding 4): the boundary a destination crosses
 * can run either way -- most origins are conterminous and cross INTO an inset (PDX-HNL), but an
 * inset-origin subject (ANC, HNL, SJU, GUM) has destinations that cross OUT of its own inset
 * into the conterminous panel instead. "Into an inset panel" was true only for the first case
 * and false for the second, on the subject's own arcs -- the wording below names the boundary,
 * never a panel kind, so it holds for both directions. */
function describeMap(input: NetworkMapInput, drawn: ArcDatum[], crossPanelCount: number): string {
  const note = sameAirportNote(input.sameAirportSeats);
  const arcsDesc =
    crossPanelCount === 0
      ? `${drawn.length} destination${drawn.length === 1 ? "" : "s"} drawn as great-circle arcs, thinnest to heaviest by seats.`
      : `${drawn.length} destination${drawn.length === 1 ? "" : "s"} drawn thinnest to heaviest by seats -- ` +
        `${drawn.length - crossPanelCount} as great-circle arcs, ${crossPanelCount} as straight lines across a panel boundary (a great circle cannot cross one).`;
  return [`Network map of ${input.origin.code}'s scheduled service, ${input.window}.`, arcsDesc, note]
    .filter((s): s is string => s !== null)
    .join(" ");
}

/**
 * Renders the complete network map for one origin airport as an `<svg>…</svg>` string.
 *
 * Draw order (mirrors the mockup, and is itself part of the contract -- see `arcOrder`'s own
 * docs on why thinnest-first is an ordering property a set-based test cannot catch): inset
 * frames for panels the network actually reaches → the injected basemap, if any → arcs,
 * thinnest first → destination nodes → labels for the top 8 by seats → the origin marker →
 * the window line and the excluded-seats note.
 */
export function renderNetworkMap(input: NetworkMapInput): string {
  const { origin } = input;

  // Same-airport rows are excluded HERE, from the drawn set -- never upstream, and never by
  // relying on the caller to have already filtered. A same-airport arc's great circle has
  // zero length; greatCircle's degenerate branch would emit `steps + 1` identical points
  // drawing an invisible mark on top of the origin disc (see NetworkMapInput.sameAirportSeats
  // for the measured cost). Their seats are NOT dropped -- only the polyline is -- which is
  // why `sameAirportSeats` is a separate field the caller supplies rather than something
  // derivable from `arcs` after this filter runs.
  const drawn = input.arcs.filter((a) => a.code !== origin.code);

  const points: GeoPoint[] = [
    { lat: origin.lat, lon: origin.lon },
    ...drawn.map((a) => ({ lat: a.lat, lon: a.lon })),
  ];
  // subjectFits decides WHICH panels this network reaches (unchanged from before the fix --
  // still exactly "the panels the subject's own points land in", which is what the inset-
  // frame loop below needs), and its own fit values are the FALLBACK for a panel with no
  // committed basemap reference points -- `nwhi` (Midway) alone today, since M7 Task 7b gave
  // `car` real geometry and #111 gave `pac` and `sam` theirs. For every other panel, the
  // VALUE this map actually projects with is BASEMAP_FITS's -- the one the coastline was
  // baked against -- never a fit re-derived from this one page's own arc endpoints. See
  // BASEMAP_FITS's own comment for why the naive `fitPanels([...BASEMAP_FIT_POINTS,
  // ...points])` union is wrong rather than merely different.
  const subjectFits = fitPanels(points);
  const fits = new Map<Panel, PanelFit>();
  for (const panel of subjectFits.keys()) {
    fits.set(panel, BASEMAP_FITS.get(panel) ?? subjectFits.get(panel)!);
  }
  const originRegion = regionOf(origin.lat, normalizeLon(origin.lon));
  // Computed once, up front, from the same predicate the arc loop below uses per-arc
  // (`region !== originRegion`) -- so `describeMap`'s wording and what the arc loop actually
  // draws cannot drift apart the way an independently-derived count could.
  const crossPanelCount = drawn.filter(
    (a) => regionOf(a.lat, normalizeLon(a.lon)) !== originRegion,
  ).length;

  let body = "";

  // Inset frames -- only for panels with at least one point in them (`fits` is keyed
  // exactly on `subjectFits`'s panels; see albers.ts's fitPanels), and `us` is never framed.
  for (const { panel, label } of INSETS) {
    if (!fits.has(panel)) continue;
    const [x0, y0, x1, y1] = INSET_RECTS[panel];
    body += `<rect x="${x0 - 6}" y="${y0 - 6}" width="${x1 - x0 + 12}" height="${y1 - y0 + 12}" fill="none" stroke="var(--rule-2)" style="stroke-width:1"/>`;
    body += `<text x="${x0 - 4}" y="${y0 + 6}" font-size="8" letter-spacing="0.1em" fill="var(--ink-3)">${esc(label)}</text>`;
  }

  // The basemap is an injected input, never an import -- Task 7 supplies it. Rendered
  // beneath the arcs, and omitted entirely (no wrapper, no empty group) when absent.
  if (input.basemapPaths) {
    body += input.basemapPaths;
  }

  const maxSeats = drawn.length === 0 ? 0 : Math.max(...drawn.map((a) => a.seats));

  // Arcs, thinnest first so heavy ones sit on top.
  for (const a of arcOrder(drawn)) {
    const region = regionOf(a.lat, normalizeLon(a.lon));
    const crossPanel = region !== originRegion;
    const originXY = project(origin.lat, origin.lon, fits);
    const destXY = project(a.lat, a.lon, fits);

    let path: [number, number][];
    if (crossPanel) {
      // A great circle cannot cross a panel boundary -- the projection is discontinuous
      // there -- so this is drawn as a straight line across the boundary instead (system.md).
      path = [originXY, destXY];
    } else {
      const steps = stepsFor(Math.hypot(destXY[0] - originXY[0], destXY[1] - originXY[1]));
      path = greatCircle(
        { lat: origin.lat, lon: origin.lon },
        { lat: a.lat, lon: a.lon },
        steps,
      ).map((p) => project(p.lat, p.lon, fits));
    }

    const pts = path.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
    const s = strokeFor(a, maxSeats);
    // `stroke-dasharray` omitted entirely when `s.dash` is empty (the solid, above-both-floors
    // case -- most arcs) rather than emitted as `stroke-dasharray=""`. Browsers treat the empty
    // attribute as "no dashing," identically to its absence, so this was never a rendering bug
    // -- but it is invalid SVG, and it cost ~5 KB of no-op attribute bytes on `/airport/ORD`'s
    // 267 polylines (final whole-branch review, Minor finding).
    const dashAttr = s.dash === "" ? "" : ` stroke-dasharray="${s.dash}"`;
    body += `<polyline points="${pts}" fill="none" stroke="${s.stroke}" stroke-width="${s.width.toFixed(2)}"${dashAttr} stroke-opacity="${s.opacity}" stroke-linecap="round"/>`;
  }

  // Destination nodes, then labels for the top 8 by seats.
  const topCodes = new Set(
    [...drawn]
      .sort((a, b) => b.seats - a.seats || a.code.localeCompare(b.code))
      .slice(0, TOP_LABEL_COUNT)
      .map((a) => a.code),
  );
  for (const a of drawn) {
    const [x, y] = project(a.lat, a.lon, fits);
    const belowFloor = a.departures < DEPARTURE_FLOOR;
    body += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${belowFloor ? 1.3 : 2}" fill="${belowFloor ? "var(--ink-3)" : "var(--ink)"}"/>`;
    if (topCodes.has(a.code)) {
      body += `<text x="${fmt(x + 5)}" y="${fmt(y + 3)}" font-size="9" font-weight="600" fill="var(--ink)">${esc(a.code)}</text>`;
    }
  }

  // Origin marker: a field-coloured disc ringed in the signal colour, the one departure from
  // the ink/ink-3 palette every other mark on the map uses -- this is the subject, not a
  // destination.
  const [ox, oy] = project(origin.lat, origin.lon, fits);
  body += `<circle cx="${fmt(ox)}" cy="${fmt(oy)}" r="4.5" fill="var(--field)" stroke="var(--signal)" style="stroke-width:1.8"/>`;
  body += `<text x="${fmt(ox - 7)}" y="${fmt(oy - 8)}" text-anchor="end" font-size="11" font-weight="600" fill="var(--signal)">${esc(origin.code)}</text>`;

  // Window line + the excluded-seats note -- stated on the map itself, not only in the
  // aria-label, so a sighted reader also sees why the arc count and the stat strip's own
  // seat total do not visibly match. sameAirportSeats stays in the STATED total even though
  // its rows never become arcs; see NetworkMapInput's own doc for why both halves are
  // required.
  const note = sameAirportNote(input.sameAirportSeats);
  const noteSuffix = note === null ? "" : ` · ${note}`;
  body += `<text x="8" y="${HEIGHT - 6}" font-size="10" fill="var(--ink-2)">${esc(input.window)}${esc(noteSuffix)}</text>`;

  const ariaLabel = describeMap(input, drawn, crossPanelCount);

  return (
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" ` +
    `role="img" aria-label="${esc(ariaLabel)}" ` +
    `style="font-family:var(--font-mono);font-variant-numeric:tabular-nums" ` +
    `xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  );
}
