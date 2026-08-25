// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NetworkMap } from "@/components/NetworkMap";
import type { NetworkMapInput } from "@/lib/map/networkMap";
import type { ArcDatum } from "@/lib/map/arcs";

const COORDS = {
  ORD: { lat: 41.98, lon: -87.9 },
  SEA: { lat: 47.45, lon: -122.31 },
  JFK: { lat: 40.64, lon: -73.78 },
  PDX: { lat: 45.59, lon: -122.6 },
  HNL: { lat: 21.32, lon: -157.92 },
  GUM: { lat: 13.48, lon: 144.8 }, // east of the antimeridian -- regionOf normalizes first
  SJU: { lat: 18.44, lon: -66.0 },
} as const;

function arc(code: keyof typeof COORDS, overrides: Partial<ArcDatum> = {}): ArcDatum {
  return {
    code,
    ...COORDS[code],
    seats: 100_000,
    departures: 200,
    loadFactor: 0.85,
    ...overrides,
  };
}

function conterminousNetwork(): NetworkMapInput {
  return {
    origin: { code: "ORD", ...COORDS.ORD, seats: 0, departures: 0, loadFactor: null },
    arcs: [arc("SEA"), arc("JFK")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

function hawaiiReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "PDX", ...COORDS.PDX, seats: 0, departures: 0, loadFactor: null },
    arcs: [arc("HNL")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

function pacificReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "HNL", ...COORDS.HNL, seats: 0, departures: 0, loadFactor: null },
    arcs: [arc("GUM")],
    window: "2025-05 → 2026-04",
    sameAirportSeats: 0,
  };
}

function caribbeanReachingNetwork(): NetworkMapInput {
  return {
    origin: { code: "JFK", ...COORDS.JFK, seats: 0, departures: 0, loadFactor: null },
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

  it("does not caption `pac` when the network never reaches it", () => {
    const html = render(<NetworkMap network={conterminousNetwork()} />).container.innerHTML;
    expect(html).not.toContain("Pacific inset has no coastline");
  });

  it("captions the empty `pac` inset when the network reaches it, so it doesn't read as a bug", () => {
    // The Pacific panel still has zero committed geometry (out of scope for Task 7b -- 6
    // fact-present airports vs. `car`'s 74). Without this caption, a network that reaches
    // `pac` still draws a labelled "PACIFIC" frame (renderNetworkMap's own inset loop) with
    // real arcs and destination dots inside it but no landmass -- indistinguishable, to a
    // reader, from a rendering defect.
    const html = render(<NetworkMap network={pacificReachingNetwork()} />).container.innerHTML;
    expect(html).toContain("PACIFIC"); // the inset frame IS drawn (renderNetworkMap's own loop)
    expect(html).not.toContain('data-panel="pac"'); // but genuinely no coastline path under it
    expect(html).toContain("Pacific inset has no coastline");
  });

  it("renders nothing extra when the origin has no arcs at all", () => {
    // Not the null case (that is fetchAirportNetwork's contract, and this component is never
    // mounted at all when it returns null -- see page.tsx). This is the component staying a
    // pure, total function of whatever NetworkMapInput it is handed.
    const empty: NetworkMapInput = {
      origin: { code: "ORD", ...COORDS.ORD, seats: 0, departures: 0, loadFactor: null },
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
