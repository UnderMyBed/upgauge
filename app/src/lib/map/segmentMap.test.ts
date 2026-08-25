import { describe, expect, it } from "vitest";
import {
  NETWORK_ARC_CAP,
  reachedPanelsFor,
  renderSegmentMap,
  TOP_LABEL_COUNT,
  type SegmentDatum,
  type SegmentMapInput,
} from "./segmentMap";

/** Real coordinates throughout, per this engine's brief -- a synthetic grid would make the
 * geometry assertions (panel membership, cross-panel straight lines, fit reuse) vacuous. */
const COORDS = {
  SEA: { lat: 47.45, lon: -122.31 },
  PDX: { lat: 45.59, lon: -122.6 },
  SFO: { lat: 37.62, lon: -122.38 },
  LAX: { lat: 33.94, lon: -118.41 },
  DEN: { lat: 39.86, lon: -104.67 },
  ORD: { lat: 41.98, lon: -87.9 },
  JFK: { lat: 40.64, lon: -73.78 },
  MIA: { lat: 25.79, lon: -80.29 },
  ATL: { lat: 33.64, lon: -84.43 },
  ANC: { lat: 61.17, lon: -149.99 },
  HNL: { lat: 21.32, lon: -157.92 },
  SJU: { lat: 18.44, lon: -66.0 },
  // The two fact-present airports east of the antimeridian that this engine must normalize:
  // GUM (Guam) and SYA (Eareckson AS, Shemya, in the western Aleutians).
  GUM: { lat: 13.48, lon: 144.8 },
  SYA: { lat: 52.71, lon: 174.11 },
} as const;

type Code = keyof typeof COORDS;

function node(code: Code) {
  return { code, ...COORDS[code] };
}

function seg(
  from: Code,
  to: Code,
  overrides: Partial<Omit<SegmentDatum, "from" | "to">> = {},
): SegmentDatum {
  return {
    from: node(from),
    to: node(to),
    seats: 100_000,
    departures: 200,
    loadFactor: 0.85,
    ...overrides,
  };
}

/** A valid input wherever a test needs one but does not care about its specifics. `drawnRoutes`
 * equals `totalRoutes`, so no disclosure line is rendered. */
function input(segments: SegmentDatum[], overrides: Partial<SegmentMapInput> = {}): SegmentMapInput {
  return {
    segments,
    window: "2025-06 → 2026-05",
    drawnRoutes: segments.length,
    totalRoutes: segments.length,
    ...overrides,
  };
}

/** Label text in DOCUMENT ORDER. Node labels are emitted immediately after their own circle, so
 * this is the node emission sequence, not a set. */
function labelsInOrder(svg: string): string[] {
  return [...svg.matchAll(/font-size="9" font-weight="600" fill="var\(--ink\)">([^<]+)</g)].map(
    (m) => m[1],
  );
}

/** The circle mark drawn immediately before a given airport's label -- `[r, fill]`. */
function nodeMark(svg: string, code: string): [string, string] {
  const re = new RegExp(
    `<circle cx="[\\d.-]+" cy="[\\d.-]+" r="([\\d.]+)" fill="([^"]+)"/><text[^>]*>${code}<`,
  );
  const m = svg.match(re);
  if (m === null) throw new Error(`no labelled node mark for ${code}`);
  return [m[1], m[2]];
}

/** A labelled airport's projected label position. */
function labelXY(svg: string, code: string): [string, string] {
  const re = new RegExp(
    `<text x="([\\d.-]+)" y="([\\d.-]+)" font-size="9" font-weight="600" fill="var\\(--ink\\)">${code}<`,
  );
  const m = svg.match(re);
  if (m === null) throw new Error(`no label for ${code}`);
  return [m[1], m[2]];
}

function visibleText(svg: string): string {
  return svg.replace(/aria-label="[^"]*"/, "");
}

function ariaLabel(svg: string): string {
  return svg.match(/aria-label="([^"]*)"/)![1];
}

describe("renderSegmentMap", () => {
  it("draws thin arcs before heavy ones", () => {
    // Catches: dropping segmentOrder's sort. This is an ORDERING property, so asserting the
    // SET of stroke widths passes under the bug -- only document order catches it. M4c learned
    // this the hard way: reversing a stack still emits six paths with six correct fills.
    const svg = renderSegmentMap(
      input([
        seg("SEA", "PDX", { seats: 9_000 }),
        seg("ORD", "JFK", { seats: 100 }),
        seg("DEN", "LAX", { seats: 400 }),
      ]),
    );
    const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it("renders the same bytes whatever order the segments arrive in", () => {
    // The whole render is a pure function of the segment SET, never of the array -- which is
    // what the HUB map cannot claim: its bytes follow `runPivot`'s array, and that array comes
    // from an `ORDER BY seats DESC` with no tiebreak column, so two runs over the same data can
    // legitimately differ. Shuffling the segments here must not move a single byte.
    //
    // Mutant that kills this: drop `segmentOrder`'s sort (verified red). It is NOT killed by
    // dropping the NODE sort, and that is a property of the design rather than a gap: node
    // emission is derived from the already-ordered LINE list, so it is order-independent by
    // construction and no node-sort bug can reintroduce array-order dependence. What dropping
    // the node sort actually changes is the RANKING KEY, which the next test pins.
    const segments = [
      seg("SEA", "PDX", { seats: 100 }),
      seg("ORD", "JFK", { seats: 900 }),
      seg("SEA", "ORD", { seats: 50 }),
    ];
    const forward = renderSegmentMap(input(segments));
    const reversed = renderSegmentMap(input([...segments].reverse()));
    expect(reversed).toBe(forward);
  });

  it("orders nodes ascending by SUMMED seats, so the busiest airport's label paints last", () => {
    // Catches: dropping the node sort. Without it, nodes come out in order of first appearance
    // in the ARC draw order -- still deterministic, so shuffle-invariance above stays green,
    // and only a positional assertion sees it (verified: the mutant yields SEA, ORD, PDX, JFK).
    // Asserted as an ordering rather than as a set, and the set is identical either way.
    // Summed: PDX 100, SEA 150, JFK 900, ORD 950.
    const svg = renderSegmentMap(
      input([
        seg("SEA", "PDX", { seats: 100 }),
        seg("ORD", "JFK", { seats: 900 }),
        seg("SEA", "ORD", { seats: 50 }),
      ]),
    );
    expect(labelsInOrder(svg)).toEqual(["PDX", "SEA", "JFK", "ORD"]);
  });

  it("ranks labels by AIRPORT summed seats, not by the heaviest single arc", () => {
    // Catches: carrying the hub map's per-ARC label ranking into the point-to-point map. On a
    // hub the two coincide (one arc per destination); here they must not.
    //
    // Nine airports against TOP_LABEL_COUNT = 8, so exactly one goes unlabelled. ATL has three
    // 10-seat segments (30 summed); MIA has one 20-seat segment (20 summed). By AIRPORT, ATL
    // outranks MIA and MIA is the one cut. By ARC, MIA's single 20 outranks every one of ATL's
    // 10s, and MIA would be labelled instead.
    const svg = renderSegmentMap(
      input([
        seg("SEA", "PDX", { seats: 1_000 }),
        seg("PDX", "SFO", { seats: 1_000 }),
        seg("SFO", "LAX", { seats: 1_000 }),
        seg("LAX", "DEN", { seats: 1_000 }),
        seg("DEN", "ORD", { seats: 1_000 }),
        seg("ORD", "JFK", { seats: 1_000 }),
        seg("ATL", "SEA", { seats: 10 }),
        seg("ATL", "PDX", { seats: 10 }),
        seg("ATL", "SFO", { seats: 10 }),
        seg("MIA", "JFK", { seats: 20 }),
      ]),
    );
    const labels = labelsInOrder(svg);
    expect(labels).toHaveLength(TOP_LABEL_COUNT);
    expect(labels).toContain("ATL");
    expect(labels).not.toContain("MIA");
  });

  it("marks a node below the departure floor on its SUMMED incident departures", () => {
    // Catches: reading one segment's departures as if it were the airport's. SEA carries two
    // 20-departure segments -- each individually below DEPARTURE_FLOOR (30), together 40, which
    // is not. The ARCS stay dotted (that encoding is per-arc and unchanged); the NODE must not.
    const svg = renderSegmentMap(
      input([
        seg("SEA", "PDX", { departures: 20 }),
        seg("SEA", "ORD", { departures: 20 }),
      ]),
    );
    expect(nodeMark(svg, "SEA")).toEqual(["2", "var(--ink)"]);
    expect(nodeMark(svg, "PDX")).toEqual(["1.3", "var(--ink-3)"]);
    expect(svg).toContain('stroke-dasharray="1 3"');
  });

  it("reuses the baked basemap fit and never unions subject points into it", () => {
    // THE defect M7 Task 8 fixed, carried forward into the point-to-point engine: fitting each
    // panel to the SUBJECT's own points is a different fit than the one the committed coastline
    // was baked with, so every arc is drawn against a landmass at a different scale.
    //
    // A GEOMETRY assertion, not a presence one. SYA (+174.11, normalizing to -185.89) sits far
    // west of Alaska's own basemap extent, so unioning it in would change `k` for the `ak`
    // panel and move ANC. Both airports are in `ak`, which is what makes this test able to
    // fail -- a fit is per-panel, so an added `ak` point cannot move a `us` one either way.
    const narrow = renderSegmentMap(input([seg("SEA", "ANC")]));
    const wide = renderSegmentMap(input([seg("SEA", "ANC"), seg("SEA", "SYA")]));
    expect(labelXY(wide, "ANC")).toEqual(labelXY(narrow, "ANC"));
  });

  it("draws a cross-panel segment as a straight line even when NEITHER end is conterminous", () => {
    // A great circle cannot cross a panel boundary -- the projection is discontinuous there.
    // HNL -> ANC crosses from `hi` to `ak`, a pair the hub renderer could never produce: it
    // compared every destination against ONE origin region, so a boundary between two insets
    // was unreachable. Two points, not an interpolated path.
    const svg = renderSegmentMap(input([seg("HNL", "ANC")]));
    const points = svg.match(/points="([^"]+)"/)![1].trim().split(/\s+/);
    expect(points).toHaveLength(2);
  });

  it("normalizes longitude before the cross-panel test, not only before projecting", () => {
    // Catches: dropping normalizeLon from `panelOf`. `project` normalizes internally, so an
    // un-normalized cross-panel TEST still puts the mark in the right place -- it just decides
    // the wrong thing about the boundary. SYA (+174.11) fails `lon < -129` raw and files as
    // conterminous, same panel as SEA, so its straight line silently becomes a great circle
    // interpolated across a discontinuity. Asserting the point COUNT is what sees that; nothing
    // about the arc's presence or its stroke does.
    const svg = renderSegmentMap(input([seg("SEA", "SYA")]));
    const points = svg.match(/points="([^"]+)"/)![1].trim().split(/\s+/);
    expect(points).toHaveLength(2);
  });

  it("excludes a self-segment entirely, drawing neither an arc nor a node for it", () => {
    // Catches: drawing a zero-length arc. greatCircle's degenerate branch emits `steps + 1`
    // identical points -- several hundred bytes drawing an invisible mark.
    const svg = renderSegmentMap(input([seg("SEA", "PDX"), seg("ORD", "ORD")]));
    expect(svg.match(/<polyline/g) ?? []).toHaveLength(1);
    expect(labelsInOrder(svg)).toEqual(["PDX", "SEA"]);
  });

  it("draws no subject marker -- a point-to-point map has no hub", () => {
    const svg = renderSegmentMap(input([seg("SEA", "PDX")]));
    expect(svg).not.toContain('r="4.5"');
    expect(svg).not.toContain("var(--signal)");
  });

  it("states a capped view's true total, on the map itself and not only in the aria-label", () => {
    // Catches: capping silently. `NetworkMapInput` has no field for this at all, which is why
    // /airport can truncate with no on-page disclosure; the point-to-point maps must not.
    const svg = renderSegmentMap(
      input([seg("SEA", "PDX")], { drawnRoutes: 400, totalRoutes: 1_622 }),
    );
    expect(visibleText(svg)).toContain("400 of 1,622 routes drawn.");
    expect(ariaLabel(svg)).toContain("400 of 1,622 routes drawn.");
  });

  it("renders no disclosure line when nothing was capped", () => {
    const svg = renderSegmentMap(input([seg("SEA", "PDX")], { drawnRoutes: 1, totalRoutes: 1 }));
    expect(svg).not.toContain("routes drawn.");
  });

  it("states same-airport seats it excluded, on the map itself and not only in the aria-label", () => {
    // The honesty property the hub map already had. A first version of the equivalent test on
    // networkMap.ts asserted over the WHOLE string and missed a mutant that zeroed the number
    // only in the visible note -- the aria-label carries the same figure, so the substring was
    // still present. Stripping aria-label first is what makes this a pin on the visible text.
    const svg = renderSegmentMap(
      input([seg("SEA", "PDX")], { sameAirportSeats: 598_829 }),
    );
    expect(visibleText(svg)).toContain("598,829 same-airport seats");
    expect(ariaLabel(svg)).toContain("598,829 same-airport seats");
  });

  it("does not claim same-airport seats are 'in this total' -- no total here carries them", () => {
    // Catches: reusing the HUB map's tail verbatim. On /airport "this total" is the stat strip's
    // SEATS figure, which does carry them. This map's only totals are `drawnRoutes` /
    // `totalRoutes`, which are ROUTE counts that deliberately exclude same-airport pairs -- so
    // the hub wording points at a total that neither exists on the map face nor contains these
    // seats. The falsifying pair is in networkMap.test.ts: the hub must still say it.
    const svg = renderSegmentMap(
      input([seg("SEA", "PDX")], { sameAirportSeats: 598_829, drawnRoutes: 400, totalRoutes: 519 }),
    );
    expect(svg).not.toContain("included in this total");
    expect(visibleText(svg)).toContain(
      "598,829 same-airport seats excluded from the arcs above, and from the route counts.",
    );
  });

  it("discloses quarantined routes with a count and a reason, not just an absence", () => {
    // Catches: dropping a group whose every filing was quarantined. It is not an arc and not a
    // row in any count, so without this sentence it leaves NO trace -- and two views end up with
    // no map at all for a reason the reader never sees. Measured: 34 such groups over the
    // trailing 12, every one of which performed departures (quarantined `zero_seats`).
    // CLAUDE.md requires count + reason; "never clamped" is the reason the count exists.
    const svg = renderSegmentMap(input([seg("SEA", "PDX")], { quarantinedRoutes: 34 }));
    expect(visibleText(svg)).toContain(
      "34 quarantined routes not drawn — failed an invariant, never clamped.",
    );
    expect(ariaLabel(svg)).toContain("34 quarantined routes not drawn");

    const one = renderSegmentMap(input([seg("SEA", "PDX")], { quarantinedRoutes: 1 }));
    expect(visibleText(one)).toContain("1 quarantined route not drawn");
  });

  it("says nothing about quarantine when there is none", () => {
    expect(renderSegmentMap(input([seg("SEA", "PDX")]))).not.toContain("quarantined");
    expect(
      renderSegmentMap(input([seg("SEA", "PDX")], { quarantinedRoutes: 0 })),
    ).not.toContain("quarantined");
  });

  it("orders the three disclosures widest-claim-first, and states each exactly once", () => {
    // All three at once -- the footer and the aria-label must agree, and neither may state a
    // sentence twice. Asserted as one whole string rather than three `toContain`s, because
    // three independent substring checks pass under any ordering.
    const svg = renderSegmentMap(
      input([seg("SEA", "PDX")], {
        drawnRoutes: 400,
        totalRoutes: 519,
        quarantinedRoutes: 34,
        sameAirportSeats: 598_829,
      }),
    );
    const expected =
      "2025-06 → 2026-05 · 400 of 519 routes drawn. · " +
      "34 quarantined routes not drawn — failed an invariant, never clamped. · " +
      "598,829 same-airport seats excluded from the arcs above, and from the route counts.";
    expect(visibleText(svg)).toContain(`>${expected}</text>`);
    expect(ariaLabel(svg)).toBe(
      "Route map, 2025-06 → 2026-05. 1 route drawn as great-circle arcs, thinnest to heaviest by seats. " +
        "400 of 519 routes drawn. " +
        "34 quarantined routes not drawn — failed an invariant, never clamped. " +
        "598,829 same-airport seats excluded from the arcs above, and from the route counts.",
    );
  });

  it("omits the same-airport sentence entirely when there are none", () => {
    const svg = renderSegmentMap(input([seg("SEA", "PDX")]));
    expect(svg).not.toContain("same-airport seats");
  });

  it("stacks an optional caption under the window line, keeping the window where it always sat", () => {
    // The caption names WHICH map you are looking at (the diff map's three panels are otherwise
    // identical chrome), so it outranks the window note rather than sitting beside it in the
    // same muted weight. Without a caption the window line must stay on the canvas floor,
    // exactly where every map has always put it.
    const plain = renderSegmentMap(input([seg("SEA", "PDX")]));
    expect(plain).toContain('<text x="8" y="494" font-size="10" fill="var(--ink-2)">');

    const captioned = renderSegmentMap(input([seg("SEA", "PDX")], { title: "Added" }));
    expect(captioned).toContain('<text x="8" y="482" font-size="10" fill="var(--ink-2)">');
    expect(captioned).toContain(
      '<text x="8" y="494" font-size="10" font-weight="600" fill="var(--ink)">Added</text>',
    );
    expect(ariaLabel(captioned)).toContain("Added. Route map,");
  });

  it("calls them routes, not destinations, and names the boundary crossings", () => {
    // The hub map's noun is wrong here: it draws one arc per DESTINATION of one subject, this
    // draws one per ROUTE and has no subject. A falsifiable pair -- the all-conterminous case
    // must still say "great-circle arcs" plainly.
    const flat = renderSegmentMap(input([seg("SEA", "PDX"), seg("ORD", "JFK")]));
    expect(ariaLabel(flat)).toContain("2 routes drawn as great-circle arcs");
    expect(ariaLabel(flat)).not.toContain("straight line");
    expect(ariaLabel(flat)).not.toContain("destination");

    const crossing = renderSegmentMap(input([seg("SEA", "PDX"), seg("HNL", "ANC")]));
    expect(ariaLabel(crossing)).toContain(
      "2 routes drawn thinnest to heaviest by seats -- 1 as great-circle arcs, 1 as straight lines across a panel boundary",
    );
  });

  it("frames only the insets its own segments reach, and labels every one it frames", () => {
    const conterminous = renderSegmentMap(input([seg("SEA", "PDX")]));
    expect(conterminous).not.toContain("ALASKA");
    expect(conterminous).not.toContain("HAWAI");
    expect(conterminous).not.toContain("PACIFIC");
    expect(conterminous).not.toContain("CARIBBEAN");

    const reaching = renderSegmentMap(input([seg("SEA", "HNL"), seg("JFK", "SJU")]));
    expect(reaching).toContain("HAWAI");
    expect(reaching).toContain("CARIBBEAN");
    expect(reaching).not.toContain("ALASKA");
  });

  it("carries the arc encoding through unchanged", () => {
    const dashed = renderSegmentMap(input([seg("SEA", "PDX", { loadFactor: 0.62 })]));
    expect(dashed).toContain('stroke-dasharray="5 3"');

    const solid = renderSegmentMap(input([seg("SEA", "PDX", { loadFactor: null })]));
    expect(solid).not.toContain("stroke-dasharray");

    const dotted = renderSegmentMap(input([seg("SEA", "PDX", { departures: 12 })]));
    expect(dotted).toContain('stroke-dasharray="1 3"');
    expect(dotted).toContain("var(--ink-3)");
  });

  it("renders the injected basemap when present and omits it when absent", () => {
    const withBasemap = renderSegmentMap(
      input([seg("SEA", "PDX")], { basemapPaths: '<path d="M0 0 L1 1" class="basemap-probe"/>' }),
    );
    expect(withBasemap).toContain("basemap-probe");
    expect(renderSegmentMap(input([seg("SEA", "PDX")]))).not.toContain("basemap-probe");
  });

  it("carries an accessible role and label", () => {
    const svg = renderSegmentMap(input([seg("SEA", "PDX")]));
    expect(svg).toContain('role="img"');
    expect(svg).toMatch(/aria-label="[^"]+"/);
  });

  it("stays a total function on an empty network", () => {
    // The producers return null rather than an empty map, so this is never reached in
    // production -- but a renderer that throws on the served path is a 500, and there is no
    // input this one is entitled to refuse.
    const svg = renderSegmentMap(input([]));
    expect(svg).toContain('role="img"');
    expect(svg.match(/<polyline/g) ?? []).toHaveLength(0);
  });
});

describe("reachedPanelsFor", () => {
  it("normalizes longitude before deciding a panel", () => {
    // Catches: dropping normalizeLon. `regionOf`'s tests are all written in western-hemisphere
    // terms and it does NOT normalize for its caller. Un-normalized, GUM (+144.8) satisfies
    // `lat < 25 && lon > -70` and files as CARIBBEAN, and SYA (+174.11) falls through every
    // test to the conterminous panel 270 degrees from its central meridian.
    expect(reachedPanelsFor([seg("SEA", "GUM")])).toEqual(["us", "pac"]);
    expect(reachedPanelsFor([seg("SEA", "SYA")])).toEqual(["us", "ak"]);
  });

  it("returns panels in albers's own order, whatever order the segments arrive in", () => {
    const forward = reachedPanelsFor([seg("JFK", "SJU"), seg("SEA", "ANC"), seg("SEA", "HNL")]);
    expect(forward).toEqual(["us", "ak", "hi", "car"]);
    expect(reachedPanelsFor([seg("SEA", "HNL"), seg("SEA", "ANC"), seg("JFK", "SJU")])).toEqual(
      forward,
    );
  });

  it("counts a self-segment's airport, which draws no arc but is still in the network", () => {
    expect(reachedPanelsFor([seg("HNL", "HNL")])).toEqual(["hi"]);
  });

  it("returns nothing for an empty network rather than defaulting to a panel", () => {
    expect(reachedPanelsFor([])).toEqual([]);
  });
});

describe("NETWORK_ARC_CAP", () => {
  it("is one shared cap, declared with the engine rather than per map", () => {
    // #105's carrierTypeNetwork.ts re-exports this rather than declaring its own. Two maps of
    // the same network that capped differently would disagree about what "the whole network"
    // is.
    expect(NETWORK_ARC_CAP).toBe(400);
  });
});
