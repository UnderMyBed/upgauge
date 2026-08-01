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

  it("requesting a panel with no committed geography emits nothing, not an error", () => {
    // Natural Earth 1:110m has no separate Admin-1 entry for Guam/Samoa/Midway or Puerto
    // Rico/the USVI (see build-basemap.mjs's header) -- `pac`/`car` have zero reference
    // points, so `fitPanels` never produces a fit for them and the generator emits no
    // path. A page reaching into the Pacific or Caribbean still renders (via `project`'s
    // own `us`-fit fallback); it just draws no coastline under those arcs.
    expect(() => basemapPathsFor(["pac"])).not.toThrow();
    expect(basemapPathsFor(["pac"])).toBe("");
  });
});

describe("BASEMAP_FIT_POINTS", () => {
  it("is the fixed reference set the generator fit the coastline to -- not the empty set", () => {
    expect(BASEMAP_FIT_POINTS.length).toBeGreaterThan(1000);
  });

  it("establishes a fit that does not move when a subject's own points are unioned in", () => {
    // This is the property the brief calls out: "the basemap is fitted to fixed panel
    // rectangles, not to the subject's arcs -- otherwise the coastline would move from
    // page to page." A future per-page network map must call
    // `fitPanels([...BASEMAP_FIT_POINTS, ...subjectPoints])`, never
    // `fitPanels(subjectPoints)` alone, or its arcs will be scaled/offset differently
    // from the coastline this module drew. SEA (47.45, -122.31) sits well inside the
    // conterminous landmass, so unioning it in must not change the `us` panel's fit.
    const fitsAlone = fitPanels(BASEMAP_FIT_POINTS);
    const fitsWithSubject = fitPanels([...BASEMAP_FIT_POINTS, { lat: 47.45, lon: -122.31 }]);
    expect(fitsWithSubject.get("us")).toEqual(fitsAlone.get("us"));
  });
});
