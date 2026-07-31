import { formatSeats, formatLoadFactor, formatGauge, formatCount } from "@/lib/format";
import { GaugeRail } from "@/components/GaugeRail";
import { ReasonCode, type Reason } from "@/components/ReasonCode";
import { resolutionKey, displayValue, type Resolved } from "@/lib/resolve";
import { entityHref } from "@/lib/entityLink";

export interface ColumnSpec {
  key: string;
  label: string;
  kind: "identifier" | "seats" | "loadFactor" | "gauge" | "count";
  derived?: boolean;
  /** The catalog dimension this column displays, when it is one. Present ⇒ the cell renders
   * a resolved code rather than the raw id. */
  dimKey?: string;
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

/** A dimension cell shows the CODE; the name is the abbreviation's expansion. The table is
 * dense by rule (system.md) and a full carrier name per row would swamp a column sized for
 * two letters. Where a dimension has no code -- city markets -- the name IS the value, so it
 * renders directly rather than hiding in a title no keyboard user can reach. The three-way
 * value selection itself (raw id / name / code) is `displayValue()` in lib/resolve.ts, shared
 * with explore/page.tsx's `routeCode` -- only the `abbr` wrapping is specific to this
 * component.
 *
 * This is the chokepoint every table in the product renders its dimension cells through
 * (M5, "connect the graph"): `/explore` and all four entity pages build their columns with
 * the same `dimKey: allowlist.dims.get(c)?.joinDim ? c : undefined` expression, so wrapping
 * the cell in an `<a>` here links every one of them at once. `entityHref` -- not a second,
 * locally-derived URL -- decides linkability: it returns `null` for a dimension with no
 * entity page, an unresolved id, or a resolution with no code, and the `<abbr>` nests INSIDE
 * the `<a>` rather than being replaced by it, so the keyboard-reachable full name survives on
 * every linked cell too. */
function DimensionCell({ spec, row, resolved }: {
  spec: ColumnSpec;
  row: Record<string, unknown>;
  resolved?: Map<string, Resolved>;
}) {
  const raw = row[spec.key];
  const hit = spec.dimKey ? resolved?.get(resolutionKey(spec.dimKey, raw)) : undefined;
  const value = displayValue(hit, raw);
  const href = spec.dimKey ? entityHref(spec.dimKey, hit) : null;
  const inner =
    hit !== undefined && hit.code !== null && hit.name ? (
      <abbr title={hit.name}>{value}</abbr>
    ) : (
      <>{value}</>
    );
  return href ? <a href={href}>{inner}</a> : inner;
}

/** A non-dimension identifier column -- explore's synthetic `__route` cell is the one case
 * today -- may carry a pre-computed href in a sibling row field named `<key>Href`. `route`'s
 * `column_expr` spans two columns that both resolve through `dim_airport`, so it is never a
 * `DimensionCell` (see `entityLink.ts`'s own docstring: "Use `routeHrefFromCodes` for it") --
 * the page that assembles the row is the only place that knows both halves resolved, so it
 * computes the href itself and hands it across as plain row data rather than this component
 * re-deriving it. Absent or non-string, this renders exactly what `format()` alone would --
 * every other identifier column is unaffected. */
function IdentifierCell({ spec, row }: { spec: ColumnSpec; row: Record<string, unknown> }) {
  const text = format(spec.kind, row[spec.key]);
  const href = row[`${spec.key}Href`];
  return typeof href === "string" ? <a href={href}>{text}</a> : <>{text}</>;
}

function isQuarantined(row: Record<string, unknown>): boolean {
  return (num(row.quarantined_rows) ?? 0) > 0;
}

function isZeroPax(row: Record<string, unknown>): boolean {
  return num(row.load_factor) === 0 && (num(row.departures_performed) ?? 0) > 0;
}

/** Absence is not a measurement of zero (see lib/format.ts's opening rule). The pivot
 * templates emit only the measures the query selected, so `departures_performed` is missing
 * from every row of any permalink that did not ask for it -- including the error page's own
 * "known-valid query" link. Reading that absence as 0 marked 100% of those rows below floor:
 * a dashed, muted row and an `n` glyph in every gutter cell, asserting something false about
 * the data on the surface the design system calls the trust moment. A row whose departure
 * count was never queried makes no claim about the floor either way. */
function isBelowFloor(row: Record<string, unknown>): boolean {
  const departures = num(row.departures_performed);
  return departures !== null && departures < DEPARTURE_FLOOR;
}

/** The gutter glyph and the below-floor row treatment are independent signals, not one
 * collapsed state. Measured over the trailing 12 months at route grain: 21,569 rows total,
 * 13,470 below floor, 3,278 zero-pax, and 3,202 of those are BOTH -- 97.7% of every zero-pax
 * row is also below floor. A single `reason` used to gate row treatment made that 14.8% of
 * all rows (the near-entirety of the zero-pax class) render as ordinary scored rows, which
 * silently dropped the below-floor signal from exactly the rows the design system calls the
 * trust moment. The gutter still shows one glyph, chosen by severity (`Q` > `⌀` > `n`,
 * `reasonFor`); the row treatment (`data-below-floor`, dashed rule, muted text, muted gauge
 * tick) is driven by `isBelowFloor()` directly and applies whenever the row is below floor,
 * regardless of which glyph won. See docs/design/system.md, "reason-code gutter". */
function reasonFor(row: Record<string, unknown>): Reason {
  if (isQuarantined(row)) return "quarantined";
  if (isZeroPax(row)) return "zeroPax";
  if (isBelowFloor(row)) return "belowFloor";
  return null;
}

export function DataTable({
  columns,
  rows,
  resolved,
}: {
  columns: ColumnSpec[];
  rows: Record<string, unknown>[];
  resolved?: Map<string, Resolved>;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="gut" scope="col" />
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
          <th scope="col">Gauge, seats per departure</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const reason = reasonFor(row);
          const belowFloor = isBelowFloor(row);
          return (
            <tr key={i} data-below-floor={belowFloor ? "true" : undefined}>
              <ReasonCode
                reason={reason}
                detail={
                  typeof row.quarantine_reasons === "string" ? row.quarantine_reasons : null
                }
              />
              {columns.map((c) => (
                <td key={c.key} className={c.kind === "identifier" ? "id" : "num"}>
                  {c.dimKey ? (
                    <DimensionCell spec={c} row={row} resolved={resolved} />
                  ) : (
                    <IdentifierCell spec={c} row={row} />
                  )}
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
