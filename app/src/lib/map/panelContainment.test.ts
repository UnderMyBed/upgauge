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
import { AK_EXTENT_ANCHORS } from "../../../scripts/build-basemap.mjs";

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
    // THE TWO EXEMPTIONS ARE REAL, PRE-EXISTING AND FILED AS #119. EYW (Key West) and MTH
    // (Marathon) sit 4.7px and 0.5px below the `us` rect's bottom edge of 424, because Natural
    // Earth 1:110m's Florida tip stops north of the Keys. Both stay on the canvas, so the
    // property below is clean for them -- but both land inside the CARIBBEAN inset's drawn
    // frame, so `/airport/EYW` puts its subject disc, and `/airport/MIA` an EYW node, on top of
    // a labelled Caribbean box. Fixing it means moving the `us` rect, which rewrites every path
    // byte in the generated artifact; out of scope for #115 and left listed rather than
    // omitted, the way the land test lists `car`. #119 says to delete these two entries in the
    // same commit that fixes them, since this assertion goes red either way.
    const outside = placed
      .filter((p) => {
        const [x0, y0, x1, y1] = PANEL_RECTS[p.panel];
        return !(p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);
      })
      .map((p) => `${p.code}/${p.panel} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
    expect(outside).toEqual([
      "EYW/us (693.6, 428.7)",
      "MTH/us (703.4, 424.5)",
    ]);
  });

  it("keeps every subject disc AND its label on the canvas", () => {
    // THE USER-VISIBLE DEFECT, and the one the issue's own sweep half-measured. `globals.css`
    // gives the map `svg:not(:root) { overflow: hidden }`, so anything outside the 960x500
    // viewBox is CLIPPED, not merely far away. `/airport/SYA?y=2018` rendered a map of a
    // network whose centre was not on it.
    //
    // The label box is checked, not just the disc, because that is the difference between
    // catching two airports and catching three: AKB's disc sat at x=7.0, inside the canvas, so
    // a disc-only check passed while its label ran to x=-19.8 and the page drew an unlabelled
    // subject. NO EXEMPTIONS -- this one holds everywhere.
    //
    // Marker geometry is `segmentMap.ts:504-506`: a circle of r=4.5 at the projected point, and
    // the code right-anchored at (x-7, y-8) in 11px `--font-mono`. Those four constants are a
    // hand-copy, and they are already pinned in bytes by `networkGolden.fixture.ts` (`r="4.5"`,
    // `x="574.4" y="156.2"` against a marker at 581.4,164.2), so a drift reddens that guard
    // rather than silently loosening this one. The two text metrics are deliberate
    // OVER-estimates so the check errs early: 0.6em advance is IBM Plex Mono's own (600/1000),
    // and a full font-size of ascent above the baseline is more than any glyph in a 3-letter
    // uppercase code uses.
    const WIDTH = 960;
    const HEIGHT = 500;
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
});

describe("the `ak` declared extent (#115)", () => {
  it("classifies both anchors as `ak`, and carries them in the fit set", () => {
    // The silent failure this exists to catch: `regionOf`'s Alaska test is `lat > 51 && lon <
    // -129`, and Amatignak is 51.215 -- 0.215 degrees above that cliff. Retune the boundary
    // and the anchor moves to `us`, the `ak` fit collapses back to the coastline's own extent,
    // and ADK/AKB/SYA go off the canvas again -- while the coastline itself still draws exactly
    // as it did, so no path hash, no fit pin and no frame gate would notice. The two live
    // properties above WOULD go red, but they need the database; this one does not, so it still
    // fires in an environment where those skip.
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
