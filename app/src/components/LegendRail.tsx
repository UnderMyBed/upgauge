/** Signature element 3 of 3 (docs/design/system.md "The legend rail"): a sticky panel
 * present on every data view, carrying the methodology explanation -- the gauge rail's
 * fixed axis, the reason-code gutter's glyphs, and the operating-carrier grain -- so there
 * is no separate "how to read this" page to go stale. Content and structure mirror
 * docs/design/mockups/table.html's `<aside class="legend">`, minus its "Arc rendering
 * (maps)" group: this page has no map, and the working reference's own map-specific group
 * would describe an encoding nothing on `/explore` uses.
 *
 * `fleetMix` is that same rule applied to M4c's stacked-area chart: the group is opt-in
 * because `/explore` draws no chart, and a rail that explained a monochrome gauge ramp on a
 * page with no ramp on it would be exactly the stale "how to read this" this element exists
 * to replace. */
export function LegendRail({ fleetMix = false }: { fleetMix?: boolean } = {}) {
  return (
    <aside className="legend">
      <h4>Chart legend</h4>

      {fleetMix ? <FleetShading /> : null}

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
      </div>
    </aside>
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
 * hex literals are not copied down here). */
function FleetShading() {
  return (
    <div className="grp">
      <div className="gt">Fleet shading</div>
      <div className="lrow">
        <span className="g" aria-hidden="true">
          <svg width="40" height="9" viewBox="0 0 40 9">
            <rect width="40" height="9" fill="var(--g1)" />
          </svg>
        </span>
        <em>smaller metal</em>
      </div>
      <div className="lrow">
        <span className="g" aria-hidden="true">
          <svg width="40" height="9" viewBox="0 0 40 9">
            <rect width="40" height="9" fill="var(--g5)" />
          </svg>
        </span>
        <em>larger metal</em>
      </div>
      <div className="lrow">
        <em>
          One ramp, ordered by seats per departure — a darkening stack is an upgauge. Band
          membership is a different ordering: the five types with the most seats get a band,
          and everything else is aggregated into the lightest band, Other, whose count and
          share of seats are stated on the chart&rsquo;s own key.
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
