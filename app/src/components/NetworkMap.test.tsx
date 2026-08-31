// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NetworkMap } from "@/components/NetworkMap";
import { networkDisclosureNotes, type NetworkMapInput } from "@/lib/map/networkMap";
import type { ArcDatum } from "@/lib/map/arcs";

const COORDS = {
  ORD: { lat: 41.98, lon: -87.9 },
  SEA: { lat: 47.45, lon: -122.31 },
  JFK: { lat: 40.64, lon: -73.78 },
  PDX: { lat: 45.59, lon: -122.6 },
  HNL: { lat: 21.32, lon: -157.92 },
  GUM: { lat: 13.48, lon: 144.8 }, // east of the antimeridian -- regionOf normalizes first
  PPG: { lat: -14.33, lon: -170.71 }, // American Samoa -- southern hemisphere, `sam` panel
  MDY: { lat: 28.2, lon: -177.38 }, // Midway -- `nwhi`, the one panel with no coastline
  SJU: { lat: 18.44, lon: -66.0 },
} as const;

function arc(code: keyof typeof COORDS, overrides: Partial<ArcDatum> = {}): ArcDatum {
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

function conterminousNetwork(): NetworkMapInput {
  return {
    origin: { code: "ORD", ...COORDS.ORD, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: [arc("SEA"), arc("JFK")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

function hawaiiReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "PDX", ...COORDS.PDX, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: [arc("HNL")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

function marianasReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "HNL", ...COORDS.HNL, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: [arc("GUM")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** HNL-PPG is a real, every-month route (86,736 seats over the trailing 12), and PPG is the
 *  airport the pre-#111 "6 airports reach the Pacific" figure omitted. */
function samoaReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "HNL", ...COORDS.HNL, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: [arc("PPG")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

/** MDY-HNL, HA, 2021-09, 278 seats -- Midway's ONLY filing in the whole window, and the reason
 *  `/airport/MDY?y=2021` and `/airport/HNL?y=2021` are real pages rather than a hypothetical. */
function midwayReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "HNL", ...COORDS.HNL, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: [arc("MDY")],
    window: "2021-01 → 2021-12",
    sameAirportSeats: 0,
  };
}

function caribbeanReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "JFK", ...COORDS.JFK, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
    arcs: [arc("SJU")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

describe("NetworkMap", () => {
  it("renders the map's svg, in the served markup, with an accessible role", () => {
    const { container } = render(<NetworkMap network={conterminousNetwork()} />);
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();
  });

  it("draws one polyline per destination", () => {
    const { container } = render(<NetworkMap network={conterminousNetwork()} />);
    expect(container.querySelectorAll("polyline").length).toBe(2);
  });

  it("requests the basemap only for the panels this network actually reaches", () => {
    // Catches: shipping every panel's coastline (or none at all) regardless of what the
    // network touches -- reachedPanels must be derived from THIS network's own points, not
    // a hardcoded set. Real BASEMAP_PATHS, no mocks (this codebase has none).
    const conterminous = render(<NetworkMap network={conterminousNetwork()} />).container.innerHTML;
    expect(conterminous).toContain('data-panel="us"');
    expect(conterminous).not.toContain('data-panel="ak"');
    expect(conterminous).not.toContain('data-panel="hi"');
    expect(conterminous).not.toContain('data-panel="pac"');
    expect(conterminous).not.toContain('data-panel="sam"');
    expect(conterminous).not.toContain('data-panel="car"');

    const reachingHawaii = render(
      <NetworkMap network={hawaiiReachingNetwork()} />,
    ).container.innerHTML;
    expect(reachingHawaii).toContain('data-panel="hi"');
    expect(reachingHawaii).toContain('data-panel="us"');
  });

  it("draws real Caribbean coastline for a network reaching `car` (M7 Task 7b)", () => {
    // Catches: a page that reaches `car` but the basemap markup wired up here is still the
    // pre-Task-7b empty string -- reachedPanels/basemapPathsFor must actually carry the new
    // ne_50m_car.json geometry through to a served page, not just to the generator's own
    // unit tests.
    const html = render(<NetworkMap network={caribbeanReachingNetwork()} />).container.innerHTML;
    expect(html).toContain('data-panel="car"');
    expect(html).toContain('data-name="PR"');
  });

  it("does not caption the Midway gap when the network never reaches it", () => {
    const html = render(<NetworkMap network={conterminousNetwork()} />).container.innerHTML;
    expect(html).not.toContain("inset has no coastline");
  });

  it("draws real Marianas coastline for a network reaching `pac` (#111)", () => {
    // The inverse of the test this replaces, which asserted BOTH that no `pac` coastline
    // existed AND that the page said so. Both halves were true for a milestone on the
    // strength of an unchecked claim that Natural Earth had no polygon for these territories;
    // it had them all along, in the file `car`'s came from. Catches a page that reaches `pac`
    // while the basemap markup wired up here is still the pre-#111 empty string.
    const html = render(<NetworkMap network={marianasReachingNetwork()} />).container.innerHTML;
    expect(html).toContain("MARIANAS"); // the inset frame is drawn and labelled for what it is
    expect(html).toContain('data-panel="pac"');
    expect(html).toContain('data-name="GU"');
    // The caption retired itself the moment the geometry landed -- it is derived from
    // basemapPathsFor, never hardcoded, and this is the assertion that says so.
    expect(html).not.toContain("inset has no coastline");
  });

  it("draws real American Samoa coastline for a network reaching `sam` (#111)", () => {
    // Catches American Samoa being folded back into `pac`: under a Marianas-scaled fit PPG
    // projects to (1892.5, 1102.0) under this commit's `pac` fit, off the canvas, so
    // `sam` is a panel and not a rect tweak. A page reaching it must get its own labelled frame with real land under the dot.
    const html = render(<NetworkMap network={samoaReachingNetwork()} />).container.innerHTML;
    expect(html).toContain("AMERICAN SAMOA");
    expect(html).toContain('data-panel="sam"');
    expect(html).toContain('data-name="AS"');
    expect(html).not.toContain("inset has no coastline");
  });

  it("captions the empty Midway inset when the network reaches it, so it doesn't read as a bug", () => {
    // The gap that survived #111, and the reason the caption was rewritten rather than
    // deleted: Natural Earth carries Midway only inside a feature that also spans the
    // Caribbean. Without this caption a network reaching `nwhi` draws a labelled "MIDWAY"
    // frame (renderNetworkMap's own inset loop) with a real arc and a real destination dot
    // inside it but no landmass -- indistinguishable, to a reader, from a rendering defect.
    const html = render(<NetworkMap network={midwayReachingNetwork()} />).container.innerHTML;
    expect(html).toContain("MIDWAY"); // the inset frame IS drawn (renderNetworkMap's own loop)
    expect(html).not.toContain('data-panel="nwhi"'); // but genuinely no coastline path under it
    expect(html).toContain("Midway inset has no coastline");
  });

  it("keeps Midway's own node on the canvas", () => {
    // The regression #111 would otherwise have shipped. Baking a `pac` fit takes `pac` off
    // networkMap.ts's `?? subjectFits` fallback; folding Midway into `pac` as well would
    // project it to (1367.6, -429.7) -- off the canvas -- and `/airport/MDY?y=2021`
    // would lose its own subject while the caption cheerfully said only the landmass was
    // missing. `nwhi` exists so Midway keeps the subject-derived fit, which centres it in its
    // own frame. A POSITION assertion, because a "the arc is present" one passes under the bug
    // (the polyline is still emitted; it just runs off the viewBox).
    const html = render(<NetworkMap network={midwayReachingNetwork()} />).container.innerHTML;
    const nodes = [...html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="2"/g)];
    expect(nodes).toHaveLength(1);
    const [x, y] = [Number(nodes[0][1]), Number(nodes[0][2])];
    expect(`(${x}, ${y}) on canvas: ${x >= 0 && x <= 960 && y >= 0 && y <= 500}`).toBe(
      `(${x}, ${y}) on canvas: true`,
    );
  });

  // ---- #114: the disclosure a sighted reader can actually see ------------------------------

  /** Bettles' shape over the trailing 12: real destinations plus one route pair whose every
   *  filing was quarantined (BTT-UMT), which is counted and not drawn. */
  function quarantinedNetwork(): NetworkMapInput {
    return { ...conterminousNetwork(), quarantinedRoutes: 1 };
  }

  it("renders the disclosure as visible HTML, not only inside the aria-label", () => {
    // THE INVERSION THIS BLOCK EXISTS TO PREVENT, and it has shipped in this repo before: the
    // sentence reaches the `aria-label` from `describeMap` whether or not this component does
    // anything, so a component that omits the notes block is MORE honest to a screen reader
    // than to the person looking at the map. Twelve real views shipped that way on the
    // point-to-point map (SegmentMap.tsx's header carries the measurement).
    //
    // Asserted on the notes container specifically, with the aria-label stripped from the
    // haystack -- a `container.textContent` check would be satisfied by the accessible
    // description alone and could never fail for the reason this test exists.
    const { container } = render(<NetworkMap network={quarantinedNetwork()} />);
    const notes = container.querySelector('[data-testid="network-notes"]');
    expect(notes).not.toBeNull();
    expect(notes!.textContent).toContain(
      "1 quarantined route not drawn — failed an invariant, never clamped.",
    );
  });

  it("renders the notes verbatim from their one owner, never a sentence composed here", () => {
    // THE BINDING ASSERTION, the shape SegmentMap.test.tsx already uses. The copy has ONE owner
    // (`quarantinedNote`, shared with the point-to-point map since #114); a component that
    // rebuilt the sentence from `quarantinedRoutes` would drift from the map it is supposed to
    // agree with, and "N routes withheld" reads as a cap rather than as a data-quality refusal.
    // Measured precedent: a hand-rolled sentence on 8V x 035 read "14 smaller routes are not
    // drawn" about 14 routes that were quarantined, not smaller.
    const network = quarantinedNetwork();
    const { container } = render(<NetworkMap network={network} />);
    const rendered = [...container.querySelectorAll('[data-testid="network-notes"] p')].map(
      (n) => n.textContent,
    );
    expect(rendered).toEqual(networkDisclosureNotes(network));
    expect(rendered).toHaveLength(1);
  });

  it("puts the same sentence in the accessible name and in the visible text", () => {
    // The two renderings come from two separate calls -- `renderNetworkMap` builds the label,
    // this component builds the block -- so nothing structural stops them disagreeing. Binding
    // them here is what keeps the map from telling two readers two different things.
    const network = quarantinedNetwork();
    const { container } = render(<NetworkMap network={network} />);
    const label = container.querySelector("svg")!.getAttribute("aria-label")!;
    expect(label).toContain(networkDisclosureNotes(network).join(" "));
  });

  it("renders no notes container at all when there is nothing to disclose", () => {
    // `.foot` carries a border-top, so an unconditional container draws a hairline rule under
    // every one of the ~1,000 airport maps that have nothing to say.
    const { container } = render(<NetworkMap network={conterminousNetwork()} />);
    expect(container.querySelector('[data-testid="network-notes"]')).toBeNull();
  });

  it("discloses even when the network has no drawable arc at all", () => {
    // /airport/A18: nothing to draw, something to say. Gating the notes on the arcs -- the
    // obvious "no arcs, nothing to show" shortcut -- deletes the only thing on the page saying
    // anything was filed, on precisely the pages where it is the only thing there is.
    const empty: NetworkMapInput = {
      origin: { code: "ORD", ...COORDS.ORD, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
      arcs: [],
      window: "2025-06 → 2026-05",
      sameAirportSeats: 0,
      quarantinedRoutes: 1,
    };
    const { container } = render(<NetworkMap network={empty} />);
    expect(container.querySelectorAll("polyline").length).toBe(0);
    expect(container.querySelector('[data-testid="network-notes"]')!.textContent).toContain(
      "1 quarantined route not drawn",
    );
  });

  it("renders nothing extra when the origin has no arcs at all", () => {
    // Not the null case (that is fetchAirportNetwork's contract, and this component is never
    // mounted at all when it returns null -- see page.tsx). This is the component staying a
    // pure, total function of whatever NetworkMapInput it is handed.
    const empty: NetworkMapInput = {
      origin: { code: "ORD", ...COORDS.ORD, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
      arcs: [],
      window: "2025-05 → 2026-04",
      sameAirportSeats: 0,
    };
    const { container } = render(<NetworkMap network={empty} />);
    expect(container.querySelectorAll("polyline").length).toBe(0);
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();

    // Catches: deriving the reached panels from the SEGMENTS rather than from the network's
    // own points. #104 made every other map point-to-point, and a hub with no drawable arc
    // adapts to zero segments -- so `reachedPanelsFor(networkSegments(input))` would return no
    // panels at all and drop the coastline out from under the origin disc, which is still
    // drawn. `networkPanels` counts the origin, which is why it exists separately.
    expect(container.innerHTML).toContain('data-panel="us"');
  });
});
