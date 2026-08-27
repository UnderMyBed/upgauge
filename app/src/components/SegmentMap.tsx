import { basemapPathsFor } from "@/lib/map/basemap";
import {
  disclosureNotes,
  reachedPanelsFor,
  renderSegmentMap,
  type SegmentMapInput,
} from "@/lib/map/segmentMap";

/**
 * The point-to-point sibling of `NetworkMap.tsx`, and the single mount for all three of this
 * epic's maps -- `/carrier?type=`, `/aircraft?carrier=`, and the diff map's small multiples.
 * `renderSegmentMap`'s `<svg>...</svg>` string is injected exactly as `AircraftMixChart.tsx`
 * injects Plot's: server-rendered, in the served HTML, visible with JS off.
 *
 * Beyond that injection this component has exactly two jobs, and they are the same two
 * `NetworkMap.tsx` has:
 *
 * 1. Supply the coastline markup for the panels THIS map reaches. `basemapPathsFor` takes no
 *    points and does no fitting; the fit `renderSegmentMap` projects arcs with is the identical
 *    baked `fitPanels(BASEMAP_FIT_POINTS)` that markup was generated against (M7 Task 8). This
 *    component supplies WHICH panels, never how to align them -- and `reachedPanelsFor` is the
 *    engine's own answer to "which", so this cannot drift from what the renderer frames and
 *    labels.
 *
 * 2. Disclose the one panel that has no coastline, derived rather than hardcoded.
 *
 * THE DISCLOSURE NOTES ARE RENDERED HERE, AS HTML, AND THAT IS A HARD REQUIREMENT.
 * `renderSegmentMap` paints only the window line and the optional `title`; the cap, quarantine
 * and same-airport sentences come from `disclosureNotes` and land in the SVG's `aria-label` and
 * nowhere else. Joined they reach 204 characters against a 158-character budget (IBM Plex Mono
 * at font-size 10 is 6.0px per glyph across a 960px canvas), an inline `<svg>` takes the UA
 * stylesheet's `overflow: hidden`, and 12 real views were CLIPPED -- while the `aria-label`
 * carried the full text. The map was more honest to a screen reader than to the person looking
 * at it, which is the exact inversion these sentences exist to prevent. `disclosureNotes`'s own
 * docstring carries the measurement.
 *
 * So: a component that omits them re-creates that inversion on EVERY view of all three maps,
 * with no clipped tail to hint that anything is missing.
 *
 * AND THE COPY HAS ONE OWNER. Render `disclosureNotes(map)` verbatim -- never compose a sentence
 * from the numeric fields here. `elided = totalRoutes - drawn` plus the word "smaller" assumes
 * one reason a route is undrawn; there are three, and only one of them is size. Measured on
 * `8V x 035`, a hand-rolled sentence read "14 smaller routes are not drawn" about 14 routes that
 * were QUARANTINED, not smaller.
 *
 * The binding that keeps the two renderings honest -- `aria-label` contains
 * `disclosureNotes(map).join(" ")` -- was structural before A7 split them into two calls, and is
 * now a contract obligation asserted on every fixture in SegmentMap.test.tsx.
 */
export function SegmentMap({ map }: { map: SegmentMapInput }) {
  const reached = reachedPanelsFor(map.segments);
  const svg = renderSegmentMap({ ...map, basemapPaths: basemapPathsFor(reached) });
  const notes = disclosureNotes(map);

  // Derived from `basemapPathsFor` itself, never a hardcoded "nwhi is always empty", so this
  // caption disappears on its own the day Midway gains real geometry -- which is exactly what it
  // just did for `pac`, whose caption retired itself when #111 landed the Marianas coastline.
  // Keying it on "pac" would now be permanently WRONG rather than permanently true.
  //
  // Midway is the one gap left, and it is a property of the SOURCE: Natural Earth carries Midway
  // only inside a feature that also spans the Caribbean, which `build-basemap.mjs` cannot split
  // apart. So it gets its own panel, `nwhi`, which the renderer still frames and labels whenever
  // a map reaches it -- an empty, labelled box with a real arc and a real destination dot inside
  // it but no landmass under them, which reads as a rendering defect unless something says
  // otherwise.
  const midwayHasNoBasemap = reached.includes("nwhi") && basemapPathsFor(["nwhi"]) === "";

  return (
    <div className="map" data-testid="segment-map">
      {/* The markup is this project's own projection of warehouse coordinates -- no user input
          reaches it, and the one string that could (the airport codes) is a BTS code resolved by
          the same resolver that produced the page's own subject. */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {/* ONE `.foot` container, one `<p>` per note, so three disclosures do not stack three
          hairline rules down the page -- `.foot` carries the border and the notes carry the
          text. `AircraftMixChart.tsx` groups its notes the same way. */}
      {notes.length > 0 ? (
        <div className="foot" data-testid="map-notes">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
      {/* One sentence with one owner: this wording is `NetworkMap.tsx`'s, and if the two ever
          disagree that file is right. */}
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
