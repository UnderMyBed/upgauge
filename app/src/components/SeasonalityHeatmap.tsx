import type { MixRow } from "@/lib/chart/aircraftMix";
import {
  heatmapGrid,
  heatmapKeyNotes,
  heatmapLabel,
  type HeatCell,
  type HeatGrid,
} from "@/lib/chart/seasonality";
import { FIT_VIEW_W } from "@/lib/chart/fit";
import { ChartFit } from "@/components/ChartFit";
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

// Geometry in viewBox units. At the wide fit the viewBox width is the content column's own
// width, so a unit is a CSS pixel and a row is 22px -- the data table's row height. The grid is
// drawn once per fit (ChartFit, lib/chart/fit.ts): only the viewBox width changes between them,
// so the columns narrow toward square cells while the label column, the row height and the
// 10-unit `.hlab` text keep their size in units -- and therefore near 9-16 CSS px at every
// column width. No width is ever pinned.
const LABEL_W = 36; // the year column
const TOP = 16; // the month-initials row
const ROW = 22;
const GUTTER = 1; // --panel shows through
const ROW_PITCH = ROW + GUTTER;
const TICK = 6;

/** Column geometry for one fit's viewBox width. */
function columns(viewW: number) {
  const pitch = (viewW - LABEL_W) / 12;
  return { pitch, cellW: pitch - GUTTER };
}
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

function Cell({ c, x, y, cellW }: { c: HeatCell; x: number; y: number; cellW: number }) {
  const title = <title>{cellTitle(c)}</title>;
  if (c.kind === "value" || c.kind === "understated") {
    return (
      <g>
        <rect
          data-month={c.month}
          data-kind={c.kind}
          x={x}
          y={y}
          width={cellW}
          height={ROW}
          fill={`var(${RAMP[c.bin! - 1]})`}
        >
          {title}
        </rect>
        {c.kind === "understated" ? (
          <path
            className="tick"
            d={`M${x + cellW - TICK} ${y}H${x + cellW}V${y + TICK}Z`}
          />
        ) : null}
      </g>
    );
  }
  // unknown / unfiled: no fill and a hairline. The rect is inset 0.5 viewBox units on each side,
  // but the stroke is non-scaling (1 CSS px at every width), so the two only line up at the full
  // 960-unit width, where the stroke sits exactly inside the cell. Narrower, the inset shrinks
  // with the grid while the stroke does not, so up to half a pixel of it falls in the gutter.
  return (
    <g>
      <rect
        data-month={c.month}
        data-kind={c.kind}
        className="hairline"
        x={x + 0.5}
        y={y + 0.5}
        width={cellW - 1}
        height={ROW - 1}
        fill="none"
      >
        {title}
      </rect>
      {c.kind === "unknown" ? (
        <circle className="dot" cx={x + cellW / 2} cy={y + ROW / 2} r={2.5} />
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

  // ONE grid and ONE label, drawn once per fit: the renders differ in geometry only.
  const label = heatmapLabel(grid);
  return (
    <Frame title={title}>
      <ChartFit render={(fit) => <Grid grid={grid} label={label} viewW={FIT_VIEW_W[fit]} />} />
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

function Grid({ grid, label, viewW }: { grid: HeatGrid; label: string; viewW: number }) {
  const { pitch, cellW } = columns(viewW);
  const height = TOP + grid.years.length * ROW_PITCH - GUTTER;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${viewW} ${height}`}
      className="heatmap-grid"
      preserveAspectRatio="xMinYMin meet"
    >
      {MONTH_INITIALS.map((m, i) => (
        <text key={`m${i}`} className="hlab" x={LABEL_W + i * pitch + cellW / 2} y={TOP - 4} textAnchor="middle">
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
            <Cell key={c.month} c={c} x={LABEL_W + col * pitch} y={TOP + r * ROW_PITCH} cellW={cellW} />
          ),
        ),
      )}
    </svg>
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
