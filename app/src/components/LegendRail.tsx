import { BY_AIRCRAFT_TYPE, type MixDimension } from "@/lib/chart/aircraftMix";

/** Signature element 3 of 3 (docs/design/system.md "The legend rail"): a sticky panel
 * present on every data view, carrying the methodology explanation -- the gauge rail's
 * fixed axis, the reason-code gutter's glyphs, and the operating-carrier grain -- so there
 * is no separate "how to read this" page to go stale. Content and structure mirror
 * docs/design/mockups/table.html's `<aside class="legend">` and, for the `map` group,
 * docs/design/mockups/map-network.html's own "Arc rendering" + "Nodes" groups.
 *
 * `fleetMix` is that same rule applied to M4c's stacked-area chart: the group is opt-in
 * because `/explore` draws no chart, and a rail that explained a monochrome gauge ramp on a
 * page with no ramp on it would be exactly the stale "how to read this" this element exists
 * to replace.
 *
 * `stack` is M4d's application of the SAME rule one level down: the chart is now stacked by
 * either aircraft type or operating carrier, and the two ramps do not mean the same thing. On
 * `/aircraft/<slug>` every band is the same airframe, so "larger metal" and "the five types
 * with the most seats" would both be false sentences in a panel whose entire job is telling a
 * reader how to read the thing next to it. Defaulted, so `/explore`, `/route`, `/airport` and
 * `/carrier` are untouched.
 *
 * `map` is the M7 counterpart, opt-in for the same reason: three pages draw a map and the rest
 * do not. `/airport/<code>` draws a hub network, `/carrier/<code>` a point-to-point network for
 * one aircraft type, and `/aircraft/<name>` the same for one carrier -- `/carrier` also carries
 * the diff map's three panels, covered by the same rail. Opt-in because the map encodes three
 * independent facts (stroke width by seats, dash by load factor, dotted/muted by the departure
 * floor) that nothing else on a served page explains, and a page without a map must not claim
 * them. The wording is deliberately route-scoped rather than destination-scoped: on every one
 * of these maps an arc is a ROUTE, which is true of the hub map too. */
export function LegendRail({
  fleetMix = false,
  stack = BY_AIRCRAFT_TYPE,
  map = false,
}: { fleetMix?: boolean; stack?: MixDimension; map?: boolean } = {}) {
  return (
    <aside className="legend">
      <h4>Chart legend</h4>

      {fleetMix ? <FleetShading stack={stack} /> : null}
      {map ? <ArcRendering /> : null}

      <div className="grp">
        <div className="gt">Gauge rail</div>
        <div className="lrow">
          <span className="g" aria-hidden="true">
            <svg width="40" height="10" viewBox="0 0 40 10">
              <rect x="0" y="2" width="40" height="6" fill="var(--panel-2)" />
              <rect x="7" y="0" width="2" height="10" fill="var(--ink)" />
            </svg>
          </span>
          <em>one tick, fixed 0–260 axis</em>
        </div>
        <div className="lrow">
          <span className="g font-mono">&lt;110</span>
          <em>regional metal</em>
        </div>
        <div className="lrow">
          <span className="g font-mono">&gt;210</span>
          <em>widebody</em>
        </div>
      </div>

      <div className="grp">
        <div className="gt">Row marks</div>
        <div className="lrow">
          <b>⌀</b>
          <em>flew, carried no passengers</em>
        </div>
        <div className="lrow">
          <b className="k">n</b>
          <em>below the 30-departure floor</em>
        </div>
        <div className="lrow">
          <b>Q</b>
          <em>quarantined — failed an invariant</em>
        </div>
        {/* WHAT THE GLYPH ENCODES, NOT WHY IT IS THERE. `lib/format.ts`: null is absence, zero
            is a measurement. Absence has several causes -- nothing filed, every filing
            quarantined, a zero denominator -- and this rail is rendered unconditionally on every
            table view, so naming any one of them states a finding the page may contradict two
            lines down. The per-row cause is the gutter's job; this declares only that the mark
            is never a zero, which is the thing a reader cannot otherwise tell. */}
        <div className="lrow">
          {/* `.k`, like `n` two rows up and for the same reason: globals.css splits this glyph's
              colour into --limit for an OUT-OF-LIMIT code (`⌀`, `Q`) and --ink for a
              DATA-AVAILABILITY one. A dash is the second kind, and without `.k` it inherits
              --limit -- declaring, in red, a mark the tables draw in ordinary ink, which
              reinstates through colour the same cause-claim this row's words refuse. No
              `font-mono`: `.lrow b` is unlayered and already sets the mono family, so the
              utility class loses to it and does nothing. */}
          <b className="k">—</b>
          <em>no measure to state — never a zero</em>
        </div>
        <div className="lrow">
          <span className="g deriv font-mono">abc</span>
          <em>computed measure</em>
        </div>
      </div>

      <div className="grp">
        <div className="gt">Reading this</div>
        <div className="lrow">
          <em>
            Operating carrier is the grain: a Delta-branded regional files under its own
            code, not DL. Summing carriers does not double-count.
          </em>
        </div>
        <div className="lrow">
          <em>
            Codes and names are current identity, not point-in-time filings. A carrier that
            changed code, or an airport that was renamed, shows its present-day form on
            every row.
          </em>
        </div>
        {/* Unconditional, unlike the fleetMix group above -- every view the rail appears on
            is built from this same source, whether or not that view happens to draw a chart,
            so the attribution belongs to the rail itself rather than to the opt-in group. */}
        <div className="lrow">
          <em>
            Source: US DOT / Bureau of Transportation Statistics, T-100 Segment (All Carriers)
            -- public-domain US Government data.
          </em>
        </div>
      </div>
    </aside>
  );
}

/** The network map's own encodings (`app/src/lib/map/arcs.ts`'s `strokeFor`, `networkMap.ts`'s
 * cross-panel branch), mirroring `docs/design/mockups/map-network.html`'s "Arc rendering" and
 * "Nodes" groups. Three independent channels, stated as three rows rather than folded into
 * one, since `strokeFor` itself treats them as independent (a floor arc's load factor is never
 * even consulted): stroke WIDTH scales with seats: `0.7 + 2.9*sqrt(seats/max)`; a DASHED
 * stroke (`"5 3"`) means this route's load factor is below 70%; a DOTTED, muted stroke
 * (`"1 3"`, `--ink-3`) overrides both of the above when the route is below the
 * 30-departure floor -- "barely flown" is the whole story for that arc, so it is never also
 * scaled by seats or dashed by load factor. */
function ArcRendering() {
  return (
    <div className="grp">
      <div className="gt">Arc rendering</div>
      <div className="lrow">
        <span className="g" aria-hidden="true">
          <svg width="40" height="10" viewBox="0 0 40 10">
            <line x1="1" y1="5" x2="39" y2="5" stroke="var(--ink)" strokeWidth={3.2} />
          </svg>
        </span>
        <em>width scales with seats -- heavier route, thicker arc</em>
      </div>
      <div className="lrow">
        <span className="g" aria-hidden="true">
          <svg width="40" height="10" viewBox="0 0 40 10">
            <line
              x1="1"
              y1="5"
              x2="39"
              y2="5"
              stroke="var(--ink)"
              strokeWidth={1.8}
              strokeDasharray="5 3"
            />
          </svg>
        </span>
        <em>dashed -- this route&rsquo;s load factor is below 70%</em>
      </div>
      <div className="lrow">
        <span className="g" aria-hidden="true">
          <svg width="40" height="10" viewBox="0 0 40 10">
            <line
              x1="1"
              y1="5"
              x2="39"
              y2="5"
              stroke="var(--ink-3)"
              strokeWidth={1}
              strokeDasharray="1 3"
            />
          </svg>
        </span>
        <em>dotted, muted -- below the 30-departure floor (overrides both rows above)</em>
      </div>
      <div className="lrow">
        <em>
          Most arcs are true great-circle paths. One that would cross a panel boundary --
          conterminous US, Alaska, Hawai‘i, the Pacific or the Caribbean, in either direction
          -- is drawn as a straight line instead: a great circle is discontinuous across a
          panel boundary, so every US network map makes this compromise; this one draws it
          rather than hiding it.
        </em>
      </div>
    </div>
  );
}

/** The methodology behind the aircraft-mix chart's ramp, and nothing else.
 *
 * Deliberately carries no numbers. How many types "Other" aggregates and what share of seats
 * it carries are per-subject facts -- they differ for every route -- and they are already
 * stated on the chart's own colour key, attached to the swatch they describe. Restating them
 * here would put the same measurement in two places, one of which is a static component that
 * cannot know the subject; the rail's job is the part that is true of every chart.
 *
 * The two swatches read `var(--g1)` and `var(--g5)`, the ends of the ramp the chart itself
 * draws from, so `globals.css` stays the single source for the palette (the mockup's own
 * hex literals are not copied down here).
 *
 * Every word that depends on WHAT is stacked comes from `stack` (lib/chart/aircraftMix.ts's
 * MixDimension), not from here: the ramp's two ends and the unit membership is counted in. The
 * rest of the group is true of both stacks and stays literal. */
function FleetShading({ stack }: { stack: MixDimension }) {
  return (
    <div className="grp">
      <div className="gt">Fleet shading</div>
      <div className="lrow">
        <span className="g" aria-hidden="true">
          <svg width="40" height="9" viewBox="0 0 40 9">
            <rect width="40" height="9" fill="var(--g1)" />
          </svg>
        </span>
        <em>{stack.rampLight}</em>
      </div>
      <div className="lrow">
        <span className="g" aria-hidden="true">
          <svg width="40" height="9" viewBox="0 0 40 9">
            <rect width="40" height="9" fill="var(--g5)" />
          </svg>
        </span>
        <em>{stack.rampDark}</em>
      </div>
      <div className="lrow">
        {/* One string per sentence rather than text interleaved with `{stack.unit}`: React's
            SSR would otherwise emit `<!-- -->` inside the phrase, which `textContent` hides
            from every test here and a raw-bytes grep in app/smoke.sh would trip over. Same
            trap as the chart's own title. */}
        <em>
          {`One ramp, ordered by seats per departure — a darkening stack is an upgauge. Band ` +
            `membership is a different ordering: the five ${stack.unit}s with the most seats ` +
            `get a band, and everything else is aggregated into the lightest band, Other, ` +
            `whose count and share of seats are stated on the chart’s own key.`}
        </em>
      </div>
      <div className="lrow">
        <em>
          The shaded months are 2020-03 to 2021-06. COVID is in the window on purpose and is
          drawn, never smoothed away.
        </em>
      </div>
    </div>
  );
}
