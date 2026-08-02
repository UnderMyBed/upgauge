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
  const reached = reachedPanels(network);
  const svg = renderNetworkMap({
    ...network,
    basemapPaths: basemapPathsFor(reached),
  });

  // M7 Task 7b widened `car`'s coastline (ne_50m_car.json) but deliberately left `pac` empty
  // -- 6 fact-present airports (GUM, HNL, ROP, SFO, SPN, TIQ) reach it, against `car`'s 74,
  // which didn't justify the same fetch-and-filter work. `renderNetworkMap` still draws a
  // labelled "PACIFIC" inset frame whenever a network reaches that panel (`fits.has("pac")`,
  // networkMap.ts), same as before this task -- an empty, labelled box with real arcs and
  // destination dots inside it but no landmass under them, which reads as a rendering defect
  // unless something on the page says otherwise. Derived from `basemapPathsFor` itself
  // (never a hardcoded "pac is always empty"), so this caption disappears on its own the day
  // `pac` gains real geometry, without a code change here.
  const pacHasNoBasemap = reached.includes("pac") && basemapPathsFor(["pac"]) === "";

  return (
    <div className="map">
      {/* The markup is this project's own projection of warehouse coordinates -- no user
          input reaches it, and the one string that could (the origin/destination codes) is
          a BTS code, already validated by the resolver that produced `network.origin`. */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {pacHasNoBasemap ? (
        <p className="foot">
          {"The Pacific inset has no coastline under its arcs — Natural Earth's " +
            "public-domain basemap has no polygon at this scale for Guam/CNMI/American " +
            "Samoa/Midway. Arcs and destinations still render correctly; only the " +
            "underlying landmass is missing."}
        </p>
      ) : null}
    </div>
  );
}
