import { basemapPathsFor } from "@/lib/map/basemap";
import {
  networkDisclosureNotes,
  networkPanels,
  renderNetworkMap,
  type NetworkMapInput,
} from "@/lib/map/networkMap";

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
 *
 * THE DISCLOSURE NOTES ARE RENDERED HERE, AS HTML, AND THAT IS A HARD REQUIREMENT (#114) --
 * the same requirement, for the same measured reason, that `SegmentMap.tsx`'s header states.
 * `renderNetworkMap` paints only the window line and the same-airport note; the quarantine
 * sentence lands in the SVG's `aria-label` and nowhere else, because joining it into that one
 * painted line overruns the canvas's ~158-character budget and clips at the frame edge with
 * nothing in the markup recording it (`networkDisclosureNotes` carries the arithmetic). A
 * component that omits this block therefore ships a map that is more honest to a screen reader
 * than to the person looking at it -- the exact inversion the sentence exists to prevent.
 *
 * AND THE COPY HAS ONE OWNER. Render `networkDisclosureNotes(network)` verbatim; never compose a
 * sentence from `quarantinedRoutes` here. The wording -- count, reason, and "never clamped" --
 * belongs to `segmentMap.ts`'s `quarantinedNote`, shared with the point-to-point map so the two
 * cannot drift, and `NetworkMap.test.tsx` binds this block to it rather than to a literal.
 *
 * Typographic characters are written LITERALLY in the shared sentence (U+2014), not as JSX
 * entities: JSX decodes entities at compile time and React emits the raw code point, so a smoke
 * needle copied off an `&mdash;` could never fire (`DiffMap.tsx` carries the same rule).
 */
export function NetworkMap({ network }: { network: NetworkMapInput }) {
  const reached = networkPanels(network);
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

  const notes = networkDisclosureNotes(network);

  return (
    <div className="map">
      {/* The markup is this project's own projection of warehouse coordinates -- no user
          input reaches it, and the one string that could (the origin/destination codes) is
          a BTS code, already validated by the resolver that produced `network.origin`. */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      {/* ONE `.foot` container, one `<p>` per note, so a second disclosure never stacks a
          second hairline rule down the page -- `.foot` carries the border and the notes carry
          the text. `SegmentMap.tsx` and `AircraftMixChart.tsx` group theirs the same way.
          Rendered only when there IS something to disclose: an empty container would draw that
          rule for nothing. */}
      {notes.length > 0 ? (
        <div className="foot" data-testid="network-notes">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
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
