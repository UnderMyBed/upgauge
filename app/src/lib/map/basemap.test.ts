/**
 * `basemap.ts` is a thin reader over the generated module (`basemapPaths.generated.ts`,
 * produced by `app/scripts/build-basemap.mjs` -- see `make basemap`). These tests exercise
 * the reader, not the generator; the generator's own reproducibility is proven by
 * `make basemap && git diff --stat ...` (Makefile) and the mutant recorded in
 * `.superpowers/sdd/2026-08-01-m7-maps/task-7-report.md`, not by a unit test, since a unit
 * test re-running the same in-process function can't observe a byte-diff across two
 * separate `node` invocations.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fitPanels, PANEL_RECTS, project } from "./albers";
import { basemapPathsFor, BASEMAP_FIT_POINTS } from "./basemap";
// The generator's OWN function, not a re-implementation of it -- see build-basemap.mjs's
// `loadReferencePointsAndFits` doc comment for why this is exported rather than kept
// private. Importing it does NOT regenerate the committed artifact: `main()`'s write is
// guarded to run only when the script is executed directly (`node build-basemap.mjs`), never
// on import.
import { loadReferencePointsAndFits } from "../../../scripts/build-basemap.mjs";

describe("basemapPathsFor", () => {
  it("emits path data for the conterminous panel", () => {
    const paths = basemapPathsFor(["us"]);
    expect(paths).toMatch(/<path[^>]+d="M[\d.,\s\-LZ]+"/);
  });

  it("emits nothing for a panel that was not requested", () => {
    // Catches: shipping all seven panels' coastlines on every page. Most airports
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

  it("emits paths for the Marianas panel (#111: ne_50m_pac.json)", () => {
    // The inverse of the test this replaces, which asserted `basemapPathsFor(["pac"]) === ""`
    // outright on the strength of a header comment claiming Natural Earth had no polygon for
    // these territories at any cheaply reachable resolution. That claim was false, and had
    // been for a milestone: Guam and N. Mariana Is. are in the very 1:50m file
    // ne_50m_car.json was cut from. Both `data-name`s, not just the panel attribute -- MP is
    // a 6-ring MultiPolygon and GU a single polygon, so a regression that dropped one feature
    // while keeping the other still has to be caught.
    expect(basemapPathsFor(["pac"])).toMatch(/data-panel="pac"/);
    expect(basemapPathsFor(["pac"])).toContain('data-name="GU"');
    expect(basemapPathsFor(["pac"])).toContain('data-name="MP"');
  });

  it("emits paths for the American Samoa panel (#111)", () => {
    // `sam` is a panel rather than part of `pac` because ONE Albers fit cannot carry both:
    // the two are ~5,000 km apart, so a shared fit puts Tinian and Saipan 2.73px apart even
    // at full canvas width, and PPG at (1892.5, 1102.0) under this commit's own `pac` fit. Catches a
    // regression that puts American Samoa back into `pac`'s input or its region test.
    expect(basemapPathsFor(["sam"])).toMatch(/data-panel="sam"/);
    expect(basemapPathsFor(["sam"])).toContain('data-name="AS"');
  });

  it("requesting `nwhi` emits nothing, not an error -- the one gap left open", () => {
    // Midway is the gap that survived #111, and it is a property of the SOURCE rather than of
    // scope: at 1:10m it exists only inside a 13-ring `U.S. Minor Outlying Is.` feature that
    // also contains Navassa Island in the CARIBBEAN, and build-basemap.mjs classifies a whole
    // feature by regionOf of its first ring's first point -- so taking Midway that way would
    // project Navassa into the Pacific. `nwhi` therefore has zero committed reference points,
    // `fitPanels` never produces a fit for it, and the generator emits no path. A page
    // reaching Midway still renders it correctly, via networkMap.ts's subject-derived
    // fallback, and the gap is disclosed on the page itself (NetworkMap.test.tsx).
    expect(() => basemapPathsFor(["nwhi"])).not.toThrow();
    expect(basemapPathsFor(["nwhi"])).toBe("");
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
  function pathDataFor(dataName: string, panelName: "us" | "car" | "pac" | "sam" = "us"): string {
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

  // Final whole-branch review, Important #6: `BASEMAP_FIT_POINTS` was a LOSSY copy of what
  // the generator actually fit the coastline to. The generator emitted every reference point
  // through `fmt2` (`toFixed(3)`) when writing `BASEMAP_FIT_POINTS`, but -- before this fix --
  // computed the `fits` used to project the coastline itself from the RAW, unrounded points.
  // For `ne_110m_us.json` (already committed at 3 decimals) that was a no-op; for
  // `ne_50m_car.json` (M7 Task 7b, committed at 4 decimals) it was not, so the fit baked into
  // every `car` coastline path was derived from a DIFFERENT set of numbers than
  // `fitPanels(BASEMAP_FIT_POINTS)` recomputes at runtime -- sub-pixel (<=0.1px), not a visible
  // defect, but the "bit-for-bit identical input" invariant the whole Task 8 fit fix rests on
  // was true by accident for two panels and false, unguarded, for the third.
  //
  // This calls the GENERATOR'S OWN `loadReferencePointsAndFits` (not a re-implementation of
  // its rounding/sorting/ring-walk) and asserts its `fits` are deep-equal to
  // `fitPanels(BASEMAP_FIT_POINTS)` for every panel that has one -- the direct statement of
  // the invariant, provable rather than assumed close.
  it("the generator's own fit matches fitPanels(BASEMAP_FIT_POINTS), for every panel", () => {
    const { fits: generatorFits } = loadReferencePointsAndFits();
    const runtimeFits = fitPanels(BASEMAP_FIT_POINTS);
    expect(generatorFits.size).toBeGreaterThan(0);
    for (const panel of generatorFits.keys()) {
      expect(runtimeFits.get(panel)).toEqual(generatorFits.get(panel));
    }
  });
});

describe("the Pacific panels' committed geometry (#111)", () => {
  // Same trap as VA's and PR's tests above -- the closed-ring RDP bug collapses each ring to
  // its OWN single repeated point, so every check is per-subpath, never over a feature's
  // combined coordinate set.
  //
  // WHAT IS DIFFERENT HERE, AND WHY THERE IS NO 20 px^2 / 10 px^2 THRESHOLD FOR MP: at
  // RDP_EPSILON_DEG = 0.05 the four northern Mariana rings (Farallon de Pajaros, Anatahan,
  // Agrihan, Pagan) measure 1.20, 1.40, 3.20 and 3.91 px^2. There is no threshold above ~1
  // px^2 that clears them, and inventing one that happens to pass is worse than having none.
  // The reason is not RDP: those islands are 2-4 km across, and at `pac`'s k of 2211 they are
  // 2.3-4.2px wide UNSIMPLIFIED -- RDP costs them about 1.5px of height on an already
  // sub-pixel feature. A per-input epsilon would buy nothing and is a code path M7 Task 7b
  // explicitly refused.
  //
  // So the per-subpath assertion is the EXACT statement of the bug instead of a proxy for it:
  // the collapse emits `M x,y L x,y Z` -- ONE distinct coordinate pair, and a bounding box
  // that is exactly 0 in BOTH dimensions. Two distinct pairs and a non-zero box in both
  // dimensions is what real geometry has and what a collapsed ring cannot. Real thresholds go
  // where they are defensible: GU and AS below.
  function pathDataFor(dataName: string, panelName: "pac" | "sam"): string {
    const panel = basemapPathsFor([panelName]);
    const match = panel.match(new RegExp(`data-name="${dataName}" d="([^"]*)"`));
    if (!match) throw new Error(`no path found for data-name="${dataName}"`);
    return match[1];
  }

  function subpathsOf(d: string): string[] {
    return d
      .split(/(?<=Z)\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function coordsOf(subpath: string): [number, number][] {
    return [...subpath.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const as [number, number],
    );
  }

  function boxOf(subpath: string): { w: number; h: number; distinct: number } {
    const coords = coordsOf(subpath);
    const xs = coords.map((c) => c[0]);
    const ys = coords.map((c) => c[1]);
    return {
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
      distinct: new Set(coords.map((c) => `${c[0]},${c[1]}`)).size,
    };
  }

  it("the Northern Marianas' six rings each survive simplification", () => {
    // Ground truth against the current generated artifact: 6 subpaths, measured bounding
    // boxes 3.91 / 1.40 / 3.20 / 1.20 / 27.54 / 15.95 px^2, with 2 or 4 distinct coordinate
    // pairs each. A ring collapsed by the closed-ring RDP bug has exactly 1 distinct pair and
    // a box that is 0 x 0 -- regardless of what the other five rings do.
    const subpaths = subpathsOf(pathDataFor("MP", "pac"));
    expect(subpaths).toHaveLength(6);
    for (const subpath of subpaths) {
      const { w, h, distinct } = boxOf(subpath);
      expect(distinct).toBeGreaterThanOrEqual(2);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });

  it("Guam's committed geometry", () => {
    // Ground truth: ONE subpath, 10.9 x 14.1px, area ~153.7 px^2. Threshold 50 px^2 -- a 3.1x
    // margin, the same spirit as VA's 3.7x and PR's 3.9x above. Don't raise it without
    // re-measuring Guam's own ring first.
    const subpaths = subpathsOf(pathDataFor("GU", "pac"));
    expect(subpaths).toHaveLength(1);
    const { w, h } = boxOf(subpaths[0]);
    expect(w * h).toBeGreaterThan(50);
  });

  it("American Samoa's committed geometry", () => {
    // Ground truth: ONE subpath (Tutuila), 180.5 x 62.2px, area 11,227.10 px^2. Threshold
    // 3000 px^2 -- a 3.7x margin, matching VA's.
    //
    // The drawn box is 62.2 tall inside a fit whose extent fills 76.0 (`PANEL_RECTS.sam`'s
    // comment), and the difference is not a bug: the fit is taken on all 8 source vertices
    // while the path is drawn from the 5 RDP keeps, and one of the three drops is the vertex
    // defining Tutuila's northern edge. Known limitation, recorded rather than hidden --
    // Natural Earth's 1:50m Tutuila is 8 vertices, so `sam` draws about 48.5px of outline per
    // source vertex (387.9px of drawn perimeter over 8) against the 6-10px `hi` and `car`
    // manage. The shape is coarse at this scale. It is sized for the tray anyway because the
    // frame has to hold PPG's 2px node and its 9px label; a fidelity-matched box would be
    // about 30x13px, narrower than the word printed on top of it.
    const subpaths = subpathsOf(pathDataFor("AS", "sam"));
    expect(subpaths).toHaveLength(1);
    const { w, h } = boxOf(subpaths[0]);
    expect(w * h).toBeGreaterThan(3000);
  });
});

describe("every Pacific-reaching airport lands inside its own inset (#111)", () => {
  // The acceptance property of #111, asserted through the REAL committed fit and against
  // albers.ts's own PANEL_RECTS rather than a copy of it. `PANEL_RECTS` is exported for
  // exactly this.
  //
  // The coordinates below are HAND-COPIED LITERALS, not a warehouse read -- this file has no
  // database dependency and gains none here. They were checked against `dim_airport`
  // (`is_latest`) on 2026-08-25 and matched to the digit. State the limitation rather than the
  // convenience: a BTS refresh that revises a coordinate leaves this test green against a stale
  // number, which is the class that renamed aircraft type 699 out from under the `/aircraft`
  // slug fixtures. What it does still prove under that drift is the projection and the layout,
  // which is what #111 is about.
  //
  // Seven fact-present airports reach a Pacific panel over the trailing 12: GUM, HNL, PPG,
  // ROP, SFO, SPN and TIQ. Before #111 they were stated as six everywhere, and the omitted
  // one was PPG -- the one that decides the layout, because it is 5,000 km from the Marianas.
  const fits = fitPanels(BASEMAP_FIT_POINTS);
  const COORDS: Record<string, [number, number]> = {
    GUM: [13.48388889, 144.79722222],
    ROP: [14.17444444, 145.24111111],
    TIQ: [14.99916667, 145.61944444],
    SPN: [15.12027778, 145.73],
    PPG: [-14.33166667, -170.71138889],
    HNL: [21.31777778, -157.92027778],
    UAM: [13.58388889, 144.93],
  };
  const at = (code: string) => project(COORDS[code][0], COORDS[code][1], fits);

  it.each([
    ["GUM", "pac"],
    ["ROP", "pac"],
    ["TIQ", "pac"],
    ["SPN", "pac"],
    ["UAM", "pac"],
    ["PPG", "sam"],
    ["HNL", "hi"],
  ] as const)("%s projects inside the %s rect", (code, panel) => {
    const [x, y] = at(code);
    const [x0, y0, x1, y1] = PANEL_RECTS[panel];
    const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
    expect(`${code} at (${x.toFixed(1)}, ${y.toFixed(1)}) inside ${panel}: ${inside}`).toBe(
      `${code} at (${x.toFixed(1)}, ${y.toFixed(1)}) inside ${panel}: true`,
    );
  });

  it("keeps the four Marianas airports mutually distinguishable", () => {
    // A node is r=2 and a label is font-size 9, so anything under ~6px renders as one dot.
    // The binding pair is SPN-TIQ (Saipan and Tinian, 18 km apart, on an undirected route
    // filing 78,420 seats over the trailing 12 -- `fct_route_month`, because the map draws one
    // arc per undirected route; the directed `fct_segment_month` halves are 39,908 and 38,512
    // and neither is the arc's own figure), NOT the more obvious GUM-SPN: under the old 100x76 rect
    // with Marianas-only geometry, GUM-SPN measures 25.60px and passes while SPN-TIQ measures
    // 2.21px. A test written against GUM-SPN could not have died for its stated reason.
    //
    // This is a DISTANCE assertion, not a "both nodes are present" one, for CLAUDE.md's
    // standing reason: presence is satisfied by two dots on top of each other.
    const codes = ["GUM", "ROP", "TIQ", "SPN"] as const;
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        const a = at(codes[i]);
        const b = at(codes[j]);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        expect(`${codes[i]}-${codes[j]}: ${(d >= 6).toString()} (${d.toFixed(2)}px)`).toBe(
          `${codes[i]}-${codes[j]}: true (${d.toFixed(2)}px)`,
        );
      }
    }
  });
});

describe("the panels #111 must not have moved", () => {
  it("holds us/ak/hi/car to the exact path bytes they had before #111", () => {
    // #111's acceptance criterion, stated at the only altitude that actually says it: the
    // PATH STRINGS, byte for byte. The fit assertion below names WHICH panel moved and by how
    // much, which is the useful thing when one does -- but a fit is only sensitive to a
    // coordinate that moves a panel's min/max EXTENT. Measured: nudging an interior WA vertex
    // 1 degree west leaves all four fits untouched and this hash red, which is exactly the
    // mutant that proved the fit check alone insufficient. Both assertions, or the guard has a
    // hole in the shape of every interior vertex in the file.
    //
    // Hashes rather than 100KB of inline `d` attributes, and NOT a substitute for `make
    // basemap`'s zero-diff gate: that gate proves the artifact reproduces from its inputs, but
    // it lives in `make verify`, which runs on schedule and workflow_dispatch only and never on
    // a pull request. This runs in `make app-check`, which does.
    //
    // A legitimate future basemap refresh moves these. Re-measure and say so in the commit;
    // never edit one to match a diff you have not read.
    const hashes = Object.fromEntries(
      (["us", "ak", "hi", "car"] as const).map((panel) => [
        panel,
        createHash("sha256").update(basemapPathsFor([panel])).digest("hex"),
      ]),
    );
    expect(hashes).toEqual({
      us: "a1355b846c078a0d58e39957b3a95df9e2b6bc8babc1119130c860e309f0f3c6",
      ak: "c424a4acc83b813379e6cf2cc4839aa14d7d003f2d0b26b629dac2e316303f5f",
      hi: "bdaf4ac90b2a8dffd4d5e5cc29f1e8eea5ea434e764d5d2825eec998ce9d6743",
      car: "1d837f6ba9d12262f246c242f8e1a4a794eea6ba22127c22e60b8823ebaff49f",
    });
  });

  it("holds us/ak/hi/car to the fit they were baked at before #111", () => {
    // `fitPanels` partitions points per panel, so adding `ne_50m_pac.json`'s features CANNOT
    // move `us`, `ak`, `hi` or `car` -- and `regionOf`'s three-way split of the old `pac`
    // branch has a union identical to that branch, so it cannot either. Both are arguments;
    // this is the check.
    //
    // Frozen literals rather than another hash: a diff here names WHICH panel moved and by how
    // much, which is the whole question when one does. Necessary and NOT sufficient on its own
    // -- see the byte-level check above for the interior-vertex hole this one cannot see.
    const fits = fitPanels(BASEMAP_FIT_POINTS);
    expect({
      us: fits.get("us"),
      ak: fits.get("ak"),
      hi: fits.get("hi"),
      car: fits.get("car"),
    }).toEqual({
      us: { k: 904.5131300948573, ox: 487.1120339377376, oy: 239.57188375255203 },
      ak: { k: 377.8396853372171, ox: 87.7779935792461, oy: 481.4201810606285 },
      hi: { k: 1221.0803508579845, ox: 247.8265564145108, oy: 442.31592580205955 },
      car: { k: 5304.317346044431, ox: 603.4689616699768, oy: 440.65076212255065 },
    });
  });
});

describe("no inset frame is drawn over the conterminous landmass", () => {
  // THE GATE WHOSE ABSENCE SHIPPED #111'S ONE BLOCKING DEFECT. `pac` was first sized correctly
  // (44x216, every airport inside it, Tinian and Saipan 6.23px apart) and placed at
  // (308,252)-(352,468), whose frame lands inside the conterminous panel. `globals.css`'s
  // `.map svg path[data-panel]` fills every basemap path with OPAQUE `--panel-2`, and
  // `renderNetworkMap` draws frames BEFORE the basemap -- so the lower 48 painted over the
  // frame border, the "MARIANAS" label, and two of the panel's own islands. Measured on a 0.1px
  // grid: 3,163 px^2 of drawn landmass inside that rect (33.3% of it), and all eight glyph
  // positions of the label inside drawn Arizona or New Mexico. 25 served views affected.
  //
  // Nothing caught it because both the acceptance criterion and the frame-overlap test that
  // implements it enumerate the six INSET panels. `us` is the unframed, full-canvas panel that
  // paints the land, so it was in neither list. This test is the one that looks at it.
  //
  // Against the DRAWN SUBPATHS, not the coastline's bounding box: `hi`'s frame sits inside that
  // bbox (x[153.3, 806.7] y[18.0, 424.0]) while containing no land at all, so a bbox test would
  // fail a panel that is genuinely clear. And an exact rect-vs-polygon test, not a
  // vertex-in-rect one: a frame could sit wholly inside one state's interior with no vertex
  // near it and still be entirely behind paint.
  const FRAME_PAD = 6;

  function subpathsOf(d: string): string[] {
    return d
      .split(/(?<=Z)\s*/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  function pointsOf(subpath: string): [number, number][] {
    return [...subpath.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
  }
  function pointInPolygon([px, py]: [number, number], poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function segmentsCross(
    a: [number, number],
    b: [number, number],
    c: [number, number],
    d: [number, number],
  ): boolean {
    const side = (p: [number, number], q: [number, number], r: [number, number]) =>
      Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
  }
  /** Exact: a vertex inside the rect, a rect corner inside the polygon, or any edge crossing. */
  function rectOverlapsPolygon(
    rect: [number, number, number, number],
    poly: [number, number][],
  ): boolean {
    const [x0, y0, x1, y1] = rect;
    const corners: [number, number][] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    if (poly.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) return true;
    if (corners.some((c) => pointInPolygon(c, poly))) return true;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      for (let j = 0; j < 4; j++) {
        if (segmentsCross(a, b, corners[j], corners[(j + 1) % 4])) return true;
      }
    }
    return false;
  }

  const LAND = [...basemapPathsFor(["us"]).matchAll(/data-name="([A-Z]{2})" d="([^"]*)"/g)].flatMap(
    (m) => subpathsOf(m[2]).map((sp) => ({ name: m[1], poly: pointsOf(sp) })),
  );

  it("reads real conterminous subpaths, so the check is not vacuous", () => {
    // Without this, a regression that emptied `us` would make every assertion below pass.
    expect(LAND.length).toBeGreaterThan(40);
  });

  it.each(["ak", "hi", "pac", "nwhi", "sam"] as const)(
    "%s's frame is clear of drawn lower-48 land",
    (panel) => {
      const [x0, y0, x1, y1] = PANEL_RECTS[panel];
      const frame: [number, number, number, number] = [
        x0 - FRAME_PAD,
        y0 - FRAME_PAD,
        x1 + FRAME_PAD,
        y1 + FRAME_PAD,
      ];
      const over = [...new Set(LAND.filter((l) => rectOverlapsPolygon(frame, l.poly)).map((l) => l.name))];
      expect(`${panel} over [${over}]`).toBe(`${panel} over []`);
    },
  );

  it("records `car` as the one pre-existing violation, rather than omitting it", () => {
    // `car` (M7 Task 7b) is the same class of defect and shipped a milestone earlier: its rect
    // (424,392)-(720,468) overlaps drawn Florida and Texas, measured at 1,396 px^2 -- 6.2% of
    // its rect, against `pac`'s 33.3%. Out of scope for #111 and deliberately not fixed, but a
    // test that simply left `car` out of the list above would read as though the property held
    // everywhere. This asserts the exemption is EXACTLY those two states: if `car` ever grows
    // past them, or is fixed, this goes red and someone re-reads the rule.
    const [x0, y0, x1, y1] = PANEL_RECTS.car;
    const frame: [number, number, number, number] = [
      x0 - FRAME_PAD,
      y0 - FRAME_PAD,
      x1 + FRAME_PAD,
      y1 + FRAME_PAD,
    ];
    const over = [
      ...new Set(LAND.filter((l) => rectOverlapsPolygon(frame, l.poly)).map((l) => l.name)),
    ].sort();
    expect(over).toEqual(["FL", "TX"]);
  });
});
