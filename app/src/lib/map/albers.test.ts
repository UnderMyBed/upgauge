import { describe, expect, it } from "vitest";
import { albersRaw, fitPanels, normalizeLon, PANEL_PARAMS, regionOf } from "./albers";

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
  it("puts Guam and Saipan in the Pacific panel", () => {
    expect(regionOf(13.48, normalizeLon(144.8))).toBe("pac");
    expect(regionOf(15.12, normalizeLon(145.73))).toBe("pac");
  });
  it("puts American Samoa in the Pacific panel, not Hawaii", () => {
    // Catches: the mockup's `lon < -150 AND lat < 30` Hawaii test, which catches
    // PPG at -14.3 latitude and stretches the Hawaii inset to 42 degrees when
    // Hawaii itself spans 2.3.
    expect(regionOf(-14.3, -170.7)).toBe("pac");
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

describe("fitPanels", () => {
  it("omits a panel with no points", () => {
    // Catches: drawing an empty inset frame. Most airports never touch the
    // Pacific or Caribbean panels and must not render a labelled empty box.
    const fits = fitPanels([{ lat: 47.45, lon: -122.31 }]);
    expect(fits.has("us")).toBe(true);
    expect(fits.has("pac")).toBe(false);
    expect(fits.has("car")).toBe(false);
  });
});
