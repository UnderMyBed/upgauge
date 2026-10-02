import type { MixRow } from "@/lib/chart/aircraftMix";
import {
  heatmapGrid,
  heatmapKeyNotes,
  heatmapLabel,
  type HeatCell,
} from "@/lib/chart/seasonality";
import { formatSeats } from "@/lib/format";

/** docs/design/system.md § Seasonality heatmap: seats by month, one row per year, drawn from the
 * SAME mix rows the aircraft-mix chart above it stacks, so a month's cell and that month's stack
 * height are one number.
 *
 * Hand-built server SVG, not Plot: a fixed grid of token fills and hairlines needs no scales, and
 * the markup is in the served HTML with JS off, the property every chart here has.
 *
 * Synchronous for the same reason as `AircraftMixChart`: an async child cannot be used as plain
 * JSX under the renderer the page tests use.
 *
 * Every visible string is ONE template literal, never adjacent JSX text nodes: React's SSR puts
 * `<!-- -->` between adjacent text nodes, which a raw-bytes needle in app/smoke.sh cannot see
 * through. */

// Geometry in viewBox units. The viewBox width is the content column's own width, so at full
// width a unit is a CSS pixel and a row is 22px -- the data table's row height. Narrower, the
// whole grid scales down together; no width is ever pinned.
const VIEW_W = 960;
const LABEL_W = 36; // the year column
const TOP = 16; // the month-initials row
const ROW = 22;
const GUTTER = 1; // --panel shows through
const COL_PITCH = (VIEW_W - LABEL_W) / 12;
const CELL_W = COL_PITCH - GUTTER;
const ROW_PITCH = ROW + GUTTER;
const TICK = 6;
const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const RAMP = ["--g1", "--g2", "--g3", "--g4", "--g5"] as const;

const TRUNCATED =
  "The monthly totals cannot be stated: the fetch behind this chart hit its row limit.";

function cellTitle(c: HeatCell): string {
  switch (c.kind) {
    case "value":
      return `${c.month} · ${formatSeats(c.seats)} seats`;
    case "understated":
      return `${c.month} · ${formatSeats(c.seats)} seats, understated`;
    case "unknown":
      return `${c.month} · filed, wholly quarantined`;
    default:
      return `${c.month} · no filings`;
  }
}

function Cell({ c, x, y }: { c: HeatCell; x: number; y: number }) {
  const title = <title>{cellTitle(c)}</title>;
  if (c.kind === "value" || c.kind === "understated") {
    return (
      <g>
        <rect
          data-month={c.month}
          data-kind={c.kind}
          x={x}
          y={y}
          width={CELL_W}
          height={ROW}
          fill={`var(${RAMP[c.bin! - 1]})`}
        >
          {title}
        </rect>
        {c.kind === "understated" ? (
          <path
            className="tick"
            d={`M${x + CELL_W - TICK} ${y}H${x + CELL_W}V${y + TICK}Z`}
          />
        ) : null}
      </g>
    );
  }
  // unknown / unfiled: no fill, a hairline inset by half a stroke so it stays inside the cell
  // and never meets a neighbour's across the 1-unit gutter.
  return (
    <g>
      <rect
        data-month={c.month}
        data-kind={c.kind}
        className="hairline"
        x={x + 0.5}
        y={y + 0.5}
        width={CELL_W - 1}
        height={ROW - 1}
        fill="none"
      >
        {title}
      </rect>
      {c.kind === "unknown" ? (
        <circle className="dot" cx={x + CELL_W / 2} cy={y + ROW / 2} r={2.5} />
      ) : null}
    </g>
  );
}

export function SeasonalityHeatmap({
  rows,
  title,
  truncated,
}: {
  rows: MixRow[];
  title: string;
  truncated: boolean;
}) {
  // Absent exactly when the mix chart is: its own absence note already states the finding.
  const grid = heatmapGrid(rows);
  if (grid === null) return null;

  // A capped fetch understates every month by an amount nobody can state, so no cell is drawn.
  if (truncated) {
    return (
      <Frame title={title}>
        <p className="foot">{TRUNCATED}</p>
      </Frame>
    );
  }

  const height = TOP + grid.years.length * ROW_PITCH - GUTTER;
  return (
    <Frame title={title}>
      <svg
        role="img"
        aria-label={heatmapLabel(grid)}
        viewBox={`0 0 ${VIEW_W} ${height}`}
        className="heatmap-grid"
        preserveAspectRatio="xMinYMin meet"
      >
        {MONTH_INITIALS.map((m, i) => (
          <text key={`m${i}`} className="hlab" x={LABEL_W + i * COL_PITCH + CELL_W / 2} y={TOP - 4} textAnchor="middle">
            {m}
          </text>
        ))}
        {grid.years.map(({ year }, r) => (
          <text key={`y${year}`} className="hlab" x={LABEL_W - 6} y={TOP + r * ROW_PITCH + ROW / 2} textAnchor="end" dominantBaseline="central">
            {`${year}`}
          </text>
        ))}
        {grid.years.flatMap(({ cells }, r) =>
          cells.map((c, col) =>
            c.kind === "outside" ? null : (
              <Cell key={c.month} c={c} x={LABEL_W + col * COL_PITCH} y={TOP + r * ROW_PITCH} />
            ),
          ),
        )}
      </svg>
      <div className="hkey">
        <span className="gnum">{formatSeats(grid.min)}</span>
        {RAMP.map((t) => (
          <i key={t} aria-hidden="true" style={{ background: `var(${t})` }} />
        ))}
        <span className="gnum">{formatSeats(grid.max)}</span>
        {heatmapKeyNotes(grid).map((n) => (
          <span key={n} className="gnum">
            {n}
          </span>
        ))}
      </div>
    </Frame>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="chart heatmap">
      <div className="chead">
        <div className="ctitle">Seats by month</div>
        <div className="csub">{`${title} · monthly seats · darker is more`}</div>
      </div>
      {children}
    </div>
  );
}
