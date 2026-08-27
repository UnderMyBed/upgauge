/** A fixed 0-260 seats-per-departure axis, one tick per row. Position encodes, never hue --
 * so the column reads the same in grayscale and in a screenshot. */
const GMAX = 260;
const TICKS = [50, 100, 150, 200, 250];

/** The axis itself -- bands and gridlines, no value. Drawn whether or not there is a tick to
 * put on it, because an instrument that disappears when it has nothing to show reads as a
 * rendering fault rather than as an absence (docs/design/system.md, § The data table: the same
 * reason a measure cell renders an em dash instead of going blank). */
function Axis({ pct }: { pct: (v: number) => string }) {
  return (
    <>
      <div className="band" style={{ left: 0, width: pct(110) }} />
      <div className="band" style={{ left: pct(210), right: 0 }} />
      {TICKS.map((v) => (
        <div key={v} className="grid" style={{ left: pct(v) }} />
      ))}
    </>
  );
}

/** THREE STATES, NOT TWO.
 *
 * `undefined` -- the query never asked for `avg_gauge`, so this row makes NO CLAIM about the
 * gauge and the cell draws nothing. `null` -- the gauge WAS queried and cannot be stated, which
 * is a finding, and the axis is drawn to say so. A number draws the axis and marks it.
 *
 * Collapsing the first two is the defect `DataTable`'s `isBelowFloor` already records paid for
 * one column to the left: `num()` maps absent and null alike to `null`, so a `/explore` permalink
 * that never selected `avg_gauge` -- the default top-25 carriers is one -- rendered all 25 rows
 * in the wholly-quarantined visual state. None of them was quarantined. */
export function GaugeRail({
  gauge,
  muted,
}: {
  gauge: number | null | undefined;
  muted?: boolean;
}) {
  const pct = (v: number) => `${(v / GMAX) * 100}%`;
  // No claim: the measure was never queried. An axis here would assert a finding about a column
  // this query does not carry.
  if (gauge === undefined) return <div className="rail" aria-hidden="true" />;
  // KEEP THE FRAME, OMIT THE VALUE. A queried-but-unknowable gauge has no position to mark, but
  // the 0-260 axis is a property of the COLUMN, not of the row, so dropping it punches a hole
  // through the instrument and the rows below lose their shared reference. `aria-hidden` because
  // the row already states the absence twice in text: the em dash in the gauge cell and the `Q`
  // in the gutter, with its reason.
  if (gauge === null) {
    return (
      <div className="rail" aria-hidden="true">
        <Axis pct={pct} />
      </div>
    );
  }
  return (
    <div className="rail" role="img" aria-label={`${gauge.toFixed(1)} seats per departure`}>
      <Axis pct={pct} />
      <div
        className="tick"
        data-muted={muted ? "true" : undefined}
        style={{ left: pct(gauge) }}
      />
    </div>
  );
}
