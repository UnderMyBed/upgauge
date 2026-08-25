/**
 * The hub-and-spoke map: one origin airport and its destinations, as served by `/airport`.
 *
 * Since #104 this file owns no geometry. `segmentMap.ts`'s `renderMapCore` draws every mark on
 * every map in this project; this module's whole job is to adapt origin-and-spokes into
 * segments and to supply the policy that is genuinely hub-shaped -- the origin disc, the
 * same-airport disclosure, per-arc label ranking, and node emission in the CALLER's order.
 *
 * That last one is preserved rather than fixed, deliberately. `/airport`'s rendered bytes must
 * not move (`networkGolden.fixture.ts`), and they are a function of the array `runPivot`
 * returns -- whose SQL sorts `seats DESC` with no tiebreak column. Imposing an order here would
 * be a real improvement and a real byte change; the fix belongs upstream, at the query.
 *
 * Contract: `docs/design/system.md` § The map § Arc encoding.
 */

import type { GeoPoint, Panel } from "./albers";
import { DEPARTURE_FLOOR, type ArcDatum } from "./arcs";
import type { NodeMark, SegmentDatum } from "./segmentMap";
import {
  arcsSentence,
  crossPanelCount,
  drawableSegments,
  panelsFor,
  renderMapCore,
  sameAirportNote,
  segmentOrder,
  TOP_LABEL_COUNT,
} from "./segmentMap";

export interface NetworkMapInput {
  origin: ArcDatum;
  arcs: ArcDatum[];
  window: string;
  /** Seats from rows whose origin and destination are the same airport as `origin.code`
   * (359 of 1,047 fact-present airports carry at least one; ORD alone is 53 rows / 76,236
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
   * different matter and IS imported (`segmentMap.ts`'s `BASEMAP_FITS`) -- reusing it verbatim
   * is what keeps this markup and the arcs drawn over it in the same reference frame. Rendered
   * beneath the arcs when present; omitted entirely -- no empty `<g>`, no comment -- when
   * absent. */
  basemapPaths?: string;
}

/**
 * Origin-and-spokes as segments: every arc becomes a segment from the origin to that arc's own
 * endpoint. A faithful 1:1 mapping -- same-airport rows are NOT filtered here, because the one
 * copy of that filter lives in `drawableSegments`, and because `networkPanels` below needs the
 * unfiltered set.
 *
 * Exported so that the component and the renderer adapt a network exactly the same way; two
 * independently-written adapters is how the panels a page requests a coastline for drift from
 * the panels it actually draws marks in.
 */
export function networkSegments(input: NetworkMapInput): SegmentDatum[] {
  const from = { code: input.origin.code, lat: input.origin.lat, lon: input.origin.lon };
  return input.arcs.map((a) => ({
    from,
    to: { code: a.code, lat: a.lat, lon: a.lon },
    seats: a.seats,
    departures: a.departures,
    loadFactor: a.loadFactor,
  }));
}

/**
 * Every panel a hub network's own points land in -- the ORIGIN INCLUDED, which is why this is
 * not simply `reachedPanelsFor(networkSegments(input))`.
 *
 * A network with no drawable arc still draws its origin disc, and `networkSegments` of such an
 * input is empty, so routing this through the segment helper would return no panels at all and
 * silently drop the coastline out from under that disc. `NetworkMap.test.tsx`'s zero-arc case
 * is exactly that input. Both paths share `panelsFor`, so they cannot disagree about how a
 * point maps to a panel; they differ only in which points count.
 */
export function networkPanels(input: NetworkMapInput): Panel[] {
  const points: GeoPoint[] = [input.origin, ...input.arcs].map((p) => ({ lat: p.lat, lon: p.lon }));
  return panelsFor(points);
}

/** What the map shows, for a reader who cannot see it -- the subject, the window, how many
 * destinations are drawn, and the same-airport seats excluded from the arcs but not the total.
 * Mirrors `AircraftMixChart.tsx`'s `describe()`: written once, read by both the visible key and
 * `aria-label`, so the two cannot drift. The arcs sentence itself is `arcsSentence`, shared
 * with the point-to-point map, which differs only in calling them routes rather than
 * destinations. */
function describeMap(input: NetworkMapInput, drawn: number, crossPanel: number): string {
  return [
    `Network map of ${input.origin.code}'s scheduled service, ${input.window}.`,
    arcsSentence(drawn, crossPanel, "destination"),
    sameAirportNote(input.sameAirportSeats),
  ]
    .filter((s): s is string => s !== null)
    .join(" ");
}

/**
 * Renders the complete network map for one origin airport as an `<svg>…</svg>` string.
 */
export function renderNetworkMap(input: NetworkMapInput): string {
  // Same-airport rows are excluded HERE, from the drawn set -- never upstream, and never by
  // relying on the caller to have already filtered. Their seats are NOT dropped, only the
  // polyline, which is why `sameAirportSeats` is a separate field the caller supplies rather
  // than something derivable from `arcs` after this filter runs.
  const drawn = drawableSegments(networkSegments(input));

  // Node marks in the caller's own array order, one per arc and NOT deduped by code -- see this
  // file's header for why that is preserved rather than fixed.
  const nodes: NodeMark[] = drawn.map((s) => ({
    code: s.to.code,
    lat: s.to.lat,
    lon: s.to.lon,
    belowFloor: s.departures < DEPARTURE_FLOOR,
  }));

  // Labels rank by ARC seats. On a hub each destination has exactly one arc, so this is the
  // same answer `renderSegmentMap`'s per-airport ranking would give; the two are separate
  // because that equivalence holds only on a hub (segmentMap.ts's TOP_LABEL_COUNT).
  const labelled = new Set(
    [...drawn]
      .sort((a, b) => b.seats - a.seats || a.to.code.localeCompare(b.to.code))
      .slice(0, TOP_LABEL_COUNT)
      .map((s) => s.to.code),
  );

  // The origin seeds the fit even when nothing else does -- its disc is drawn regardless.
  const points: GeoPoint[] = [
    { lat: input.origin.lat, lon: input.origin.lon },
    ...drawn.map((s) => ({ lat: s.to.lat, lon: s.to.lon })),
  ];

  const lines = segmentOrder(drawn);
  const note = sameAirportNote(input.sameAirportSeats);

  return renderMapCore({
    lines,
    points,
    nodes,
    labelled,
    marker: input.origin,
    footerLines: [{ text: [input.window, note].filter((s): s is string => s !== null).join(" · ") }],
    ariaLabel: describeMap(input, drawn.length, crossPanelCount(lines)),
    basemapPaths: input.basemapPaths,
  });
}
