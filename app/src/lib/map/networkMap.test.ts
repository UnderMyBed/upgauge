import { describe, expect, it } from "vitest";
import { renderNetworkMap, type NetworkMapInput } from "./networkMap";
import { GOLDEN_NETWORK_INPUT, GOLDEN_NETWORK_SVG } from "./networkGolden.fixture";
// MERGE (#104 x #111): #104 relocated INSET_RECTS into segmentMap.ts while #111 changed its
// values and added this sync gate. The table's new home is segmentMap.ts; the gate follows it.
import { INSET_RECTS } from "./segmentMap";
import { PANEL_RECTS } from "./albers";
import type { ArcDatum } from "./arcs";

/** Real coordinates throughout, per this task's brief -- a synthetic grid would make the
 * geometry assertions (panel membership, cross-panel straight lines) vacuous. */
const COORDS = {
  PDX: { lat: 45.59, lon: -122.6 },
  HNL: { lat: 21.32, lon: -157.92 },
  ORD: { lat: 41.98, lon: -87.9 },
  SEA: { lat: 47.45, lon: -122.31 },
  JFK: { lat: 40.64, lon: -73.78 },
  // Far south of ORD/SEA/JFK's own bounding box -- used only by the fit-alignment test
  // below, to extend the SUBJECT's bounding box without changing which panel ("us") any of
  // these airports land in.
  MIA: { lat: 25.79, lon: -80.29 },
  // One airport per remaining panel, so a single fixture can reach all six insets and the
  // label test below can be a claim about EVERY label rather than about Hawai'i's.
  ANC: { lat: 61.17, lon: -149.99 }, // ak
  GUM: { lat: 13.48, lon: 144.8 }, // pac -- positive longitude, regionOf normalizes first
  MDY: { lat: 28.2, lon: -177.38 }, // nwhi
  SJU: { lat: 18.44, lon: -66.0 }, // car
  PPG: { lat: -14.33, lon: -170.71 }, // sam -- southern hemisphere
  // Key West -- the SOUTHERNMOST fact-present `us` airport, 0.86px above the `us` rect's floor
  // and the airport `US_EXTENT_ANCHORS` exists to keep inside it. Its subject disc reaches 5.4px
  // past its own point, which is the crop's `ink.bottom` term's own case.
  EYW: { lat: 24.55611111, lon: -81.76 }, // us, on the rect's southern edge
  // Bellingham -- the NORTHERNMOST fact-present `us` airport (measured over all 1,047), and the
  // one fixture that exercises the crop's ink term. Its subject marker's own label is drawn at
  // y-8 in 11px type, so its ink reaches y=2.93 while the `us` panel band starts at 18.
  BLI: { lat: 48.79277778, lon: -122.5375 }, // us, at the top of the rect
} as const;

function originArc(code: keyof typeof COORDS): ArcDatum {
  return { code, ...COORDS[code], seats: 0, departures: 0, loadFactor: null, activeMonths: 1 };
}

function destArc(code: keyof typeof COORDS, overrides: Partial<ArcDatum> = {}): ArcDatum {
  return {
    code,
    ...COORDS[code],
    seats: 100_000,
    departures: 200,
    loadFactor: 0.85,
    activeMonths: 1,
    ...overrides,
  };
}

/** Default: ORD with two conterminous destinations, no same-airport rows. Used wherever a
 * test needs a valid input but does not care about its specifics. */
function fixture(): NetworkMapInput {
  return {
    origin: originArc("ORD"),
    arcs: [destArc("SEA"), destArc("JFK")],
    window: "2015-01 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** Three conterminous destinations at the given seat totals, all with departures and load
 * factor comfortably clear of the departure floor and the load-factor floor -- so the ONLY
 * thing distinguishing their stroke widths is seats, and the draw-order test is actually
 * exercising `segmentOrder` -- which is what executes on both render paths since #104 -- rather
 * than an accidental floor override. */
function fixtureWithSeats(seats: number[]): NetworkMapInput {
  const codes: (keyof typeof COORDS)[] = ["SEA", "JFK", "ORD"];
  return {
    origin: { code: "PDX", ...COORDS.PDX, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: seats.map((s, i) => ({
      code: codes[i],
      ...COORDS[codes[i]],
      seats: s,
      departures: 200,
      loadFactor: 0.85,
      activeMonths: 1,
    })),
    window: "2015-01 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** One arc at the given load factor, departures well above the 30-departure floor so the
 * dash reflects load factor and not the floor override. */
function fixtureWithLoadFactor(loadFactor: number): NetworkMapInput {
  return {
    origin: originArc("ORD"),
    arcs: [destArc("SEA", { departures: 200, loadFactor })],
    window: "2015-01 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** One arc at the given departure count -- below 30 to exercise the floor override. */
function fixtureWithDepartures(departures: number): NetworkMapInput {
  return {
    origin: originArc("ORD"),
    arcs: [destArc("SEA", { departures, loadFactor: 0.9, activeMonths: 1 })],
    window: "2015-01 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** PDX -> HNL: conterminous origin, Hawai'i-panel destination -- the two ALWAYS disagree on
 * panel, so this is the fixture a cross-panel test needs. */
function pdxToHnlFixture(): NetworkMapInput {
  return {
    origin: originArc("PDX"),
    arcs: [destArc("HNL")],
    window: "2015-01 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** HNL -> ORD: the REVERSE of pdxToHnlFixture -- origin is the inset (Hawai'i), destination is
 * conterminous. Re-review finding 4's fixture: the straight line this draws crosses OUT of
 * HNL's own inset into the `us` panel, not "into an inset panel" the way PDX-HNL's does. A
 * description that names a panel KIND ("into an inset") rather than the boundary itself reads
 * true on pdxToHnlFixture and false here -- the same shape as the M5 route-cell trap CLAUDE.md
 * warns every claim needs the fixture that disagrees, not just the one that happens to agree. */
function hnlToOrdFixture(): NetworkMapInput {
  return {
    origin: originArc("HNL"),
    arcs: [destArc("ORD")],
    window: "2015-01 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** Two conterminous destinations only -- fits will carry exactly one panel, `us`, so no
 * inset frame (Alaska/Hawai'i/Pacific/Caribbean) should ever appear. */
function conterminousOnlyFixture(): NetworkMapInput {
  return fixture();
}

/** ORD with three arcs, the FIRST of which shares its code with the origin -- a same-airport
 * row (measured: ORD carries 53 such rows / 73,082 seats over the trailing 12 months,
 * docs/data/invariants.md § Route identity). `fixtureArcCount` returns this fixture's total
 * arc count (including the self row) so the exclusion test can assert N-1 without a second,
 * independently-maintained constant drifting from this one. */
const SELF_ARC_FIXTURE_ARC_COUNT = 3;

function fixtureIncludingSelfArc(originCode: string): NetworkMapInput {
  return {
    origin: { code: originCode, ...COORDS.ORD, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: [
      // The self row: same code as the origin, real seats, no valid great circle.
      { code: originCode, ...COORDS.ORD, seats: 73_082, departures: 53, loadFactor: 0.8, activeMonths: 1 },
      destArc("SEA"),
      destArc("JFK"),
    ],
    window: "2015-01 → 2026-04",
    sameAirportSeats: 73_082,
  };
}

/** The map's accessible name, read off the rendered attribute rather than rebuilt from the
 * input -- the same reason `SegmentMap.test.tsx` has one. Reconstructing the expected label in
 * the test would assert the test's own idea of the wording, not the renderer's. */
function ariaLabelOf(svg: string): string {
  return /aria-label="([^"]*)"/.exec(svg)![1];
}

function fixtureArcCount(): number {
  return SELF_ARC_FIXTURE_ARC_COUNT;
}

describe("renderNetworkMap", () => {
  it("renders the golden fixture byte for byte", () => {
    // THE guard for #104's hub-and-spoke -> point-to-point refactor: `renderNetworkMap` is
    // reimplemented on top of the shared segment core, and `/airport`'s rendered bytes must
    // not move by so much as a digit. Captured from this renderer BEFORE the refactor -- see
    // networkGolden.fixture.ts for why this is a literal fixture and not a live /airport
    // render, and for what each of its ten arcs pins.
    //
    // If this goes red, the adapter is wrong. Do not regenerate the golden to make it green.
    expect(renderNetworkMap(GOLDEN_NETWORK_INPUT)).toBe(GOLDEN_NETWORK_SVG);
  });

  it("draws thin arcs before heavy ones", () => {
    // Catches: insertion-order drawing. This is an ORDERING property, so asserting
    // the SET of stroke widths passes under the bug -- only document order catches
    // it. M4c learned this the hard way: reversing a stack still emits six paths
    // with six correct fills.
    const svg = renderNetworkMap(fixtureWithSeats([100, 9000, 400]));
    const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it("dashes an arc below 70% load factor", () => {
    const svg = renderNetworkMap(fixtureWithLoadFactor(0.62));
    expect(svg).toContain('stroke-dasharray="5 3"');
  });

  it("dots an arc below the 30-departure floor", () => {
    const svg = renderNetworkMap(fixtureWithDepartures(12));
    expect(svg).toContain('stroke-dasharray="1 3"');
  });

  // Minor finding, final whole-branch review: a solid arc (above both the load-factor and
  // departure floors, `strokeFor`'s `dash: ""` branch) used to still emit
  // `stroke-dasharray=""` -- browsers ignore it (identical to the attribute's absence), but
  // it is invalid SVG and cost ~5 KB of no-op bytes on the 267 polylines ORD drew over
  // 2025-05..2026-04, the fixed window airportNetwork.test.ts pins. The attribute
  // should be OMITTED entirely for a solid arc, not emitted empty.
  it("omits stroke-dasharray entirely for a solid arc, rather than emitting it empty", () => {
    const svg = renderNetworkMap(fixture()); // ORD -> SEA, JFK: both solid, well above floor
    expect(svg).not.toContain('stroke-dasharray=""');
    expect(svg).not.toContain("stroke-dasharray");
  });

  it("draws a cross-panel arc as a straight line, not a great circle", () => {
    // Catches: running gc() across a panel boundary. A great circle cannot cross
    // one -- the projection is discontinuous there -- so PDX-HNL must be 2 points.
    const svg = renderNetworkMap(pdxToHnlFixture());
    const points = svg.match(/points="([^"]+)"/)![1].trim().split(/\s+/);
    expect(points).toHaveLength(2);
  });

  it("excludes a same-airport arc entirely", () => {
    // Catches: drawing a zero-length arc. gc()'s degenerate branch emits 49
    // identical points -- several hundred bytes drawing an invisible mark on top
    // of the origin disc. Over 2025-05..2026-04, the fixed window airportNetwork.test.ts
    // queries, ORD draws 267 arcs from 268 routes.
    const svg = renderNetworkMap(fixtureIncludingSelfArc("ORD"));
    const polylines = svg.match(/<polyline/g) ?? [];
    expect(polylines).toHaveLength(fixtureArcCount() - 1);
  });

  it("states the same-airport seats it excluded, on the map itself and not only in the aria-label", () => {
    // Catches: dropping them from the TOTAL as well as from the arcs, which would
    // put the map's own figures at odds with the stat strip directly above it.
    //
    // A first version of this test asserted `svg.toContain("73,082")` over the WHOLE
    // string and did not catch a mutant that zeroed the number only in the visible
    // note: `describeMap`'s aria-label carries the same figure from `input` directly,
    // so the substring was still present and the test stayed green. Stripping the
    // `aria-label` attribute before asserting is what makes this a real pin on the
    // visible text a sighted reader sees, not a coincidental hit on its accessible
    // description.
    const svg = renderNetworkMap({ ...fixture(), sameAirportSeats: 73_082 });
    const visible = svg.replace(/aria-label="[^"]*"/, "");
    expect(visible).toContain("73,082");
  });

  it("still says same-airport seats are 'included in this total' -- /airport's stat strip is", () => {
    // The falsifying half of segmentMap.test.ts's pair. `sameAirportNote` is ONE sentence with
    // one owner and two tails, and this is the tail that must not follow the point-to-point map
    // when that map's wording changes: on /airport a seats total directly above the map really
    // does carry these seats, and the note exists so the arc count and that total can disagree
    // without reading as an error.
    const svg = renderNetworkMap({ ...fixture(), sameAirportSeats: 73_082 });
    expect(svg).toContain(
      "73,082 same-airport seats excluded from the arcs above, included in this total.",
    );
    expect(svg).not.toContain("route counts");
  });

  // ---- #114: quarantine-only route pairs -------------------------------------------------

  it("states quarantined routes in the accessible name, with a count and a reason", () => {
    // Catches: adding `quarantinedRoutes` to the interface and the producer, and never wiring
    // it into what the map SAYS -- which is the whole point of the field. The full sentence,
    // not a substring: the count alone is not a disclosure, and "never clamped" is load-bearing
    // (the alternative to quarantining a load_factor > 1.0 row is clamping it, which this
    // project refuses).
    const svg = renderNetworkMap({ ...fixture(), quarantinedRoutes: 3 });
    expect(ariaLabelOf(svg)).toContain(
      "3 quarantined routes not drawn — failed an invariant, never clamped.",
    );
  });

  it("pluralizes the quarantine sentence at exactly one route", () => {
    // The count that actually ships. Every one of the 19 affected airports reports 1 over the
    // trailing 12 except AET, which reports 2 -- so a hard-coded plural is wrong on 18 of 19
    // live pages, and the fixture that would catch it is the COMMON case, not the exotic one.
    const svg = renderNetworkMap({ ...fixture(), quarantinedRoutes: 1 });
    expect(ariaLabelOf(svg)).toContain("1 quarantined route not drawn");
    expect(ariaLabelOf(svg)).not.toContain("1 quarantined routes");
  });

  it("puts the quarantine clause BEFORE the same-airport clause", () => {
    // AN ORDERING PROPERTY, ASSERTED AS AN ORDERING -- and that distinction is the test, not a
    // detail of it. Both sentences are present under EITHER arrangement, so an assertion that
    // the label contains both passes when they are swapped; only their relative POSITION
    // distinguishes correct from buggy. This is the shape CLAUDE.md records M4c paying for four
    // times, most exactly in the stack-order case where six correct fills were emitted in the
    // wrong sequence and a fill-set assertion could not see it.
    //
    // The order itself is not arbitrary: it is `disclosureNotes`'s, so the point-to-point map
    // and the hub map state the same two facts in the same sequence.
    const label = ariaLabelOf(
      renderNetworkMap({ ...fixture(), quarantinedRoutes: 2, sameAirportSeats: 5_000 }),
    );
    const quarantine = label.indexOf("2 quarantined routes not drawn");
    const sameAirport = label.indexOf("5,000 same-airport seats");
    expect(quarantine).toBeGreaterThan(-1);
    expect(sameAirport).toBeGreaterThan(-1);
    expect(quarantine).toBeLessThan(sameAirport);
  });

  it("says nothing about quarantine when there is none", () => {
    // Catches `routes > 0` written as `routes !== undefined` or `>= 0`, either of which paints
    // "0 quarantined routes not drawn" onto the ~1,000 airport pages that have nothing to
    // disclose. `quarantin` as the stem, so a mutant that emitted the sentence with a zero in
    // it cannot slip past a needle that only looked for the plural noun.
    expect(ariaLabelOf(renderNetworkMap({ ...fixture(), quarantinedRoutes: 0 }))).not.toContain(
      "quarantin",
    );
  });

  it("renders an absent quarantinedRoutes byte-identically to an explicit zero", () => {
    // THE GOLDEN'S SAFETY PROPERTY, stated directly rather than inferred from the golden test
    // passing. `quarantinedRoutes` is OPTIONAL so that `networkGolden.fixture.ts` -- #104's
    // byte-identity guard, which this unit must not edit -- keeps typechecking and keeps
    // rendering the same bytes. "Absent" and "nothing to disclose" must therefore be the same
    // answer all the way down to the markup, not merely the same sentence.
    const absent = fixture();
    const explicit = { ...fixture(), quarantinedRoutes: 0 };
    expect(renderNetworkMap(absent)).toBe(renderNetworkMap(explicit));
  });

  it("keeps the quarantine sentence OFF the painted map face", () => {
    // Deliberate, measured, and the opposite of the same-airport note two tests up. The hub
    // map's footer is ONE line against a ~158-character budget; window + sameAirportNote
    // already reach 121 at a 7-digit seat count, and this sentence is 69 more, so joining it
    // there clips at the frame edge with NOTHING in the markup recording that it happened.
    // `NetworkMap.tsx` renders it as HTML beneath the map instead, where text wraps -- and
    // `NetworkMap.test.tsx` binds that block to the same one owner, so this exclusion cannot
    // become a silent omission.
    const svg = renderNetworkMap({ ...fixture(), quarantinedRoutes: 3 });
    const visible = svg.replace(/aria-label="[^"]*"/, "");
    expect(visible).not.toContain("quarantin");
  });

  it("still draws the origin disc for a network whose every pair was quarantined", () => {
    // /airport/A18, /airport/JZM and /airport/OQZ over the trailing 12: nothing drawable and
    // something real to say. The map must still render -- a subject disc, its label, and the
    // disclosure -- because the alternative leaves no trace on the page that anything was filed.
    const svg = renderNetworkMap({
      origin: originArc("ORD"),
      arcs: [],
      window: "2025-06 → 2026-05",
      sameAirportSeats: 0,
      quarantinedRoutes: 1,
    });
    expect(svg).not.toContain("<polyline");
    expect(svg).toContain('fill="var(--field)" stroke="var(--signal)"');
    expect(ariaLabelOf(svg)).toContain("1 quarantined route not drawn");
  });

  it("does not emit an inset frame for a panel with no points", () => {
    // EVERY inset label, not a sample. #111 renamed `pac`'s from "PACIFIC" to "MARIANAS" and
    // left this assertion naming the old string, which made it unreachable for any input --
    // `grep -c PACIFIC networkMap.ts` returns 0 -- so this test proved only its `hi` half.
    // Demonstrated rather than argued: making the inset loop draw `pac` unconditionally leaves
    // the old `not.toContain("PACIFIC")` GREEN and reddens the list below.
    //
    // A `not.toContain` over a fixture that draws NO insets cannot gate a rename -- renaming
    // only makes it likelier to pass. The rename gate is the POSITIVE test below, which is
    // where the claim belongs and where it is now made.
    const svg = renderNetworkMap(conterminousOnlyFixture());
    expect(svg).not.toContain("HAWAI");
    expect(svg).not.toContain("MARIANAS");
    expect(svg).not.toContain("MIDWAY");
    expect(svg).not.toContain("AMERICAN SAMOA");
    expect(svg).not.toContain("CARIBBEAN");
    expect(svg).not.toContain("ALASKA");
  });

  it("draws its frames to the same rects albers.ts fits the panels into", () => {
    // INSET_RECTS is a hand-copy of PANEL_RECTS that no test guarded, because PANEL_RECTS was
    // unexported. #111 exported it (to assert airports land inside their own panel) and then
    // edited BOTH tables by hand -- the exact operation the missing gate existed to catch, and
    // it caught a real one-sided edit during this task's own mutant run. A frame drawn to a
    // different rect than the one the coastline was fit to would visibly not match the landmass
    // inside it, and nothing else in this suite looks at absolute frame position.
    const insetPanels = Object.fromEntries(
      Object.entries(PANEL_RECTS).filter(([panel]) => panel !== "us"),
    );
    expect(INSET_RECTS).toEqual(insetPanels);
  });

  it("labels every inset it does draw", () => {
    // An inset that isn't labelled is a lie -- the mockup's own comment. This asserted only
    // `HAWAI` until #111, which meant a network reaching five other insets could draw five
    // unlabelled frames and nothing would notice; it also meant the rename gate the negative
    // test above claimed to be was nowhere in the suite. Mutant-verified: renaming ALASKA to
    // AK, or CARIBBEAN to PR-USVI, left the whole 99-test suite green before this.
    //
    // One origin and one destination per panel, so every INSETS entry is exercised at once.
    const svg = renderNetworkMap({
      origin: originArc("ORD"),
      arcs: [
        destArc("ANC"),
        destArc("HNL"),
        destArc("GUM"),
        destArc("MDY"),
        destArc("SJU"),
        destArc("PPG"),
      ],
      window: "2025-05 → 2026-04",
      sameAirportSeats: 0,
    });
    for (const label of ["ALASKA", "HAWAI", "MARIANAS", "MIDWAY", "CARIBBEAN", "AMERICAN SAMOA"]) {
      expect(`${label}: ${svg.includes(label)}`).toBe(`${label}: true`);
    }
  });

  it("keeps a far-northern subject's own label inside the cropped canvas (#123)", () => {
    // THE CASE THAT MAKES THE CROP'S INK TERM LOAD-BEARING, and it took a mutant to find that
    // no other fixture did. `cropWindow` unions the reached panels' bands with the ink actually
    // emitted; drop the ink term and every assertion in `segmentMap.test.ts`'s crop block still
    // passes, because a segment map has no subject marker and a node's label is drawn BELOW its
    // point. The marker is the mark that reaches upward: `renderMapCore` draws the subject's
    // code at y-8 in 11px type, so its ink runs about 19px above a point that
    // `panelContainment.test.ts` only guarantees is inside the rect.
    //
    // BLI is that point in production, not a contrived one -- the northernmost fact-present
    // `us` airport, projecting to y=21.93, so its label ink reaches 2.93 against a `us` band
    // top of 18. Without the union the window would start at 12 and `/airport/BLI` would serve
    // a subject disc whose own code is sliced off by `svg:not(:root) { overflow: hidden }` --
    // the same class of defect as #115's off-canvas AKB label, one panel over.
    //
    // Mutant: drop `ink.top` from `cropWindow`'s `top` and this goes red at 12 against 2.
    const svg = renderNetworkMap({ ...fixture(), origin: originArc("BLI") });
    const [, y] = svg.match(/viewBox="([\d.-]+) ([\d.-]+) /)!.slice(1).map(Number);
    const labelTop = Math.min(
      ...[...svg.matchAll(/<text x="[\d.-]+" y="([\d.-]+)" text-anchor="end" font-size="11"/g)].map(
        (m) => Number(m[1]) - 11,
      ),
    );
    expect(`window top ${y} is above the subject label top ${labelTop.toFixed(2)}: ${y <= labelTop}`).toBe(
      `window top ${y} is above the subject label top ${labelTop.toFixed(2)}: true`,
    );
    // Not vacuous: the label really does sit above the `us` band, which is what the union is for.
    expect(labelTop).toBeLessThan(PANEL_RECTS.us[1]);
  });

  it("keeps the footer its full band below a subject disc that hangs past its panel (#123)", () => {
    // THE BOTTOM HALF OF THE CROP'S INK UNION, and the twin of the BLI case above. A panel's
    // rect bounds a POINT; it says nothing about the ink that point paints. EYW sits 0.86px
    // above the `us` band's floor of 424 -- the tightest airport on the panel, which is why
    // `US_EXTENT_ANCHORS` exists -- and its subject disc (r=4.5 plus a 1.8 stroke centred on it)
    // reaches 428.50, four and a half pixels BELOW the band.
    //
    // THE PROPERTY IS THE FOOTER'S MARGIN, NOT CONTAINMENT. The disc is never clipped either way:
    // `footerBand` adds 26px under whichever floor is chosen, so a window measured to the band
    // alone still ends at 450, comfortably past 428.50. What the ink term buys is that the
    // footer clears everything DRAWN by the same margin `footerBand` guarantees over a frame --
    // 10px -- rather than by whatever is left after a mark hangs into the band.
    //
    // Mutant: drop `ink.bottom` from `cropWindow`'s `bottom`. The window goes `0 12 960 443` ->
    // `0 12 960 438`, the footer baseline 449 -> 444, and its ink starts 5.5px under the disc
    // instead of 10.5 -- red here, and green in all 341 other map tests, which is how a comment
    // calling this term non-binding survived a review round.
    const svg = renderNetworkMap({ ...fixture(), origin: originArc("EYW") });
    const discBottom =
      Number(svg.match(/<circle cx="[\d.-]+" cy="([\d.-]+)" r="4.5"/)![1]) + 5.4;
    const footerTop = Math.min(
      ...[...svg.matchAll(/<text x="8" y="([\d.]+)" font-size="10"/g)].map((m) => Number(m[1]) - 10),
    );
    expect(
      `footer starts ${(footerTop - discBottom).toFixed(1)}px below the disc: ${footerTop - discBottom >= 10}`,
    ).toBe(`footer starts ${(footerTop - discBottom).toFixed(1)}px below the disc: true`);
    // Not vacuous: the disc really does hang past the `us` band, which is what the union is for.
    expect(discBottom).toBeGreaterThan(PANEL_RECTS.us[3]);
  });

  it("carries an accessible role and label", () => {
    const svg = renderNetworkMap(fixture());
    expect(svg).toContain('role="img"');
    expect(svg).toMatch(/aria-label="[^"]+"/);
  });

  // Final whole-branch review, Important #5: the aria-label used to call EVERY destination a
  // great-circle arc unconditionally, which is wrong for a cross-panel one (drawn as a
  // straight line across the panel boundary -- the test above, "draws a cross-panel arc as a
  // straight line," already proves the drawn geometry; this is the accessible TEXT saying
  // something different from what actually got drawn). A falsifiable pair, the same shape
  // M4c's own annotation test used: the ALL-conterminous fixture must still say "great-circle
  // arcs" plainly, and the cross-panel fixture must NOT claim that of its one destination.
  it("says 'great-circle arcs' when every destination genuinely is one", () => {
    const svg = renderNetworkMap(fixture()); // ORD -> SEA, JFK: both conterminous
    const label = svg.match(/aria-label="([^"]*)"/)![1];
    expect(label).toContain("great-circle arcs");
    expect(label).not.toContain("straight line");
  });

  it("does NOT call a cross-panel destination a great-circle arc in the aria-label", () => {
    const svg = renderNetworkMap(pdxToHnlFixture()); // PDX -> HNL: Hawai'i panel, straight line
    const label = svg.match(/aria-label="([^"]*)"/)![1];
    expect(label).toContain("straight line");
    expect(label).not.toContain("1 destination drawn as great-circle arcs");
  });

  // Re-review finding 4: the description used to say every cross-panel arc is drawn "into an
  // inset panel," which is true for a conterminous origin (PDX-HNL, above) but false for an
  // INSET origin -- HNL, ANC, SJU and GUM all have destinations whose straight line crosses
  // OUT of the origin's own inset into `us`, not into any inset at all. Catches: reintroducing
  // direction-specific wording ("into an inset panel" / "into that inset") anywhere the
  // description or aria-label names the crossing, rather than naming the boundary itself.
  it("does not claim a cross-panel arc goes 'into an inset' when the ORIGIN is the inset one", () => {
    const svg = renderNetworkMap(hnlToOrdFixture()); // HNL -> ORD: inset origin, straight line
    const label = svg.match(/aria-label="([^"]*)"/)![1];
    expect(label).toContain("straight line");
    expect(label).not.toMatch(/into (an|that) inset/i);
  });

  it("renders the injected basemap when present and omits it when absent", () => {
    // The basemap is an injected input (Task 7 supplies it), never an import -- this
    // is the property that lets Task 7 wire it with no change to this file.
    const withBasemap = renderNetworkMap({
      ...fixture(),
      basemapPaths: '<path d="M0 0 L1 1" class="basemap-probe"/>',
    });
    expect(withBasemap).toContain("basemap-probe");

    const without = renderNetworkMap(fixture());
    expect(without).not.toContain("basemap-probe");
  });

  it("draws exactly one polyline per non-self arc, none for the origin itself", () => {
    const svg = renderNetworkMap(fixture());
    const polylines = svg.match(/<polyline/g) ?? [];
    expect(polylines).toHaveLength(2);
  });

  it("projects a fixed point identically regardless of which other subject points are present", () => {
    // THE bug this task exists to fix: an earlier draft fit each panel to `fitPanels(points)`
    // -- the subject's OWN points alone -- which is a DIFFERENT fit than the one
    // basemapPaths.generated.ts's coastline was baked with (fitPanels(BASEMAP_FIT_POINTS)).
    // Under that bug, adding a subject point far outside the original bounding box changes
    // k/ox/oy and moves EVERY existing point's projected pixel -- silently misaligning the
    // arcs from the coastline drawn beneath them. The fix reuses the fixed basemap fit for
    // any panel it covers (us/ak/hi), so ORD's own screen position must not move when MIA (a
    // real airport, far south of ORD/SEA/JFK's own bounding box, still squarely in the `us`
    // panel) is added to the network.
    //
    // This is a GEOMETRY assertion, not a presence assertion, on purpose (CLAUDE.md's
    // standing warning: an ordering/position/window property needs the ordering, position or
    // window checked directly, never a proxy that happens to pass under the bug too).
    const narrow = renderNetworkMap(fixture()); // ORD -> SEA, JFK
    const wide = renderNetworkMap({ ...fixture(), arcs: [...fixture().arcs, destArc("MIA")] });

    const originMarker = (svg: string): [string, string] => {
      const m = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="4\.5"/);
      if (!m) throw new Error("origin marker not found");
      return [m[1], m[2]];
    };

    expect(originMarker(wide)).toEqual(originMarker(narrow));
  });
});
