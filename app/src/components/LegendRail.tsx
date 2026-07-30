/** Signature element 3 of 3 (docs/design/system.md "The legend rail"): a sticky panel
 * present on every data view, carrying the methodology explanation -- the gauge rail's
 * fixed axis, the reason-code gutter's glyphs, and the operating-carrier grain -- so there
 * is no separate "how to read this" page to go stale. Content and structure mirror
 * docs/design/mockups/table.html's `<aside class="legend">`, minus its "Arc rendering
 * (maps)" group: this page has no map, and the working reference's own map-specific group
 * would describe an encoding nothing on `/explore` uses. */
export function LegendRail() {
  return (
    <aside className="legend">
      <h4>Chart legend</h4>

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
      </div>
    </aside>
  );
}
