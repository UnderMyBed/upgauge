import { formatSeats, formatLoadFactor, formatGauge, formatCount } from "@/lib/format";
import { GaugeRail } from "@/components/GaugeRail";
import { ReasonCode, type Reason } from "@/components/ReasonCode";

export interface ColumnSpec {
  key: string;
  label: string;
  kind: "identifier" | "seats" | "loadFactor" | "gauge" | "count";
  derived?: boolean;
}

const DEPARTURE_FLOOR = 30;

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function format(kind: ColumnSpec["kind"], v: unknown): string {
  switch (kind) {
    case "seats":
      return formatSeats(num(v));
    case "loadFactor":
      return formatLoadFactor(num(v));
    case "gauge":
      return formatGauge(num(v));
    case "count":
      return formatCount(num(v));
    default:
      return v === null || v === undefined ? "—" : String(v);
  }
}

/** Rows are reported, never hidden. Below-floor rows are marked and excluded from ranking,
 * not from sight -- a table that only looks right when full looks broken most of the time. */
function reasonFor(row: Record<string, unknown>): Reason {
  if (num(row.quarantined_rows) ?? 0) return "quarantined";
  if (num(row.load_factor) === 0 && (num(row.departures_performed) ?? 0) > 0) return "zeroPax";
  if ((num(row.departures_performed) ?? 0) < DEPARTURE_FLOOR) return "belowFloor";
  return null;
}

export function DataTable({
  columns,
  rows,
}: {
  columns: ColumnSpec[];
  rows: Record<string, unknown>[];
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="gut" />
          {columns.map((c) => (
            <th
              key={c.key}
              className={c.kind === "identifier" ? undefined : "r"}
              data-derived={c.derived ? "true" : undefined}
              scope="col"
            >
              {c.label}
            </th>
          ))}
          <th>Gauge, seats per departure</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const reason = reasonFor(row);
          const belowFloor = reason === "belowFloor";
          return (
            <tr key={i} data-below-floor={belowFloor ? "true" : undefined}>
              <ReasonCode reason={reason} />
              {columns.map((c) => (
                <td key={c.key} className={c.kind === "identifier" ? "id" : "num"}>
                  {format(c.kind, row[c.key])}
                </td>
              ))}
              <td>
                <GaugeRail gauge={num(row.avg_gauge)} muted={belowFloor} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
