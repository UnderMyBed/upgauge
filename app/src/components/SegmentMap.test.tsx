// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Panel } from "@/lib/map/albers";
import { disclosureNotes, type SegmentDatum, type SegmentMapInput } from "@/lib/map/segmentMap";

/**
 * `nwhi` is the ONE panel `basemapPathsFor` always answers "" for, and that is a property of
 * Natural Earth's source, not of this component. So the caption's second clause --
 * `basemapPathsFor(["nwhi"]) === ""` -- is permanently true, and a mutant that DELETES it
 * (leaving a bare `reached.includes("nwhi")`) stays green against every real fixture forever.
 *
 * That is the "assert the window, not the set" failure this epic has already shipped ten times,
 * so it gets stubbed rather than deferred: with geometry present for `nwhi`, the caption must
 * disappear on its own -- which is the same self-retiring property #111 just proved for `pac`.
 *
 * Default is a PASS-THROUGH to the real module, so every other test in this file runs against
 * the real basemap. `vi.hoisted` is what lets the flag be reachable from the hoisted factory.
 */
const stub = vi.hoisted(() => ({ nwhi: null as string | null }));

vi.mock("@/lib/map/basemap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/map/basemap")>();
  return {
    ...actual,
    basemapPathsFor: (panels: Panel[]): string => {
      const real = actual.basemapPathsFor(panels);
      if (stub.nwhi === null || !panels.includes("nwhi")) return real;
      return real + stub.nwhi;
    },
  };
});

import { SegmentMap } from "@/components/SegmentMap";

afterEach(() => {
  stub.nwhi = null;
});

// Coordinates match NetworkMap.test.tsx's COORDS -- one set of real airports, so the two map
// components' tests cannot disagree about where a panel boundary is.
const N = {
  ORD: { code: "ORD", lat: 41.98, lon: -87.9 },
  LAX: { code: "LAX", lat: 33.94, lon: -118.4 },
  GUM: { code: "GUM", lat: 13.48, lon: 144.8 }, // east of the antimeridian -- `pac`, real coastline since #111
  HNL: { code: "HNL", lat: 21.32, lon: -157.92 },
  // Sand Island Field, Midway -- `nwhi`, the one panel with no coastline. Fact-present with
  // exactly one filing (2021-09, MDY-HNL, HA, 278 seats), so this is a real airport on a
  // reachable page rather than a synthetic coordinate.
  MDY: { code: "MDY", lat: 28.2, lon: -177.38 },
} as const;

function seg(
  from: keyof typeof N,
  to: keyof typeof N,
  over: Partial<SegmentDatum> = {},
): SegmentDatum {
  return { from: N[from], to: N[to], seats: 100_000, departures: 200, loadFactor: 0.85, activeMonths: 1, ...over };
}

/** `count` distinct drawable conterminous pairs, all in the `us` panel. Synthetic codes, because
 *  the property under test is the CAP, and 400 real airport pairs would put the fixture's own
 *  correctness in the way of the assertion. */
function manySegments(count: number): SegmentDatum[] {
  return Array.from({ length: count }, (_, i) => ({
    from: N.ORD,
    to: { code: `X${i}`, lat: 34 + (i % 20) * 0.4, lon: -102 + Math.floor(i / 20) * 0.4 },
    seats: 1_000 + i,
    departures: 50,
    loadFactor: 0.8,
    activeMonths: 1,
  }));
}

function input(over: Partial<SegmentMapInput> = {}): SegmentMapInput {
  return {
    segments: [seg("ORD", "LAX")],
    window: "2025-06 → 2026-05",
    totalRoutes: 1,
    sameAirportSeats: 0,
    quarantinedRoutes: 0,
    ...over,
  };
}

function noteTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="map-notes"] p')].map((p) => p.textContent);
}

function ariaLabelOf(container: HTMLElement): string {
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("no <svg> rendered");
  return svg.getAttribute("aria-label") ?? "";
}

describe("SegmentMap", () => {
  it("puts the SVG in the served markup, not an empty client container", () => {
    const { container } = render(<SegmentMap map={input()} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("supplies the coastline for the panels its own segments reach", () => {
    // `renderSegmentMap` draws no basemap unless the component hands it one -- that is the
    // component's whole job beyond injection (NetworkMap.tsx's docstring).
    const html = render(<SegmentMap map={input()} />).container.innerHTML;
    expect(html).toContain('data-panel="us"');
  });

  it("asks for no coastline the map does not reach", () => {
    // A conterminous map shipping the Caribbean outline is the "fit reuses the baked fit" rule's
    // visible half: panels are per-map, never the whole atlas.
    const html = render(<SegmentMap map={input()} />).container.innerHTML;
    expect(html).not.toContain('data-panel="car"');
  });

  it("renders exactly the engine's disclosure notes, in order, one paragraph each", () => {
    // THE HARD REQUIREMENT. The copy has ONE owner -- `disclosureNotes` -- and this component
    // may not compose, filter, reorder or hand-roll a sentence of it. Asserting the whole array
    // catches all four: a dropped note shortens it, a hand-rolled extra lengthens it, a reorder
    // moves it, a reworded one changes its text.
    const map = input({ segments: manySegments(400), totalRoutes: 1_622, quarantinedRoutes: 16, sameAirportSeats: 598_829 });
    const { container } = render(<SegmentMap map={map} />);
    expect(noteTexts(container)).toEqual(disclosureNotes(map));
    expect(noteTexts(container)).toHaveLength(3);
  });

  it("states the cap sentence the engine actually writes when the cap bit", () => {
    // The REAL sentence. An assertion on "not drawn" would pass here and go on passing when the
    // cap sentence is rendered unconditionally, because "not drawn" belongs to the QUARANTINE
    // sentence (segmentMap.ts:325) and never appears in this one.
    const map = input({ segments: manySegments(400), totalRoutes: 1_622 });
    const { container } = render(<SegmentMap map={map} />);
    expect(container.textContent).toContain("400 of 1,622 routes drawn.");
  });

  it("renders NO cap sentence when nothing was elided", () => {
    // A disclosure that always renders is a disclosure that means nothing. 12 segments in,
    // totalRoutes 12 -> the cap did not bite. The drawn count is DERIVED from `segments`, so a
    // fixture cannot assert a drawn count its own segments contradict.
    const map = input({ segments: manySegments(12), totalRoutes: 12 });
    const { container } = render(<SegmentMap map={map} />);
    expect(noteTexts(container)).toEqual([]);
    expect(container.textContent).not.toContain("routes drawn.");
  });

  it("states the cap sentence exactly once on the page", () => {
    // The other way to get this wrong: render the notes here AND paint them into the SVG. The
    // aria-label is an ATTRIBUTE, which `textContent` excludes, so a count of 1 here means one
    // VISIBLE statement -- not one statement total.
    const map = input({ segments: manySegments(400), totalRoutes: 1_622 });
    const { container } = render(<SegmentMap map={map} />);
    expect(container.textContent?.match(/400 of 1,622 routes drawn\./g) ?? []).toHaveLength(1);
  });

  it.each([
    ["capped only", input({ segments: manySegments(400), totalRoutes: 1_622 })],
    ["quarantine only", input({ quarantinedRoutes: 16 })],
    ["same-airport only", input({ sameAirportSeats: 598_829 })],
    ["all three", input({ segments: manySegments(400), totalRoutes: 1_622, quarantinedRoutes: 16, sameAirportSeats: 598_829 })],
    ["none", input()],
  ])("binds the visible notes to the aria-label (%s)", (_name, map) => {
    // THE BINDING ASSERTION. `disclosureNotes(map)` and `renderSegmentMap(map)` are two separate
    // calls, so nothing structural stops this component rendering a partial or reordered subset
    // while the aria-label carries all three. That inversion -- the map more honest to a screen
    // reader than to the person looking at it -- is the bug A7 exists to prevent, and it has
    // shipped once already. On every fixture, not just the busy one.
    const { container } = render(<SegmentMap map={map} />);
    expect(ariaLabelOf(container)).toContain(disclosureNotes(map).join(" "));
    expect(noteTexts(container)).toEqual(disclosureNotes(map));
  });

  it("captions the empty Midway inset when a segment reaches it", () => {
    const { container } = render(<SegmentMap map={input({ segments: [seg("HNL", "MDY")] })} />);
    expect(container.innerHTML).toContain("MIDWAY"); // the inset frame IS drawn and labelled
    expect(container.innerHTML).not.toContain('data-panel="nwhi"'); // but there is no land under it
    expect(container.textContent).toContain("Midway inset has no coastline");
  });

  it("does not caption a map that never reaches Midway", () => {
    const { container } = render(<SegmentMap map={input()} />);
    expect(container.textContent).not.toContain("inset has no coastline");
  });

  it("does not caption a Guam-reaching map, which has had real geometry since #111", () => {
    // The assertion that MOVED when #111 landed. A caption keyed on `pac` -- which this repo's
    // own guidance recommended before #111 -- would fire here and claim a coastline is missing
    // from a panel that is drawing one.
    const { container } = render(<SegmentMap map={input({ segments: [seg("ORD", "GUM")] })} />);
    expect(container.innerHTML).toContain('data-panel="pac"'); // real Marianas coastline
    expect(container.textContent).not.toContain("inset has no coastline");
  });

  it("retires the Midway caption on its own the day that panel gains geometry", () => {
    // Derived, never hardcoded. With `nwhi` geometry stubbed in, the caption must disappear with
    // no code change here -- exactly what happened to the `pac` caption when #111 landed. This is
    // the only test that can see the emptiness clause; against the real basemap it is
    // permanently true, so a mutant deleting it survives every other fixture in this file.
    stub.nwhi = '<path data-panel="nwhi" d="M0 0 L1 1" />';
    const { container } = render(<SegmentMap map={input({ segments: [seg("HNL", "MDY")] })} />);
    expect(container.innerHTML).toContain('data-panel="nwhi"');
    expect(container.textContent).not.toContain("inset has no coastline");
  });
});
