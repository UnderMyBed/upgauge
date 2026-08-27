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
  quarantinedNote,
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
  /** Undirected route pairs touching this airport whose every filing in the window was
   * QUARANTINED, so their measure sums are NULL rather than 0 (#114).
   *
   * NULL IS NOT ZERO, and that is the whole reason this field exists. Every measure in
   * `meta_pivot_measures` is `SUM(x) FILTER (WHERE NOT is_quarantined)`, and a SUM over zero
   * passing rows returns NULL -- "nothing here can be trusted", never "nothing flew". Before
   * #114 `airportNetwork.ts` coerced that NULL with `?? 0` and DREW the pair as an ordinary
   * arc reading 0 seats and 0 departures, below `DEPARTURE_FLOOR`, dotted and muted: a
   * positive claim of "barely flown" about a pair the data cannot describe. Measured over the
   * trailing 12 (2025-06..2026-05): 11 such pairs, EVERY one of which performed a departure
   * before quarantine (`zero_seats` -- a passenger aircraft flew and filed zero seats), so the
   * drawn "0 departures" was not merely unknowable, it was contradicted by the filing.
   *
   * A same-airport pair is NOT counted here -- it is not a route pair, whatever its quarantine
   * state, and `airportNetwork.ts` takes that branch first for the reason #105 measured on the
   * point-to-point map. `VEE` is the one airport where the two branch orders disagree.
   *
   * OPTIONAL, where `SegmentMapInput.quarantinedRoutes` is REQUIRED, and the asymmetry is a
   * deliberate trade rather than a disagreement. Required is the stronger contract: a producer
   * that omits an optional field compiles, renders, and silently drops the disclosure. What
   * buys it back here is that this interface has exactly ONE producer -- `fetchAirportNetwork`
   * -- and the binding is enforced by live tests against the warehouse rather than by the
   * compiler (`airportNetwork.test.ts`: BTT counts 1, A18 keeps its map with zero arcs). The
   * literal that forced the choice is `networkGolden.fixture.ts`, #104's byte-identity guard:
   * a required field would edit that fixture, and absent-means-no-disclosure is what keeps
   * `GOLDEN_NETWORK_SVG` byte-identical.
   *
   * Undefined and 0 are the same answer -- nothing to disclose -- and both must render byte
   * for byte identically, which `renderNetworkMap`'s own tests pin. */
  quarantinedRoutes?: number;
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
 * copy of that filter lives in `drawableSegments`.
 *
 * Module-private: `renderNetworkMap` is its only caller. `networkPanels` deliberately does not
 * use it (see its own doc), and nothing outside this file has a `NetworkMapInput` to adapt.
 */
function networkSegments(input: NetworkMapInput): SegmentDatum[] {
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
 * not simply `reachedPanelsFor` over this network's segments.
 *
 * A network with no drawable arc still draws its origin disc, and such a network adapts to no
 * segments at all, so routing this through the segment helper would return no panels and
 * silently drop the coastline out from under that disc. `NetworkMap.test.tsx`'s zero-arc case
 * is exactly that input. Both paths share `panelsFor`, so they cannot disagree about how a
 * point maps to a panel; they differ only in which points count.
 *
 * A hub self-arc carries the ORIGIN's own coordinates, so including it here can only re-add a
 * panel the origin already put in the set -- which is why the hub map never had the unframed-
 * coastline defect `reachedPanelsFor` had to be narrowed to fix.
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
    // QUARANTINE BEFORE SAME-AIRPORT, matching `disclosureNotes`'s own order on the
    // point-to-point map, so the two maps describe the same two facts in the same sequence.
    // This is an ORDERING property and its test asserts the ordering: an assertion that the
    // label merely CONTAINS both sentences passes under either arrangement, which is the
    // failure mode CLAUDE.md records four times over.
    ...networkDisclosureNotes(input),
    sameAirportNote(input.sameAirportSeats, "included"),
  ]
    .filter((s): s is string => s !== null)
    .join(" ");
}

/**
 * The disclosures this map states in prose, in the order they are stated.
 *
 * RENDERED TWICE, BY TWO DIFFERENT SURFACES, FROM THIS ONE ARRAY: `describeMap` folds it into
 * the SVG's `aria-label`, and `NetworkMap.tsx` renders it as HTML beneath the map. That is the
 * shape `SegmentMap.tsx` and `disclosureNotes` already have, and it exists because the
 * alternative shipped once: a map more honest to a screen reader than to the person looking at
 * it. A component that omits these renders a map that lies by omission.
 *
 * NOT PAINTED INTO THE SVG, and that is measured rather than stylistic. The hub map's footer is
 * ONE line against a ~158-character budget (`SegmentMapInput.window`), of which the window and
 * `sameAirportNote` already take up to 121 at a 7-digit seat count; this sentence is 69 more at
 * a single route, so joining it there clips at the frame edge with nothing in the markup
 * recording that it happened. `disclosureNotes`'s docstring carries the same measurement for
 * the point-to-point map and states the rule this follows: prose that grows with the NUMBER of
 * disclosures does not go in the SVG. The hub map paints `sameAirportNote` and only that -- one
 * sentence, bounded -- which is why that one stays where /airport has shipped it since M7.
 *
 * `sameAirportNote` is deliberately NOT in this array: it is already painted on the map face,
 * and returning it here would state it twice on one page.
 */
export function networkDisclosureNotes(input: NetworkMapInput): string[] {
  // `?? 0` on a COUNT, never on a measure: an absent field means "this producer has nothing to
  // disclose", which is a real zero. The coercion #114 exists to remove is the one applied to a
  // SUM that came back NULL, where zero is a claim the data does not support.
  return [quarantinedNote(input.quarantinedRoutes ?? 0)].filter((s): s is string => s !== null);
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
  const note = sameAirportNote(input.sameAirportSeats, "included");

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
