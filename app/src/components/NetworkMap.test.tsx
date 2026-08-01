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
  });
});
