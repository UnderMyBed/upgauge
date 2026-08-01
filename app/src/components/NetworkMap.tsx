import { normalizeLon, regionOf, type Panel } from "@/lib/map/albers";
import { basemapPathsFor } from "@/lib/map/basemap";
import { renderNetworkMap, type NetworkMapInput } from "@/lib/map/networkMap";

/** Every panel this network's own points (origin + every arc, including a same-airport row --
 * its panel is the origin's own, so including it changes nothing) land in, normalized across
 * the antimeridian exactly as `fitPanels`/`project` require. Drives which panels' coastline
 * `basemapPathsFor` is asked for -- a page must not ship the Pacific or Caribbean outline when
 * nothing in its own network reaches either. */
function reachedPanels(input: NetworkMapInput): Panel[] {
  const points = [input.origin, ...input.arcs];
  const panels = new Set<Panel>();
  for (const p of points) {
    panels.add(regionOf(p.lat, normalizeLon(p.lon)));
  }
  return [...panels];
}

/**
 * Mounts the airport network map: `renderNetworkMap`'s `<svg>…</svg>` string, injected exactly
 * as `AircraftMixChart.tsx` injects Plot's -- server-rendered, in the served HTML, visible with
 * JS off. This component's only job beyond that injection is supplying the one thing
 * `renderNetworkMap` cannot derive from `network` alone, deliberately (`NetworkMapInput`'s own
 * doc comment): the projected coastline markup for the panels this particular network reaches.
 * `basemapPathsFor` takes no points and does no fitting of its own (Task 7); the FIT
 * `renderNetworkMap` projects arcs with already reuses the identical fixed fit that markup was
 * baked against (M7 Task 8's fix) -- this component supplies WHICH panels' paths to draw, never
 * how to align them.
 */
export function NetworkMap({ network }: { network: NetworkMapInput }) {
  const svg = renderNetworkMap({
    ...network,
    basemapPaths: basemapPathsFor(reachedPanels(network)),
  });

  return (
    <div className="map">
      {/* The markup is this project's own projection of warehouse coordinates -- no user
          input reaches it, and the one string that could (the origin/destination codes) is
          a BTS code, already validated by the resolver that produced `network.origin`. */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
