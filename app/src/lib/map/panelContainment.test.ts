/**
 * THE PROPERTY #115 EXISTS TO STATE ONCE, FOR ALL PANELS: every airport this site serves a
 * page for projects inside the rect of the panel `regionOf` files it into, and its subject
 * mark stays on the canvas.
 *
 * Stating it per-airport is what let it be missed twice. #111 fixed Midway one airport at a
 * time; #115 then found ADK and SYA -- and, because the sweep that produced #115 checked the
 * DISC and not the LABEL BOX, missed AKB, whose disc was on-canvas at x=7.0 while its label
 * ran to x=-19.8, so `/airport/AKB` rendered an unlabelled subject disc jammed against the
 * left edge in all 13 of its windows. Both properties below are asserted over the WHOLE
 * fact-present population, so the next one cannot hide behind a hand-written airport list.
 *
 * EVERY TEST IN THIS FILE NEEDS A BUILT `upgauge.duckdb`, INCLUDING THE ONES THAT LOOK LIKE
 * THEY DO NOT. The population is loaded by a MODULE-LEVEL await below, so without a warehouse
 * the file throws while loading and vitest reports `no tests` for it -- it FAILS, loudly, and
 * nothing here silently skips. Measured, by running it with `UPGAUGE_DB` pointed at a path that
 * does not exist: `Test Files 1 failed`, `Tests no tests`. That is the desired failure mode and
 * it is worth stating, because a gate that quietly skips in the environment where it matters is
 * the one failure CLAUDE.md's `app-smoke` section says this repo cannot tolerate.
 *
 * It also means a DB-free property must not be filed here and described as still firing when
 * the live ones do not -- the module-level await takes the whole file down first, so it would
 * fire nowhere. #122's structural half is in `albers.test.ts` for exactly that reason: that
 * file imports nothing but the projection, so it runs in a checkout with no `data/` at all.
 *
 * A LIVE-DATABASE TEST, deliberately, unlike `basemap.test.ts`'s hand-copied Pacific
 * coordinates. Half of what this guards is a BTS refresh introducing an airport outside a
 * panel's baked extent -- exactly the class that renamed aircraft type 699 out from under the
 * `/aircraft` slug fixtures -- and a literal table cannot see that by construction. Same
 * precedent as `airportNetwork.test.ts`'s and `db.test.ts`'s live sections; it is one of the
 * tests that fail without a built `upgauge.duckdb`.
 *
 * NO NEW SQL. The population is the production one, read through three production queries in
 * the order the site itself uses them: `sitemap_airports.sql` (via `sitemapEntries`) is the
 * definition of "an airport page exists", `lookup_airport_by_code.sql` (via
 * `lookupAirportsByCode`) resolves each code to its fact-present id, and
 * `map_airport_coords.sql` (via `fetchCoords`) supplies the coordinates every map already
 * draws from. A fourth, test-only query would be a second definition of fact-presence.
 */
import { describe, expect, it } from "vitest";
import {
  fitPanels,
  normalizeLon,
  regionOf,
  PANEL_RECTS,
  project,
  type Panel,
  type PanelFit,
} from "./albers";
import { BASEMAP_FIT_POINTS } from "./basemap";
import { fetchCoords } from "./airportNetwork";
import { lookupAirportsByCode } from "@/lib/resolve";
import { sitemapEntries } from "@/lib/sitemap";
import { AIRPORT_PREFIX } from "@/lib/airport";
// The generator's own literal, not a third copy of two coordinate pairs. Importing it does
// not regenerate the committed artifact -- `main()`'s write is guarded to direct execution
// only (see build-basemap.mjs's bottom guard).
import { AK_EXTENT_ANCHORS, US_EXTENT_ANCHORS } from "../../../scripts/build-basemap.mjs";

/** `segmentMap.ts:217`'s `BASEMAP_FITS`, verbatim -- the same expression, not a copy of its
 * result. That module does not export it, and re-deriving it here from the same input is
 * exactly what `fitPanels(BASEMAP_FIT_POINTS)` is contracted to make safe. */
const BASEMAP_FITS = fitPanels(BASEMAP_FIT_POINTS);

/**
 * `renderMapCore`'s own fit merge (`segmentMap.ts:442-446`): the baked fit for any panel that
 * has one, and a SUBJECT-DERIVED fit for any panel that does not.
 *
 * The `??` branch is `nwhi` alone -- Midway, which has no committed coastline. It is not a
 * detail to skip: without it, `project()` falls back to the `us` fit and reports MDY at
 * (-514.8, -70.1), a false positive for a page that actually centres it in its frame. `nwhi`
 * can never hold more than one of a page's points (Midway is its only airport; Kure has none),
 * so a single-point fit is what the page computes too, not an approximation of it.
 */
function fitsFor(lat: number, lon: number): Map<Panel, PanelFit> {
  const panel = regionOf(lat, normalizeLon(lon));
  const fit = BASEMAP_FITS.get(panel) ?? fitPanels([{ lat, lon }]).get(panel);
  return new Map<Panel, PanelFit>(fit ? [[panel, fit]] : []);
}

interface Placed {
  code: string;
  panel: Panel;
  x: number;
  y: number;
}

async function placeEveryServedAirport(): Promise<Placed[]> {
  const codes = (await sitemapEntries("airports")).map((e) =>
    decodeURIComponent(e.url.slice(AIRPORT_PREFIX.length)),
  );
  const refs = await lookupAirportsByCode(codes);
  const coords = await fetchCoords([...refs.values()].map((r) => r.id));
  return [...coords.values()]
    .map(({ code, lat, lon }) => {
      const panel = regionOf(lat, normalizeLon(lon));
      const [x, y] = project(lat, lon, fitsFor(lat, lon));
      return { code, panel, x, y };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

const placed = await placeEveryServedAirport();

describe("every airport this site serves a page for lands where the map says it does", () => {
  it("reads the whole served population, so nothing below is vacuous", () => {
    // Without this, a regression that emptied the sitemap -- or a `lookupAirportsByCode` that
    // resolved nothing -- would make both properties pass over an empty list and report
    // success. The same guard, for the same reason, as the land test's "reads real
    // conterminous subpaths". Measured 2026-08-26: 1,047 airports. Asserted as a floor rather
    // than that figure, because the figure is a dataset measurement and this file is not
    // registered with `test_stated_counts.py`.
    expect(placed.length).toBeGreaterThan(1000);
    for (const p of placed) {
      expect(`${p.code}: ${Number.isFinite(p.x) && Number.isFinite(p.y)}`).toBe(`${p.code}: true`);
    }
  });

  it("projects every one of them INSIDE its own panel's rect", () => {
    // THE STRUCTURAL PROPERTY. The bug it catches: a panel fit or rect scaled to committed
    // geometry that a fact-present airport lies outside of. That is #115 (`ne_110m_us.json`'s
    // Alaska stops at 171.791 W, mid-Aleutians, so seven Alaskan airports fell outside
    // `PANEL_RECTS.ak` across 69 served views) and it is #111's Midway before it. Stating it
    // once, over the whole population, is what the issue asked for -- a test naming ADK and
    // SYA would pass the day an eighth airport moved out.
    //
    // Asserted against `albers.ts`'s exported `PANEL_RECTS`, never a copy, and as an EXACT
    // sorted set rather than a count or a "no more than" bound: a NEW violation is red, and so
    // is a FIXED one, so nobody can quietly widen the exemption instead of reading it.
    //
    // WHAT THIS TEST IS BLIND TO, MEASURED RATHER THAN ASSUMED, because the plan for #115 said
    // it would catch a rect MOVE and it does not: `fitPanels` derives `ox`/`oy` FROM the rect,
    // so TRANSLATING a rect translates every point projected into it by the same vector and
    // this property is invariant. Run as a mutant -- `PANEL_RECTS.ak` [36,322,176,468] ->
    // [60,322,200,468], same 140x146 size -- all four tests in this file stayed GREEN. Four
    // other gates killed it: `albers.test.ts`'s "draws no two inset frames over each other",
    // `basemap.test.ts`'s `ak` fit pin, and `networkMap.test.ts`'s golden and its
    // `PANEL_RECTS`/`INSET_RECTS` sync check. Rect POSITION is theirs; what this test owns is
    // the fit's INPUT against the airport population -- the reference set not reaching far
    // enough, a rect RESIZE, `regionOf` re-filing a point, or a refreshed coordinate moving
    // outside a baked extent. The mutant that does kill it is pulling the Attu anchor east to
    // -180 ("close enough"): SYA reappears here at (20.5, 421.6).
    //
    // NO EXEMPTIONS. There were two -- EYW (Key West) at (693.6, 428.7) and MTH (Marathon) at
    // (703.4, 424.5), 4.7px and 0.5px below the `us` rect's bottom edge of 424, because
    // 1:110m's Florida stops at lat 25.08, north of the Keys entirely. #119 closed them by
    // giving `us` a declared southern extent (`build-basemap.mjs`'s `US_EXTENT_ANCHORS`), the
    // same instrument #115 used for `ak`; the fit moves from k=904.5131300948573 to
    // k=892.2437067538316 and both land inside. The rect was NOT moved and could not have been:
    // `us` binds on HEIGHT, so its fitted extent fills 100.0% of the rect's height and the
    // vertical slack is exactly zero -- EYW's overshoot is 0.005210k for every k, and enlarging
    // the rect only raises k. See `US_EXTENT_ANCHORS` for the 638.6px threshold at which width
    // binds instead, and why that is not a rect anyone would ship.
    //
    // INSIDE ITS OWN RECT IS NOT THE SAME PROPERTY AS OUTSIDE EVERY OTHER PANEL'S FRAME, and
    // this test only states the first. A `us` airport can satisfy it while being drawn inside a
    // labelled inset laid over the conterminous panel -- `us` is the one panel with no frame of
    // its own, so nothing separates it from an inset above it. That second property is asserted
    // directly below (#122), over this same population, and it is not derivable from this one.
    const outside = placed
      .filter((p) => {
        const [x0, y0, x1, y1] = PANEL_RECTS[p.panel];
        return !(p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);
      })
      .map((p) => `${p.code}/${p.panel} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
    expect(outside).toEqual([]);
  });

  it("keeps every subject disc AND its label on the canvas", () => {
    // THE USER-VISIBLE DEFECT, and the one the issue's own sweep half-measured. `globals.css`
    // gives the map `svg:not(:root) { overflow: hidden }`, so anything outside the emitted
    // viewBox is CLIPPED, not merely far away. `/airport/SYA?y=2018` rendered a map of a
    // network whose centre was not on it.
    //
    // #123's crop did not weaken this, it sharpened the top edge. The window is unioned with
    // the ink actually emitted, so a mark BELOW the canvas floor now widens the window instead
    // of being cut off -- but the top is clamped at 0, precisely because this test guarantees
    // nothing is above it. Break that guarantee and the clamp becomes a clipper.
    //
    // The label box is checked, not just the disc, because that is the difference between
    // catching two airports and catching three: AKB's disc sat at x=7.0, inside the canvas, so
    // a disc-only check passed while its label ran to x=-19.8 and the page drew an unlabelled
    // subject. NO EXEMPTIONS -- this one holds everywhere.
    //
    // Marker geometry is `segmentMap.ts:504-506`: a circle of r=4.5 at the projected point, and
    // the code right-anchored at (x-7, y-8) in 11px `--font-mono`. Those four constants are a
    // hand-copy, and they are already pinned in bytes by `networkGolden.fixture.ts` (`r="4.5"`,
    // `x="573.0" y="154.2"` against a marker at 580.0,162.2 -- ORD is a `us` point, so #119's
    // declared southern extent moved it), so a drift reddens that guard rather than silently
    // loosening this one. The two text metrics are deliberate
    // OVER-estimates so the check errs early: 0.6em advance is IBM Plex Mono's own (600/1000),
    // and a full font-size of ascent above the baseline is more than any glyph in a 3-letter
    // uppercase code uses.
    const WIDTH = 960;
    // 544 since #122 (`segmentMap.ts`'s `HEIGHT`): the bottom tray moved down 44px to clear the
    // `us` rect and the canvas grew by the same 44 to hold it. Restated rather than imported,
    // like `albers.test.ts`'s copy and for the same reason -- a bound derived from the thing it
    // bounds proves nothing.
    const HEIGHT = 544;
    const R = 4.5;
    const offCanvas = placed
      .filter((p) => {
        const labelRight = p.x - 7;
        const labelLeft = labelRight - 11 * 0.6 * p.code.length;
        const labelTop = p.y - 8 - 11;
        return (
          p.x - R < 0 ||
          p.x + R > WIDTH ||
          p.y - R < 0 ||
          p.y + R > HEIGHT ||
          labelLeft < 0 ||
          labelRight > WIDTH ||
          labelTop < 0
        );
      })
      .map((p) => `${p.code}/${p.panel} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
    expect(offCanvas).toEqual([]);
  });

  it("keeps EYW the tightest `us` airport, and keeps its clearance off zero (#119)", () => {
    // THE PROPERTY THE CONTAINMENT SET ABOVE CANNOT SEE, and the reason this test exists as a
    // separate one rather than as a stronger assertion inside it. That test asks a BOOLEAN of
    // each airport -- `p.y <= y1` -- so it passes at EQUALITY. An anchor pulled north until
    // EYW sits exactly ON the rect's bottom edge leaves it fully green while the property is
    // one BTS coordinate revision away from breaking. #115 recorded the same shape for `ak`
    // ("the mutant that does kill it is pulling the Attu anchor east to -180"); this is that
    // mutant's `us` twin, and the assertion that catches it has to be a POSITION, not a set.
    //
    // Run as a mutant: `US_EXTENT_ANCHORS` set to EYW's OWN coordinates (24.556, -81.760) --
    // the obvious-looking "just anchor on the airport" choice. EYW's clearance goes to 0.00px,
    // THIS test goes red ("tightest EYW at 0.00px, clear of zero: false"), and "projects every
    // one of them INSIDE its own panel's rect" stays GREEN, along with both `us` declared-extent
    // tests below. That divergence is what this test is for. It also catches the second wrong
    // anchor -- Florida's minimum-latitude vertex, which leaves 0.32px -- so the floor is doing
    // work at both ends and not just guarding zero.
    //
    // IDENTITY AND FLOOR, NOT THE FIGURE. Which airport is tightest is a structural fact -- the
    // Keys are the southern extreme and EYW is the southernmost airport on them -- so it is
    // asserted exactly. The clearance itself is a dataset measurement (0.86px today, against
    // MTH's 4.99px as the next-tightest of the Keys), so it is asserted as a FLOOR, for the
    // same reason the population size above is: this file states measurements and is not
    // registered with `test_stated_counts.py`. The floor sits between 0 -- what the degenerate
    // anchor produces -- and the measured 0.86, and the live value is in the message either
    // way, so a red names the drift instead of just the panel.
    const [x0, y0, x1, y1] = PANEL_RECTS.us;
    const tightest = placed
      .filter((p) => p.panel === "us")
      .map((p) => ({
        code: p.code,
        clearance: Math.min(p.x - x0, x1 - p.x, p.y - y0, y1 - p.y),
      }))
      .sort((a, b) => a.clearance - b.clearance)[0];
    expect(
      `tightest ${tightest.code} at ${tightest.clearance.toFixed(2)}px, clear of zero: ${tightest.clearance >= 0.5}`,
    ).toBe(`tightest EYW at ${tightest.clearance.toFixed(2)}px, clear of zero: true`);
  });
});

describe("the `ak` declared extent (#115)", () => {
  it("classifies both anchors as `ak`, and carries them in the fit set", () => {
    // The silent failure this exists to catch: `regionOf`'s Alaska test is `lat > 51 && lon <
    // -129`, and Amatignak is 51.215 -- 0.215 degrees above that cliff. Retune the boundary
    // and the anchor moves to `us`, the `ak` fit collapses back to the coastline's own extent,
    // and ADK/AKB/SYA go off the canvas again -- while the coastline itself still draws exactly
    // as it did, so no path hash, no fit pin and no frame gate would notice. The two live
    // properties above WOULD go red on it as well.
    //
    // THIS TEST IS NOT A DB-FREE BACKSTOP. Its own assertions need no warehouse, but the
    // module-level `await placeEveryServedAirport()` above does, and it throws first -- so in a
    // checkout without one this test does not run at all. Measured, not reasoned about (see the
    // file header). What it genuinely adds is that a red here names the CAUSE, `-> us` becoming
    // `-> car`, instead of reporting a moved `k`.
    //
    // Read from the generator's own `AK_EXTENT_ANCHORS` and checked against the generated
    // artifact, which binds the two together rather than trusting either alone.
    expect(AK_EXTENT_ANCHORS.length).toBe(2);
    for (const a of AK_EXTENT_ANCHORS) {
      expect(`(${a.lat}, ${a.lon}) -> ${regionOf(a.lat, normalizeLon(a.lon))}`).toBe(
        `(${a.lat}, ${a.lon}) -> ak`,
      );
      expect(
        BASEMAP_FIT_POINTS.some((p) => p.lat === a.lat && p.lon === a.lon)
          ? `${a.lat},${a.lon} in BASEMAP_FIT_POINTS`
          : `${a.lat},${a.lon} MISSING from BASEMAP_FIT_POINTS`,
      ).toBe(`${a.lat},${a.lon} in BASEMAP_FIT_POINTS`);
    }
  });
});

describe("the `us` declared extent (#119)", () => {
  it("classifies its anchor as `us`, and carries it in the fit set", () => {
    // WHY THIS EARNS ITS PLACE: when `regionOf` re-files the anchor it names the CAUSE
    // ("-> car") instead of reporting a moved `k`. It is not the only guard: run the mutant
    // (`lon > -90`) and the `us` and `car` path hashes and fits in `basemap.test.ts` go red
    // too, because both panels' partitions change.
    //
    // It is NOT a coverage argument: this file's module-level await needs a warehouse, so
    // nothing in it runs without one. See the file header, where that is measured.
    //
    // The failure it describes is structurally Amatignak's -- `regionOf`'s Caribbean test is
    // `lat < 25 && lon > -70` and this anchor is at lat 24.551, BELOW 25, so only the longitude
    // clause keeps it in `us`, and moving that boundary west of -82.13 collapses the `us` fit
    // back to 1:110m Florida's own extent. Quantitatively it is far less precarious than
    // Amatignak's, which is why "the mirror of it" is not said here: Amatignak clears
    // `lat > 51` by 0.215 degrees, this anchor clears `lon > -70` by 12.129.
    //
    // Read from the generator's own `US_EXTENT_ANCHORS` and checked against the generated
    // artifact, which binds the two together rather than trusting either alone -- exactly the
    // arrangement #115 uses for `ak` directly above.
    expect(US_EXTENT_ANCHORS.length).toBe(1);
    for (const a of US_EXTENT_ANCHORS) {
      expect(`(${a.lat}, ${a.lon}) -> ${regionOf(a.lat, normalizeLon(a.lon))}`).toBe(
        `(${a.lat}, ${a.lon}) -> us`,
      );
      expect(
        BASEMAP_FIT_POINTS.some((p) => p.lat === a.lat && p.lon === a.lon)
          ? `${a.lat},${a.lon} in BASEMAP_FIT_POINTS`
          : `${a.lat},${a.lon} MISSING from BASEMAP_FIT_POINTS`,
      ).toBe(`${a.lat},${a.lon} in BASEMAP_FIT_POINTS`);
    }
  });

  it("binds the `us` fit's southern edge, rather than sitting inside it", () => {
    // The anchor is only worth carrying if it is the point the fit actually stretches to. `us`
    // binds on HEIGHT, so the panel's southernmost reference point projects EXACTLY onto the
    // rect's bottom edge -- that identity is the whole mechanism, and it is what makes every
    // airport north of the anchor provably inside the rect rather than observed to be.
    //
    // WHAT THIS TEST DOES NOT CATCH, run rather than reasoned about, because the division of
    // labour is only worth writing down if it is true. The obvious wrong anchor is Florida's
    // minimum-LATITUDE vertex (24.543, -81.815) instead of the vertex that projects furthest
    // south -- Albers is conic, so those differ; see `US_EXTENT_ANCHORS`. That anchor is still
    // the southernmost `us` reference point, so it still binds the edge and THIS assertion
    // stays green. Two other gates kill it: `basemap.test.ts`'s `us` fit pin (k=893.4354291484278
    // against the pinned 892.2437067538316), and the clearance test above, because it takes EYW
    // from 0.86px to 0.32px and through that test's floor. The second one was NOT predicted when
    // this comment was first written; it is here because the mutant was run.
    const fits = fitPanels(BASEMAP_FIT_POINTS);
    const [, , , bottom] = PANEL_RECTS.us;
    for (const a of US_EXTENT_ANCHORS) {
      const [, y] = project(a.lat, a.lon, fits);
      expect(`anchor y ${y.toFixed(4)} vs rect bottom ${bottom}`).toBe(
        `anchor y ${bottom.toFixed(4)} vs rect bottom ${bottom}`,
      );
    }
  });
});

describe("no inset frame is drawn over an airport that belongs to another panel (#122)", () => {
  // THE DEFECT, STATED OVER THE WHOLE POPULATION RATHER THAN OVER THE PANEL THAT HAD IT.
  // `renderMapCore` draws an inset's border at rect +/- 6 and its label inside that border, so
  // a foreign airport projecting into that box is drawn, with its own code beside it, inside a
  // frame naming somewhere it is not. `car` held 17 of them -- 12 Florida and 5 south Texas,
  // MIA at (708.4, 401.0) and EYW at (690.7, 423.1) -- on 293 measured (airport, year) views.
  //
  // WHY THIS IS NOT THE SAME TEST AS THE CONTAINMENT SWEEP ABOVE. That one asks whether each
  // airport is inside ITS OWN rect, which every one of those 17 was: they are `us` airports
  // sitting exactly where the `us` fit puts them. Nothing about their position was wrong. What
  // was wrong was that a second panel's frame was drawn on top of them. The two properties are
  // independent, and the sweep is green on both sides of the fix.
  //
  // THE FIXTURE IS THE REAL POPULATION, WHICH IS THE POINT. A hand-built fixture of a few
  // airports could not fail this way -- #122's own brief says so -- because the defect is a
  // near-miss: it needs MIA, 30px inside the old frame's top edge, or EYW, 0.9px above the `us`
  // rect's floor. Reading all 1,047 is what makes the fixture contain them without anyone
  // having to have thought of them.
  //
  // AN EXACT SORTED SET, never a count and never a bound, for the reason the sweep above gives:
  // a NEW violation is red, and so is a REMOVED one, so the exemption cannot be quietly widened.
  const FRAME_PAD = 6;
  it.each(["ak", "hi", "pac", "nwhi", "car", "sam"] as const)(
    "%s's frame holds no airport from another panel",
    (panel) => {
      const [x0, y0, x1, y1] = PANEL_RECTS[panel];
      const inside = placed
        .filter(
          (p) =>
            p.panel !== panel &&
            p.x >= x0 - FRAME_PAD &&
            p.x <= x1 + FRAME_PAD &&
            p.y >= y0 - FRAME_PAD &&
            p.y <= y1 + FRAME_PAD,
        )
        .map((p) => `${p.code}/${p.panel} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
      expect(`${panel}: ${inside}`).toBe(`${panel}: `);
    },
  );

  it("reads a population that actually reaches the frames, so the sweep is not vacuous", () => {
    // Without this, a `placed` that lost its Florida airports -- or a rect moved off the canvas
    // -- would make every assertion above pass by having nothing to test. The guard is that the
    // `car` frame's own NEIGHBOURHOOD is populated: airports exist just above it, which is what
    // made the old rect's overlap possible in the first place.
    const [, y0] = PANEL_RECTS.car;
    const justAbove = placed.filter((p) => p.panel === "us" && p.y > y0 - FRAME_PAD - 60);
    expect(justAbove.length).toBeGreaterThan(10);
  });
});

describe("a declared extent anchor sits just outside the airports it exists to place (#128)", () => {
  // THE UNGUARDED DIRECTION, AND THE ONLY ONE LEFT. `AK_EXTENT_ANCHORS` (#115) and
  // `US_EXTENT_ANCHORS` (#119) are hand transcriptions of extrema from Natural Earth 1:10m --
  // a file this repo does not commit and no `make` target fetches -- so the transcription
  // itself cannot be checked against its source in CI. The guards around them were one-sided:
  //
  //   too far IN  (under-reaching) -> the containment sweep above, and the clearance floor.
  //   too far OUT (over-reaching)  -> nothing. Every airport moves FURTHER inside its rect, so
  //                                   every containment property gets MORE true, and the only
  //                                   artifact that disagrees is the hand-pinned fit constant
  //                                   in `basemap.test.ts` that the same commit is re-pinning.
  //
  // That is review catching it, not a gate.
  //
  // WHAT THIS BINDS THE ANCHOR TO, and why it is not a second transcription: the BTS airport
  // population. An extent anchor exists to make a panel's fit contain the airports at its edge
  // -- that is the entire reason #115 and #119 added them -- so the anchor and the outermost
  // airport it protects must be close together on the axis the anchor declares. An anchor typed
  // a degree too far out lands a long way from that airport while every other gate stays green.
  // The airport coordinates come from the warehouse, not from this file, so nothing here
  // restates the constant it is checking.
  //
  // THE AXIS IS DERIVED, NOT DECLARED. An anchor governs whichever extreme of its panel's
  // reference set it attains, so this asks the reference set instead of carrying a table of
  // "Attu is the western one". Attu attains `minX`, Amatignak and the Marquesas Keys `maxY`.
  // Requiring that it attains SOMETHING is itself a check: an anchor inside the extent on every
  // axis is doing nothing at all, which no other gate would report.
  //
  // MEASURED TODAY, and every mutant RUN rather than predicted -- anchor edited AND `make
  // basemap` re-run, which is how a transcription error would actually land:
  //
  //   anchor                     gap     +0.5deg out   +1deg out
  //   Marquesas Keys (us, maxY)  0.86px     8.30px      15.45px
  //   Attu           (ak, minX)  3.30px     4.39px       5.46px
  //   Amatignak      (ak, maxY)  1.03px       --          6.65px
  //
  // THE CONTAINMENT SWEEP IS GREEN ON EVERY ONE OF THEM. That divergence is the whole point: if
  // it reddened too, this test would be redundant and the asymmetry would still be open.
  //
  // The EYW clearance test is a more interesting case than #128 assumed, and the mutants are
  // what showed it. On the two `us` mutants its FLOOR stays green -- it reports "clear of zero:
  // TRUE" -- and it reddens through its IDENTITY clause instead, because rescaling the panel
  // makes BLI, not EYW, the tightest `us` airport. That is a side effect of a rescale, not a
  // statement about over-reach: it says nothing on either `ak` mutant, and it would say nothing
  // about an over-reach that happened to leave the same airport tightest. So the floor is
  // genuinely one-sided, as #128 says; what this test adds is the other side.
  //
  // WHAT THIS DOES NOT CATCH, because it was run and not assumed: Amatignak over-reaching by
  // 0.2 degrees. `ak` binds on WIDTH, so that anchor governs only the panel's vertical
  // CENTRING, and 0.2 degrees moves it about 1.1px -- inside the ceiling. It is bounded rather
  // than open, and the bound is `regionOf`'s own: Amatignak sits at 51.215 against an Alaska
  // test of `lat > 51`, so it cannot over-reach by more than 0.215 degrees without being
  // re-filed as `us`, which the `ak` declared-extent test above catches by name. Between the
  // two, every magnitude that moves the panel more than about a pixel is covered.
  //
  // WHEN THIS GOES RED, THE ANSWER IS TO RE-DERIVE THE ANCHOR, NOT TO RAISE THE CEILING.
  // The margin is deliberately narrow -- Attu measures 3.30px against a 4px ceiling -- because
  // `ak` draws only 2.4px per degree of longitude, so a ceiling loose enough to feel comfortable
  // there is a ceiling that cannot catch a transposed digit. The failure message says so, and it
  // says it where the person who sees the red will read it.
  //
  // AND A RED HERE MAY BE TRUE. This gate is deliberately bound to a dataset that moves. If a
  // BTS refresh drops SYA from the fact-present population, the westernmost `ak` airport jumps
  // hundreds of pixels east and this goes red -- correctly, because the Attu anchor would then
  // have no airport left to justify it and the panel's extent needs re-deriving. CLAUDE.md
  // records a refresh renaming aircraft type 699 out from under an entire fixture set; this is
  // the same class of event. Read the message before deciding it is a broken test.
  const CEILING_PX = 4;

  /** Every reference point of one panel, in that panel's own raw-Albers space -- the exact set
   *  `fitPanels` partitions and fits, so "attains an extreme" here means the same thing it
   *  means to the fit. */
  function referenceExtremes(panel: Panel) {
    const raw = BASEMAP_FIT_POINTS.filter((p) => regionOf(p.lat, normalizeLon(p.lon)) === panel);
    expect(raw.length).toBeGreaterThan(0);
    const xs = raw.map((p) => project(p.lat, p.lon, BASEMAP_FITS)[0]);
    const ys = raw.map((p) => project(p.lat, p.lon, BASEMAP_FITS)[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  it.each([
    ["ak", AK_EXTENT_ANCHORS as { lat: number; lon: number }[]],
    ["us", US_EXTENT_ANCHORS as { lat: number; lon: number }[]],
  ] as const)("%s's anchors each bind an axis, within reach of that axis's outermost airport", (panel, anchors) => {
    const ref = referenceExtremes(panel as Panel);
    const airports = placed.filter((p) => p.panel === panel);
    expect(airports.length).toBeGreaterThan(0);
    const air = {
      minX: Math.min(...airports.map((p) => p.x)),
      maxX: Math.max(...airports.map((p) => p.x)),
      minY: Math.min(...airports.map((p) => p.y)),
      maxY: Math.max(...airports.map((p) => p.y)),
    };

    for (const a of anchors) {
      const [ax, ay] = project(a.lat, a.lon, BASEMAP_FITS);
      // Exact equality is right here: both sides come from the same `project` call over the same
      // array, so the anchor's own coordinate IS the extreme when it attains one.
      const axes = (
        [
          ["minX", ax === ref.minX, ax, air.minX],
          ["maxX", ax === ref.maxX, ax, air.maxX],
          ["minY", ay === ref.minY, ay, air.minY],
          ["maxY", ay === ref.maxY, ay, air.maxY],
        ] as const
      ).filter(([, attained]) => attained);

      expect(`(${a.lat}, ${a.lon}) binds ${axes.length} axes`).not.toBe(
        `(${a.lat}, ${a.lon}) binds 0 axes`,
      );

      for (const [axis, , anchorAt, airportAt] of axes) {
        const gap = Math.abs(anchorAt - airportAt);
        expect(
          `${panel} ${axis} anchor (${a.lat}, ${a.lon}) is ${gap.toFixed(2)}px from the outermost ` +
            `airport on that axis, within ${CEILING_PX}px: ${gap <= CEILING_PX} ` +
            `-- if false, RE-DERIVE THIS ANCHOR from Natural Earth 1:10m; do not raise the ceiling`,
        ).toBe(
          `${panel} ${axis} anchor (${a.lat}, ${a.lon}) is ${gap.toFixed(2)}px from the outermost ` +
            `airport on that axis, within ${CEILING_PX}px: true ` +
            `-- if false, RE-DERIVE THIS ANCHOR from Natural Earth 1:10m; do not raise the ceiling`,
        );
      }
    }
  });
});
