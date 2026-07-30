/** A fixed 0-260 seats-per-departure axis, one tick per row. Position encodes, never hue --
 * so the column reads the same in grayscale and in a screenshot. */
const GMAX = 260;
const TICKS = [50, 100, 150, 200, 250];

export function GaugeRail({ gauge, muted }: { gauge: number | null; muted?: boolean }) {
  if (gauge === null) return <div className="rail" aria-hidden="true" />;
  const pct = (v: number) => `${(v / GMAX) * 100}%`;
  return (
    <div className="rail" role="img" aria-label={`${gauge.toFixed(1)} seats per departure`}>
      <div className="band" style={{ left: 0, width: pct(110) }} />
      <div className="band" style={{ left: pct(210), right: 0 }} />
      {TICKS.map((v) => (
        <div key={v} className="grid" style={{ left: pct(v) }} />
      ))}
      <div
        className="tick"
        data-muted={muted ? "true" : undefined}
        style={{ left: pct(gauge) }}
      />
    </div>
  );
}
