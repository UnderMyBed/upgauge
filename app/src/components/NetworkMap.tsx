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

  // `pac` (Guam + the Northern Marianas) and `sam` (American Samoa) have real coastline as of
  // #111 -- 7 fact-present airports reach the Pacific panels over the trailing 12 (GUM, HNL,
  // PPG, ROP, SFO, SPN, TIQ), against `car`'s 79. Midway is the one gap left, and it is a
  // property of the SOURCE, not of scope: Natural Earth carries Midway only inside a feature
  // that also spans the Caribbean, which `build-basemap.mjs` cannot split apart (its header
  // and app/geo/ne_50m_pac.json's `_source` both record why). So Midway gets its own panel,
  // `nwhi`, which `renderNetworkMap` still frames and labels whenever a network reaches it
  // (`fits.has("nwhi")`, networkMap.ts) -- an empty, labelled box with a real arc and a real
  // destination dot inside it but no landmass under them, which reads as a rendering defect
  // unless something on the page says otherwise. Two pages reach it: `/airport/MDY?y=2021`
  // and `/airport/HNL?y=2021` (MDY-HNL, HA, 2021-09, its only filing).
  //
  // Derived from `basemapPathsFor` itself (never a hardcoded "nwhi is always empty"), so this
  // caption disappears on its own the day Midway gains real geometry, without a code change
  // here -- which is exactly what it just did for `pac`.
  const midwayHasNoBasemap = reached.includes("nwhi") && basemapPathsFor(["nwhi"]) === "";

  return (
    <div className="map">
      {/* The markup is this project's own projection of warehouse coordinates -- no user
          input reaches it, and the one string that could (the origin/destination codes) is
          a BTS code, already validated by the resolver that produced `network.origin`. */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {midwayHasNoBasemap ? (
        <p className="foot">
          {"The Midway inset has no coastline under its arcs — Natural Earth's public-domain " +
            "basemap carries Midway only inside one feature that also spans the Caribbean, so " +
            "it cannot be drawn on its own. Arcs and destinations still render correctly; " +
            "only the underlying landmass is missing."}
        </p>
      ) : null}
    </div>
  );
}
