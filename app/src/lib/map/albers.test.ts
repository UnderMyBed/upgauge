import { describe, expect, it } from "vitest";
import { albersRaw, fitPanels, normalizeLon, PANEL_PARAMS, PANEL_RECTS, regionOf } from "./albers";

describe("normalizeLon", () => {
  it("moves positive longitudes west of the antimeridian", () => {
    // Catches: dropping normalization. SYA (Shemya) is Alaskan at +174.11; without
    // this it fails the `lon < -129` Alaska test and lands in the conterminous
    // panel 270 degrees from its central meridian, smearing the lower 48.
    expect(normalizeLon(174.11)).toBeCloseTo(-185.89, 2);
    expect(normalizeLon(144.8)).toBeCloseTo(-215.2, 2);
    expect(normalizeLon(-96)).toBe(-96);
  });
});

describe("regionOf", () => {
  it("puts Shemya in Alaska, not the conterminous panel", () => {
    expect(regionOf(52.71, normalizeLon(174.11))).toBe("ak");
  });
  it("puts Guam and Saipan in the Marianas panel", () => {
    expect(regionOf(13.48, normalizeLon(144.8))).toBe("pac");
    expect(regionOf(15.12, normalizeLon(145.73))).toBe("pac");
  });
  it("puts American Samoa in its own panel -- not Hawaii, and not the Marianas", () => {
    // Catches TWO bugs, and needs both assertions because each survives the other's fix.
    //
    // `not hi` is the original: the mockup's `lon < -150 AND lat < 30` Hawaii test catches
    // PPG at -14.3 latitude and stretches the Hawaii inset to 42 degrees when Hawaii itself
    // spans 2.3.
    //
    // `not pac` is #111's: `pac`'s fit is baked to Guam + the Northern Marianas, whose extent
    // is ~5,000 km away, so a PPG that falls into `pac` projects to (1892.5, 1102.0) -- off a
    // 960x500 canvas. Counterfactual under THIS commit's `pac` fit: `ox`/`oy` move with the
    // rect, so re-derive rather than copying a figure from an earlier revision of it.
    expect(regionOf(-14.3, -170.7)).toBe("sam");
  });
  it("puts Midway in its own panel, not Hawaii and not the Marianas", () => {
    // Same shape as American Samoa above, at the other end. Midway (MDY, 28.2 / -177.4) is
    // 28.2 degrees north, so the mockup's Hawaii test catches it too; and folding it into
    // `pac` -- which is what happened before #111 gave `pac` real geometry -- projects it to
    // (1367.6, -429.7) under this commit's `pac` fit, taking `/airport/MDY?y=2021`'s own
    // subject off the canvas.
    expect(regionOf(28.2, -177.4)).toBe("nwhi");
  });
  it("keeps the Hawaiian islands together", () => {
    expect(regionOf(21.32, -157.92)).toBe("hi"); // HNL
    expect(regionOf(19.72, -155.05)).toBe("hi"); // ITO
  });
  it("puts Puerto Rico and the USVI in the Caribbean panel", () => {
    // Catches: letting them into `us`, which extends the conterminous box east
    // past PQI (Maine, -68.05) and 6.86 degrees south of EYW (Key West, 24.56).
    expect(regionOf(18.44, -66.0)).toBe("car"); // SJU
    expect(regionOf(17.7, -64.8)).toBe("car"); // STX
  });
  it("keeps the extremes of the lower 48 in the conterminous panel", () => {
    expect(regionOf(46.69, -68.05)).toBe("us"); // PQI, easternmost
    expect(regionOf(24.56, -81.76)).toBe("us"); // EYW, southernmost
  });
});

describe("albersRaw", () => {
  it("keeps north up and east right under SOUTHERN standard parallels", () => {
    // `PANEL_PARAMS.sam` is the only panel whose standard parallels are negative, which makes
    // `n = (sin(p1) + sin(p2)) / 2` negative and flips the sign of both `rho` and the `y`
    // negation's operand. The behaviour is correct, but the two tests below only ever exercise
    // `PANEL_PARAMS.us` -- so before this, `albers.ts`'s own comment cited this file for a
    // check that did not exist. Tutuila spans lat -14.36 to -14.26 and lon -170.82 to -170.57;
    // a mirrored panel would draw American Samoa upside down or back to front and every
    // presence-based assertion in the suite would stay green.
    const north = albersRaw(-14.2574, -170.6892, PANEL_PARAMS.sam);
    const south = albersRaw(-14.3598, -170.6892, PANEL_PARAMS.sam);
    expect(north[1]).toBeLessThan(south[1]);
    const west = albersRaw(-14.3, -170.8205, PANEL_PARAMS.sam);
    const east = albersRaw(-14.3, -170.5681, PANEL_PARAMS.sam);
    expect(west[0]).toBeLessThan(east[0]);
  });

  it("puts a northern point above a southern one on screen", () => {
    // Catches: removing the y negation. Raw Albers grows northward while screen y
    // grows down, so an un-negated y renders the country upside down. Asserting
    // that both points are merely PRESENT passes under the bug -- only their
    // relative order catches it.
    const north = albersRaw(47.45, -122.31, PANEL_PARAMS.us); // SEA
    const south = albersRaw(25.79, -80.29, PANEL_PARAMS.us); // MIA
    expect(north[1]).toBeLessThan(south[1]);
  });
  it("puts a western point left of an eastern one", () => {
    const west = albersRaw(47.45, -122.31, PANEL_PARAMS.us);
    const east = albersRaw(40.64, -73.78, PANEL_PARAMS.us);
    expect(west[0]).toBeLessThan(east[0]);
  });
});

describe("PANEL_PARAMS", () => {
  it("centres `sam` on Tutuila's own meridian, so the island is not drawn sheared", () => {
    // `albersRaw`'s `th = n * (lon - lam0)` rotates a feature by the meridian convergence at
    // its longitude, and that is the ONLY thing `PANEL_PARAMS.sam` exists to prevent -- the
    // island is 30km across, so conic distortion over it is irrelevant. Under `pac`'s lam0 of
    // -214.7 the convergence at Tutuila is n * 44 = 10.65 degrees at its worst; under `sam`'s
    // own it is 0.03.
    //
    // This is the assertion, rather than a projected-position one, because swapping
    // `PANEL_PARAMS.sam` for `PANEL_PARAMS.pac` leaves the orientation test below GREEN: north
    // still maps up and east still right under `pac`'s positive `n`. Only the convergence
    // distinguishes them, so only the convergence can gate the swap.
    const worstConvergence = (p: typeof PANEL_PARAMS.sam, lon: number) => {
      const n = (Math.sin((p.p1 * Math.PI) / 180) + Math.sin((p.p2 * Math.PI) / 180)) / 2;
      return Math.abs(n * (lon - p.lam0));
    };
    // Tutuila's committed longitude span (app/geo/ne_50m_pac.json), both ends.
    for (const lon of [-170.8205, -170.5681]) {
      expect(worstConvergence(PANEL_PARAMS.sam, lon)).toBeLessThan(1);
    }
    // And the mutant this exists to kill, stated so the margin is visible rather than implied.
    expect(worstConvergence(PANEL_PARAMS.pac, -170.8205)).toBeGreaterThan(10);
  });
});

describe("fitPanels", () => {
  it("omits a panel with no points", () => {
    // Catches: drawing an empty inset frame. Most airports never touch the
    // Pacific or Caribbean panels and must not render a labelled empty box.
    const fits = fitPanels([{ lat: 47.45, lon: -122.31 }]);
    expect(fits.has("us")).toBe(true);
    expect(fits.has("pac")).toBe(false);
    expect(fits.has("nwhi")).toBe(false);
    expect(fits.has("car")).toBe(false);
    expect(fits.has("sam")).toBe(false);
  });
});

describe("PANEL_RECTS", () => {
  // #111 reshaped `pac` and added two panels, so the tray had to be re-laid-out rather than
  // extended. These are the layout invariants that reshaping can break silently: a frame
  // border overlapping its neighbour's, or running off the canvas, is not something any
  // projection test can see -- `fitPanels` happily fits a panel into a rect that overlaps
  // another one.
  //
  // Frames are drawn at rect +/- 6px (`networkMap.ts`'s inset loop), so the check is on the
  // FRAMES, not the rects: two rects 4px apart do not overlap while their frames do.
  const FRAME_PAD = 6;
  const INSETS = (["ak", "hi", "pac", "nwhi", "car", "sam"] as const).map((panel) => {
    const [x0, y0, x1, y1] = PANEL_RECTS[panel];
    return { panel, frame: [x0 - FRAME_PAD, y0 - FRAME_PAD, x1 + FRAME_PAD, y1 + FRAME_PAD] };
  });

  it("draws no two inset frames over each other", () => {
    for (let i = 0; i < INSETS.length; i++) {
      for (let j = i + 1; j < INSETS.length; j++) {
        const [ax0, ay0, ax1, ay1] = INSETS[i].frame;
        const [bx0, by0, bx1, by1] = INSETS[j].frame;
        const overlaps = !(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0);
        expect(`${INSETS[i].panel} x ${INSETS[j].panel}: ${overlaps}`).toBe(
          `${INSETS[i].panel} x ${INSETS[j].panel}: false`,
        );
      }
    }
  });

  it("keeps every inset frame inside the 960x500 canvas", () => {
    // WIDTH/HEIGHT are networkMap.ts's, restated here rather than imported because importing
    // the renderer into a projection test would couple Task 4's file to Task 6's.
    for (const { panel, frame } of INSETS) {
      const [x0, y0, x1, y1] = frame;
      expect(`${panel}: ${x0 >= 0 && y0 >= 0 && x1 <= 960 && y1 <= 500}`).toBe(`${panel}: true`);
    }
  });

  it("keeps the bottom inset tray on one baseline", () => {
    // The tray's shared bottom edge, and it is a claim about the TRAY -- five panels, not six.
    // `pac` is deliberately not one of them: at 216px tall it cannot sit in a 76px tray, and
    // the only place a rect that tall clears the opaque lower-48 landmass is the top-left
    // margin (see PANEL_RECTS' own comment, and basemap.test.ts's frame-vs-land test). An
    // earlier revision of this test listed `pac` here and passed only because the rect happened
    // to end at 468 while starting 140px above the tray -- a ragged row the assertion could not
    // see. Naming the tray explicitly is what keeps it honest.
    for (const panel of ["ak", "hi", "nwhi", "car", "sam"] as const) {
      expect(`${panel}: ${PANEL_RECTS[panel][3]}`).toBe(`${panel}: 468`);
    }
    expect(PANEL_RECTS.pac[3]).toBeLessThan(392);
  });
});
