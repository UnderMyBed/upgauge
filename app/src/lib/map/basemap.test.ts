/**
 * `basemap.ts` is a thin reader over the generated module (`basemapPaths.generated.ts`,
 * produced by `app/scripts/build-basemap.mjs` -- see `make basemap`). These tests exercise
 * the reader, not the generator; the generator's own reproducibility is proven by
 * `make basemap && git diff --stat ...` (Makefile) and the mutant recorded in
 * `.superpowers/sdd/2026-08-01-m7-maps/task-7-report.md`, not by a unit test, since a unit
 * test re-running the same in-process function can't observe a byte-diff across two
 * separate `node` invocations.
 */
import { describe, expect, it } from "vitest";
import { fitPanels } from "./albers";
import { basemapPathsFor, BASEMAP_FIT_POINTS } from "./basemap";

describe("basemapPathsFor", () => {
  it("emits path data for the conterminous panel", () => {
    const paths = basemapPathsFor(["us"]);
    expect(paths).toMatch(/<path[^>]+d="M[\d.,\s\-LZ]+"/);
  });

  it("emits nothing for a panel that was not requested", () => {
    // Catches: shipping all five panels' coastlines on every page. Most airports
    // touch two; the Pacific and Caribbean outlines are dead weight on them.
    expect(basemapPathsFor(["us"])).not.toContain('data-panel="pac"');
  });

  it("is stable across calls", () => {
    expect(basemapPathsFor(["us", "ak"])).toBe(basemapPathsFor(["us", "ak"]));
  });

  it("emits paths for Alaska and Hawaii when requested", () => {
    // Catches: a generator that only ever wrote the `us` panel's rings.
    expect(basemapPathsFor(["ak"])).toMatch(/data-panel="ak"/);
    expect(basemapPathsFor(["hi"])).toMatch(/data-panel="hi"/);
  });

  it("emits paths for the Caribbean panel (M7 Task 7b: ne_50m_car.json)", () => {
    // Catches: a generator that reads app/geo/ne_110m_us.json only and never merges in
    // ne_50m_car.json at all. Puerto Rico and the USVI both land in `car` via `regionOf`,
    // same as any other feature -- no special-cased panel-assignment path exists for them.
    expect(basemapPathsFor(["car"])).toMatch(/data-panel="car"/);
    expect(basemapPathsFor(["car"])).toContain('data-name="PR"');
    expect(basemapPathsFor(["car"])).toContain('data-name="VI"');
  });

  it("requesting `pac` still emits nothing, not an error -- the one gap left open", () => {
    // Guam/Saipan/Tinian/Rota/American Samoa/Midway remain unresolvable as distinct polygons
    // at any resolution cheaply reachable from this mirror (checked, not assumed -- see
    // build-basemap.mjs's header) -- out of scope for M7 Task 7b (6 fact-present airports
    // vs. `car`'s 74). `pac` still has zero committed reference points, so `fitPanels` never
    // produces a fit for it and the generator emits no path. A page reaching into the
    // Pacific still renders (via `project`'s own `us`-fit fallback); it just draws no
    // coastline under those arcs, disclosed on the page itself (NetworkMap.test.tsx).
    expect(() => basemapPathsFor(["pac"])).not.toThrow();
    expect(basemapPathsFor(["pac"])).toBe("");
  });
});

describe("geometry survives simplification and projection intact", () => {
  // Every existing assertion above matches `d="M[\d.,\s\-LZ]+"` or checks for the presence
  // of a `data-panel` attribute -- both are satisfied by a FULLY collapsed ring
  // (`M x,y L x,y Z`, the exact shape the closed-ring RDP bug produced before it was
  // fixed: see build-basemap.mjs's `rdpRing`) and by a PARTIALLY collapsed one. None of
  // them can tell a real state outline from a single repeated point. This test extracts
  // one real feature's own `d` string and asserts a property a collapsed ring cannot have:
  // non-zero projected area.
  //
  // VA is the fixture (not NC) because its two-ring island geometry means a regression
  // that only collapses, say, the SECOND ring (not both) still has to be caught -- a test
  // that only looked at ring count, or only at the first `M...Z`, would miss that.
  function pathDataFor(dataName: string, panelName: "us" | "car" = "us"): string {
    const panel = basemapPathsFor([panelName]);
    const match = panel.match(new RegExp(`data-name="${dataName}" d="([^"]*)"`));
    if (!match) throw new Error(`no path found for data-name="${dataName}"`);
    return match[1];
  }

  function boundingBoxArea(subpath: string): number {
    const coords = [...subpath.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const,
    );
    const xs = coords.map((c) => c[0]);
    const ys = coords.map((c) => c[1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  }

  // Split into individual closed subpaths ("M...Z" each) and check EACH ONE's own
  // bounding box, never the combined box across all of a feature's rings. This is load-
  // bearing, not a style choice: the closed-ring RDP bug collapses each ring to its OWN
  // single repeated point independently, and VA's two rings collapse to two DIFFERENT
  // points (measured: (645.5, 242.2) and (739.1, 203.9)). A bbox computed over the
  // COMBINED coordinate set of both degenerate points is ~93.6 x 38.3px -- nonzero, and
  // this test passed under that exact mutant on the first attempt. Only a per-subpath box
  // is zero for a collapsed ring regardless of how many other rings in the same feature
  // are intact.
  function subpathsOf(d: string): string[] {
    return d
      .split(/(?<=Z)\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  it("VA's committed geometry", () => {
    // Ground truth, measured directly against the current generated artifact: VA emits
    // TWO closed subpaths (its mainland ring plus its island geometry, e.g. Chincoteague).
    // The mainland ring spans a ~97.7 x 54.6px bounding box (area ~5,334 px^2); the
    // smaller island ring spans ~5.3 x 13.9px (area ~74 px^2). A ring collapsed by the
    // closed-ring RDP bug emits exactly one distinct coordinate pair repeated, so ITS OWN
    // bounding box area is exactly 0 -- regardless of what the other ring in the same
    // feature does, which is why this checks every subpath independently rather than the
    // feature's combined box (see subpathsOf's comment for why the combined box is fooled
    // by two rings collapsing to two DIFFERENT single points).
    const d = pathDataFor("VA");
    const subpaths = subpathsOf(d);
    expect(subpaths).toHaveLength(2);

    // Threshold (20 px^2) sits comfortably between 0 (what any collapsed ring, full or
    // partial, produces) and the smaller of VA's two measured ring areas (~74 px^2) --
    // roughly a 3.7x margin under the tightest real case, leaving headroom for a future RDP
    // epsilon retune without this test needing to move. Nobody should raise this number
    // without re-measuring VA's own smaller ring first.
    for (const subpath of subpaths) {
      expect(boundingBoxArea(subpath)).toBeGreaterThan(20);
    }
  });

  // M7 Task 7b: the `car` panel gained real coastline (ne_50m_car.json, Natural Earth 1:50m
  // Admin-0 Countries -- 1:110m has no separate USVI feature at all, and only a 9-point
  // Puerto Rico). Same trap as VA above, on a different panel and a different input file:
  // Puerto Rico is itself a MultiPolygon (main island + Vieques + Culebra), so a regression
  // that collapses only ONE of its three rings must still be caught -- a test checking only
  // ring count, or only the largest ring, would miss it.
  it("Puerto Rico's committed geometry (car panel)", () => {
    // Ground truth, measured directly against the current generated artifact: PR emits
    // THREE closed subpaths after simplification -- the main island (~144.3 x 51.2px, area
    // ~7,388 px^2), Vieques (~22.1 x 5.5px, area ~122 px^2), and Culebra (~6.7 x 5.8px, area
    // ~39 px^2, the tightest of the three). A ring collapsed by the closed-ring RDP bug (or
    // any regression that drops an island to one repeated point) has a bounding-box area of
    // exactly 0 for that ring, regardless of what the other two rings do -- same reasoning
    // as VA's test, checked per-subpath, never over the feature's combined coordinate set.
    const d = pathDataFor("PR", "car");
    const subpaths = subpathsOf(d);
    expect(subpaths).toHaveLength(3);

    // Threshold (10 px^2): comfortably between 0 (what any collapsed ring produces) and
    // Culebra's own measured ~39 px^2, the smallest of the three real rings -- roughly a
    // 3.9x margin, in the same spirit as VA's own margin above. Don't raise this without
    // re-measuring Culebra's ring first.
    for (const subpath of subpaths) {
      expect(boundingBoxArea(subpath)).toBeGreaterThan(10);
    }
  });
});

describe("BASEMAP_FIT_POINTS", () => {
  it("is the fixed reference set the generator fit the coastline to -- not the empty set", () => {
    expect(BASEMAP_FIT_POINTS.length).toBeGreaterThan(1000);
  });

  it("stays unchanged when an IN-BOUNDS subject point happens to be unioned in", () => {
    // This is the property the brief calls out: "the basemap is fitted to fixed panel
    // rectangles, not to the subject's arcs -- otherwise the coastline would move from
    // page to page." SEA (47.45, -122.31) sits well inside the conterminous landmass, so
    // unioning it into BASEMAP_FIT_POINTS happens not to move the `us` panel's fit.
    //
    // This test ALONE cannot tell a correct caller from a buggy one -- see the next test,
    // which is the one that can. A per-page network map (`networkMap.ts`, M7 Task 8) does
    // NOT union subject points into BASEMAP_FIT_POINTS at all; it reuses
    // `fitPanels(BASEMAP_FIT_POINTS)`'s fit verbatim. An earlier draft of this codebase's own
    // guidance (this file, the generator, and its header template) recommended the union
    // instead, and this in-bounds-only test is exactly why that wrong recommendation survived
    // unnoticed: it happened to pass under both the correct rule and the wrong one.
    const fitsAlone = fitPanels(BASEMAP_FIT_POINTS);
    const fitsWithSubject = fitPanels([...BASEMAP_FIT_POINTS, { lat: 47.45, lon: -122.31 }]);
    expect(fitsWithSubject.get("us")).toEqual(fitsAlone.get("us"));
  });

  it("WOULD move if an out-of-bounds subject point were unioned in -- why the union is wrong", () => {
    // The property the test above cannot show: fitPanels scales to the min/max extent of
    // whatever it is given, so a point outside BASEMAP_FIT_POINTS's own extent (a real,
    // ordinary case -- a coastal airport seaward of a simplified coastline, since
    // simplification pulls the line inward) genuinely changes the `us` fit. This is exactly
    // why `networkMap.ts` must reuse `fitPanels(BASEMAP_FIT_POINTS)` VERBATIM rather than
    // unioning anything into it -- a union-based caller would silently draw its arcs at a
    // different scale than the coastline beneath them. (20, -80) regionOf's to `us` (it is
    // south of Alaska's/Hawai'i's/the Pacific panel's own tests and not in the Caribbean
    // panel's lon>-70 band either) but sits south of Key West (~24.5N), the conterminous
    // landmass's own southernmost point -- outside every committed `us` reference point's
    // extent, exactly the "coastal airport seaward of the simplified line" shape this test
    // exists to demonstrate.
    const fitsAlone = fitPanels(BASEMAP_FIT_POINTS);
    const fitsWithOutOfBoundsSubject = fitPanels([...BASEMAP_FIT_POINTS, { lat: 20, lon: -80 }]);
    expect(fitsWithOutOfBoundsSubject.get("us")).not.toEqual(fitsAlone.get("us"));
  });
});
