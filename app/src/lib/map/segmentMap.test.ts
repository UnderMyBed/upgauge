import { describe, expect, it } from "vitest";
import {
  disclosureNotes,
  drawableSegments,
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
  // Same-panel partners for ANC and HNL -- the pairs that tell a per-segment cross-panel test
  // apart from one still measuring against a single region.
  FAI: { lat: 64.82, lon: -147.86 },
  OGG: { lat: 20.9, lon: -156.43 },
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

/** A valid input wherever a test needs one but does not care about its specifics. `totalRoutes`
 * matches what will actually be drawn, so no disclosure line is rendered. `sameAirportSeats` and
 * `quarantinedRoutes` are required on the interface on purpose -- a producer that omits one
 * silently drops a disclosure -- so they are stated as an explicit zero here, not defaulted. */
function input(segments: SegmentDatum[], overrides: Partial<SegmentMapInput> = {}): SegmentMapInput {
  return {
    segments,
    window: "2025-06 → 2026-05",
    totalRoutes: drawableSegments(segments).length,
    sameAirportSeats: 0,
    quarantinedRoutes: 0,
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

/** Solid-vs-dashed for each polyline, in DOCUMENT ORDER. Two arcs at identical seats get
 * identical widths, so the dash is the only thing that can tell them apart. */
function dashOrder(svg: string): string[] {
  return [...svg.matchAll(/<polyline[^>]*\/>/g)].map((m) =>
    m[0].includes('stroke-dasharray="5 3"') ? "dashed" : "solid",
  );
}

/** Every `<text>` at font-size 10 and its right edge in px. IBM Plex Mono is monospaced with a
 * single advance width of 600/1000 em (read from the committed
 * app/src/lib/og/fonts/IBMPlexMono-Regular.ttf), so a run's width is exactly
 * `codePoints * 0.6 * fontSize`. `text-anchor="end"` runs leftward, so x IS their right edge. */
function textRightEdges(svg: string): { text: string; right: number }[] {
  return [...svg.matchAll(/<text x="([\d.-]+)"[^>]*font-size="10"([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const text = m[3]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    const x = Number(m[1]);
    const right = m[2].includes('text-anchor="end"') ? x : x + [...text].length * 0.6 * 10;
    return { text, right };
  });
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
    //
    // ON ITS OWN THIS CANNOT DISCRIMINATE, and that is why the next test exists. `HNL -> ANC`
    // is cross-panel under the correct predicate AND under `panelOf(to) !== "us"` AND under a
    // hub-shaped `panelOf(to) !== panelOf(lines[0].from)`, because neither end is `us`. Only
    // the intra-inset case below tells the three apart.
    const svg = renderSegmentMap(input([seg("HNL", "ANC")]));
    const points = svg.match(/points="([^"]+)"/)![1].trim().split(/\s+/);
    expect(points).toHaveLength(2);
  });

  it("draws a great circle between two airports in the SAME non-conterminous panel", () => {
    // Catches the coupling this whole task exists to break: any predicate that still measures a
    // segment against ONE region -- `panelOf(to) !== "us"`, or the literal hub form
    // `panelOf(to) !== panelOf(lines[0].from)` -- rather than against the segment's own two
    // ends. Both mutants pass every other test in this file; both turn these two arcs into
    // 2-point chords, and only a point COUNT on an intra-panel pair sees it.
    //
    // The fixture needs a `us` segment present so the hub-shaped mutant has a conterminous
    // "origin" to measure against; SEA->PDX is lightest, so `segmentOrder` puts it first.
    // Real routes: HNL-OGG (inter-island Hawai'i) and ANC-FAI (Anchorage-Fairbanks) are exactly
    // the shape #105's and #109's maps will draw, and a straight chord where a curve belongs is
    // a geographic lie about both.
    const svg = renderSegmentMap(
      input([
        seg("SEA", "PDX", { seats: 100 }),
        seg("HNL", "OGG", { seats: 500 }),
        seg("ANC", "FAI", { seats: 900 }),
      ]),
    );
    const counts = [...svg.matchAll(/points="([^"]+)"/g)].map(
      (m) => m[1].trim().split(/\s+/).length,
    );
    expect(counts).toHaveLength(3);
    expect(counts[1]).toBeGreaterThan(2); // HNL -> OGG, both `hi`
    expect(counts[2]).toBeGreaterThan(2); // ANC -> FAI, both `ak`
  });

  it("breaks a seats tie by code, on BOTH endpoints, not by array position", () => {
    // F19 measured a seats tie at exactly the 400th row in 31 of the 36 capped views -- DL x
    // type 614 has 164 route pairs all tied at 160.0 seats at the cut. `ORDER BY seats DESC`
    // carries no tiebreak column, so without one here which of them draws on top is whatever
    // order the array arrived in, and that is not reproducible between runs.
    //
    // Equal seats means equal stroke WIDTH, so width cannot tell the two apart -- the dash does.
    // Both halves are asserted separately because dropping only one tiebreak leaves the other
    // covering for it: on the first fixture every `from` is SEA, on the second every `to` is SEA.
    const byTo = renderSegmentMap(
      input([
        seg("SEA", "PDX", { seats: 500, loadFactor: 0.62 }), // dashed, listed first
        seg("SEA", "JFK", { seats: 500, loadFactor: 0.9 }), // solid; JFK < PDX, so draws first
      ]),
    );
    expect(dashOrder(byTo)).toEqual(["solid", "dashed"]);

    const byFrom = renderSegmentMap(
      input([
        seg("PDX", "SEA", { seats: 500, loadFactor: 0.62 }), // dashed, listed first
        seg("JFK", "SEA", { seats: 500, loadFactor: 0.9 }), // solid; JFK < PDX, so draws first
      ]),
    );
    expect(dashOrder(byFrom)).toEqual(["solid", "dashed"]);
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

  it("treats endpoints sharing a display code as one airport -- by CODE, not by id", () => {
    // CHARACTERIZATION, not endorsement. `sameAirport` keys on the display code, which departs
    // from CLAUDE.md's "key on AIRPORT_ID, never letter codes" -- see its comment for why
    // (`GeoNode` carries no id and `NetworkMapInput` is pinned without one), for the
    // measurement that makes it safe today (zero collisions among the 1,047 fact-present
    // airports; `dim_airport` has 20+ overall, `AUS` being both 10423 and 16440), and for what
    // a fact-present collision would cost: a legitimate route between two DISTINCT airports
    // read as a self-segment and dropped.
    //
    // The coordinates below are deliberately unequal and deliberately arbitrary: only the CODE
    // decides the outcome, and that is precisely the property being pinned. If this ever goes
    // red because `GeoNode` gained an id, that is the fix landing rather than a regression --
    // update it deliberately, and update `sameAirport`'s comment with it.
    const ausA = { code: "AUS", lat: 30.19, lon: -97.67 };
    const ausB = { code: "AUS", lat: 30.32, lon: -97.76 };
    const collided: SegmentDatum = {
      from: ausA,
      to: ausB,
      seats: 100,
      departures: 50,
      loadFactor: 0.8,
    };
    expect(drawableSegments([collided])).toEqual([]);

    // ...and the SAME identity governs the node dedupe, so two distinct airports filing one
    // code collapse to ONE dot. This needs two SEPARATE drawable segments, not the collided
    // one above: that segment is filtered before `tallyNodes` ever sees it, so asserting the
    // dedupe on it passes whatever the dedupe does. (Measured -- an earlier version of this
    // assertion did exactly that and survived a mutant that keyed the tally on code+lat.)
    //
    // Summed: SEA 100, PDX 900, AUS 1,000 -> ascending, exactly one AUS. Under a tally keyed
    // on anything finer than the code, AUS splits into a 100 and a 900 and appears twice.
    const twoEnds: SegmentDatum[] = [
      { from: node("SEA"), to: ausA, seats: 100, departures: 50, loadFactor: 0.8 },
      { from: node("PDX"), to: ausB, seats: 900, departures: 50, loadFactor: 0.8 },
    ];
    expect(labelsInOrder(renderSegmentMap(input(twoEnds)))).toEqual(["SEA", "PDX", "AUS"]);
  });

  it("draws no subject marker -- a point-to-point map has no hub", () => {
    const svg = renderSegmentMap(input([seg("SEA", "PDX")]));
    expect(svg).not.toContain('r="4.5"');
    expect(svg).not.toContain("var(--signal)");
  });

  it("hands the capped view's true total to the component, and puts it in the aria-label", () => {
    // The cap disclosure is TEXT the component paints as HTML, not a `<text>` in the raster --
    // see `disclosureNotes` and the footer-budget comment for the measurement that forced that.
    // The `aria-label` carries the identical sentence, the same way AircraftMixChart's gapNote
    // is both an HTML span and part of its accessible description.
    const capped = input([seg("SEA", "PDX")], { totalRoutes: 1_622 });
    expect(disclosureNotes(capped)).toEqual(["1 of 1,622 routes drawn."]);
    expect(ariaLabel(renderSegmentMap(capped))).toContain("1 of 1,622 routes drawn.");
  });

  it("discloses nothing when nothing was capped, quarantined or same-airport", () => {
    const clean = input([seg("SEA", "PDX")], { totalRoutes: 1 });
    expect(disclosureNotes(clean)).toEqual([]);
    expect(renderSegmentMap(clean)).not.toContain("routes drawn.");
  });

  it("says 'route' rather than 'routes' when the total is one", () => {
    // arcsSentence and quarantinedNote both handle N=1; this sentence used to hard-code the
    // plural, so a one-route view read "0 of 1 routes drawn."
    expect(disclosureNotes(input([seg("SEA", "SEA")], { totalRoutes: 1 }))).toEqual([
      "0 of 1 route drawn.",
    ]);
  });

  it("never states two different drawn counts in one aria-label", () => {
    // Catches: taking the drawn count from the caller. `arcsSentence` reports what was actually
    // drawn and the disclosure used to report a caller-supplied `drawnRoutes`, with nothing
    // reconciling them -- so one accessible description could read "2 routes drawn as
    // great-circle arcs ... 3 of 10 routes drawn." That is the compound-claim failure CLAUDE.md
    // records for /watch/new-routes: every clause re-derived, never triaged by how true it
    // sounds.
    //
    // The fixture makes them disagree if anything can: three segments, one of them a
    // self-segment the renderer drops, against a caller total of 10. Both sentences must say 2.
    const label = ariaLabel(
      renderSegmentMap(
        input([seg("SEA", "PDX"), seg("ORD", "JFK"), seg("HNL", "HNL")], { totalRoutes: 10 }),
      ),
    );
    expect(label).toContain("2 routes drawn as great-circle arcs");
    expect(label).toContain("2 of 10 routes drawn.");
    expect(label).not.toContain("3 of 10");
  });

  it("does not claim same-airport seats are 'in this total' -- no total here carries them", () => {
    // Catches: reusing the HUB map's tail verbatim. On /airport "this total" is the stat strip's
    // SEATS figure, which does carry them. This map's only totals are ROUTE counts --
    // `totalRoutes` and what it drew -- and both exclude same-airport pairs, so the hub wording
    // points at a total that neither exists nor contains these seats. The falsifying pair is in
    // networkMap.test.ts: the hub must still say it.
    const svg = renderSegmentMap(
      input([seg("SEA", "PDX")], { sameAirportSeats: 598_829, totalRoutes: 519 }),
    );
    expect(svg).not.toContain("included in this total");
    expect(ariaLabel(svg)).toContain(
      "598,829 same-airport seats excluded from the arcs above, and from the route counts.",
    );
  });

  it("discloses quarantined routes with a count and a reason, not just an absence", () => {
    // Catches: dropping a group whose every filing was quarantined. It is not an arc and not a
    // row in any count, so without this sentence it leaves NO trace -- and two views end up with
    // no map at all for a reason the reader never sees. Measured: 34 such groups over the
    // trailing 12, every one of which performed departures (quarantined `zero_seats`).
    // CLAUDE.md requires count + reason; "never clamped" is the reason the count exists.
    const many = input([seg("SEA", "PDX")], { quarantinedRoutes: 34 });
    expect(disclosureNotes(many)).toEqual([
      "34 quarantined routes not drawn — failed an invariant, never clamped.",
    ]);
    expect(ariaLabel(renderSegmentMap(many))).toContain("34 quarantined routes not drawn");

    expect(disclosureNotes(input([seg("SEA", "PDX")], { quarantinedRoutes: 1 }))[0]).toContain(
      "1 quarantined route not drawn",
    );
  });

  it("says nothing about quarantine when there is none", () => {
    expect(renderSegmentMap(input([seg("SEA", "PDX")]))).not.toContain("quarantined");
    expect(disclosureNotes(input([seg("SEA", "PDX")], { quarantinedRoutes: 0 }))).toEqual([]);
  });

  it("orders the three disclosures widest-claim-first, and states each exactly once", () => {
    // Asserted as one whole ordered array rather than three `toContain`s, because three
    // independent substring checks pass under any ordering.
    const all = input([seg("SEA", "PDX")], {
      totalRoutes: 519,
      quarantinedRoutes: 34,
      sameAirportSeats: 598_829,
    });
    expect(disclosureNotes(all)).toEqual([
      "1 of 519 routes drawn.",
      "34 quarantined routes not drawn — failed an invariant, never clamped.",
      "598,829 same-airport seats excluded from the arcs above, and from the route counts.",
    ]);
    expect(ariaLabel(renderSegmentMap(all))).toBe(
      "Route map, 2025-06 → 2026-05. 1 route drawn as great-circle arcs, thinnest to heaviest by seats. " +
        "1 of 519 routes drawn. " +
        "34 quarantined routes not drawn — failed an invariant, never clamped. " +
        "598,829 same-airport seats excluded from the arcs above, and from the route counts.",
    );
  });

  it("paints NO disclosure prose into the raster, at any combination", () => {
    // THE regression this fix exists to prevent, and it must be asserted as PAINTABILITY rather
    // than presence: `toContain` on markup passes on a string that is present and clipped, which
    // is exactly how the overflow shipped. Every `<text>` at font-size 10 must end inside the
    // 960px viewBox -- an outermost <svg> is `overflow: hidden`, so anything past it is painted
    // outside the viewport at every viewport width.
    //
    // Worst measured real view: `/aircraft/CE-206%2F7`, all three sentences, 1,208px -- 41
    // characters lost at the frame edge while the aria-label carried them all.
    const worst = renderSegmentMap(
      input([seg("SEA", "PDX")], {
        window: "2025-06 → 2026-05",
        title: "Downgauged",
        totalRoutes: 1_622,
        quarantinedRoutes: 34,
        sameAirportSeats: 598_829,
      }),
    );
    for (const { text, right } of textRightEdges(worst)) {
      expect({ text, right, fits: right <= 960 }).toEqual({ text, right, fits: true });
    }
    // ...and the prose genuinely is absent from the PAINTED markup, not merely short enough.
    // Stripped of aria-label first: that attribute is part of the markup and legitimately
    // carries every sentence, so a bare `not.toContain` over the raw string asserts the
    // opposite of what is meant and fails on correct output.
    const painted = visibleText(worst);
    expect(painted).not.toContain("quarantined route");
    expect(painted).not.toContain("same-airport seats");
    expect(painted).not.toContain("routes drawn.");
    // The aria-label still carries all three -- that is the half a screen reader gets.
    expect(ariaLabel(worst)).toContain("quarantined routes not drawn");
  });

  it("omits the same-airport sentence entirely when there are none", () => {
    expect(disclosureNotes(input([seg("SEA", "PDX")]))).toEqual([]);
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
      "2 routes drawn thinnest to heaviest by seats -- 1 as great-circle arc, 1 as straight line across a panel boundary",
    );

    // Live on /airport today: PPG has exactly one drawn route and it is cross-panel, PSE has
    // two and both are. The sentence read "0 as great-circle arcs, 1 as straight lines" -- a
    // plural about one thing. The golden is blind to it (5 crossings, 4 curves, both plural).
    const lone = renderSegmentMap(input([seg("SEA", "HNL")]));
    expect(ariaLabel(lone)).toContain("0 as great-circle arcs, 1 as straight line across a panel boundary");
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
    // There is no `normalizeLon` call ON THIS PATH to delete -- `reachedPanelsFor` routes
    // through `fitPanels`, which normalizes internally, and that is the point: the correct
    // behaviour is inherited rather than re-typed. The mutation this catches is the obvious
    // hand-rolled rewrite, a `regionOf` loop over the endpoints (which is what
    // `NetworkMap.tsx` used to carry, normalizeLon included). Un-normalized, GUM (+144.8)
    // satisfies `lat < 25 && lon > -70` and files as CARIBBEAN, and SYA (+174.11) falls through
    // every test to the conterminous panel 270 degrees from its central meridian.
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

  it("ignores a self-segment, which draws no arc and so reaches no panel", () => {
    // Catches: counting endpoints the renderer will not fit. This used to return ["hi"] while
    // `renderSegmentMap` fitted only drawable segments, so a panel reached ONLY by a
    // self-segment got a coastline and no inset frame around it -- an unframed, unlabelled
    // landmass, against the rule `INSETS` states in the same file.
    expect(reachedPanelsFor([seg("HNL", "HNL")])).toEqual([]);
  });

  it("returns EXACTLY the panels renderSegmentMap frames, for the same segments", () => {
    // The invariant behind the fix, stated directly rather than left to two call sites to
    // preserve independently. `[SEA->PDX, HNL->HNL]` is the case that used to break it: the
    // coastline said Hawai'i, the frame said nothing.
    const segments = [seg("SEA", "PDX"), seg("HNL", "HNL")];
    expect(reachedPanelsFor(segments)).toEqual(["us"]);

    const svg = renderSegmentMap(input(segments));
    expect(svg).not.toContain("HAWAI");
    expect(svg).not.toContain("ALASKA");
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
