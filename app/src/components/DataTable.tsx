import { formatSeats, formatLoadFactor, formatGauge, formatCount } from "@/lib/format";
import { GaugeRail } from "@/components/GaugeRail";
import { ReasonCode, type Reason } from "@/components/ReasonCode";
import { resolutionKey, displayValue, type Resolved } from "@/lib/resolve";
import { entityHref } from "@/lib/entityLink";
import { belowFloor } from "@/lib/floor";

export interface ColumnSpec {
  key: string;
  label: string;
  kind: "identifier" | "seats" | "loadFactor" | "gauge" | "count";
  derived?: boolean;
  /** The catalog dimension this column displays, when it is one. Present ⇒ the cell renders
   * a resolved code rather than the raw id. */
  dimKey?: string;
  /** Per-row href for a column that isn't a single-dimension resolution -- `route`'s
   * composite `__route` cell is the one caller today (its `column_expr` spans two columns
   * that both resolve through `dim_airport`, so `entityHref`/`dimKey` can't express it; see
   * `DimensionCell`'s docstring). A typed accessor, not a naming convention on
   * `Record<string, unknown>`: there is nothing to spell wrong and no collision surface with
   * a row's own data. Returns `null` for a row that shouldn't link (e.g. one of the two
   * codes it composes didn't resolve) -- `IdentifierCell` renders plain text for that row,
   * same as a column with no `href` at all. */
  href?: (row: Record<string, unknown>) => string | null;
}


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

/** A non-dimension identifier column that DOES carry a `ColumnSpec.href` accessor -- `route`'s
 * synthetic `__route` cell is the one caller today. `route`'s `column_expr` spans two columns
 * that both resolve through `dim_airport`, so it is never a `DimensionCell` (see
 * `entityLink.ts`'s own docstring: "Use `routeHrefFromCodes` for it") -- the page that
 * assembles the column is the only place that knows both halves resolved, so it supplies the
 * per-row accessor itself rather than this component re-deriving anything. `DataTable` only
 * renders this component for a column whose `href` is set (see the render loop below), so a
 * plain identifier column with neither `dimKey` nor `href` -- and every numeric measure
 * column, which never carries either -- takes the same bare `format()` path it always has. */
function IdentifierCell({ spec, row }: { spec: ColumnSpec; row: Record<string, unknown> }) {
  const text = format(spec.kind, row[spec.key]);
  const href = spec.href?.(row) ?? null;
  return href ? <a href={href}>{text}</a> : <>{text}</>;
}

function isQuarantined(row: Record<string, unknown>): boolean {
  return (num(row.quarantined_rows) ?? 0) > 0;
}

function isZeroPax(row: Record<string, unknown>): boolean {
  return num(row.load_factor) === 0 && (num(row.departures_performed) ?? 0) > 0;
}

/** THE FLOOR IS PER MONTH FLOWN, NOT PER QUERY WINDOW (#134). `lib/floor.ts` holds the rule
 * and the single declaration of the constant; this function only supplies the two fields.
 *
 * Both come off the row, and both come from the pivot: `departures_performed` is a measure the
 * query selected, `active_months` is the companion count both templates emit unconditionally
 * beside `quarantined_rows` (sql/03_queries/pivot_segment.sql). Every table in the product is
 * fed a TRAILING-12 window, so dividing is not a refinement -- comparing that window's summed
 * departures against 30 is what made the rule ~12x too lenient, and a route filing 2.5
 * departures a month read as scored.
 *
 * Absence is not a measurement of zero (lib/format.ts's opening rule). The pivot templates
 * emit only the measures the query selected, so `departures_performed` is missing from every
 * row of any permalink that did not ask for it -- including the error page's own
 * "known-valid query" link. Reading that absence as 0 marked 100% of those rows below floor:
 * a dashed, muted row and an `n` glyph in every gutter cell, asserting something false about
 * the data on the surface the design system calls the trust moment. A row whose departure
 * count was never queried makes no claim about the floor either way, and neither does one
 * carrying no month count -- which is how /watch's mart-fed rows correctly abstain.
 *
 * `num()` for departures and a separate `undefined` check for the months, because the two
 * absences are not the same shape: a queried departure count can be NULL (a wholly-quarantined
 * group's FILTERed sum), whereas `active_months` is a COUNT that is either present or was
 * never emitted. `belowFloor` collapses both to "no claim" -- see its own docstring for why
 * that is not a swallowed error. */
function isBelowFloor(row: Record<string, unknown>): boolean {
  return belowFloor(num(row.departures_performed), num(row.active_months));
}

/** One row in render order, carrying everything the render loop needs -- it derives nothing
 * of its own. `rank` is 1-based among SCORED rows only; see `orderRows`. */
interface OrderedRow {
  row: Record<string, unknown>;
  belowFloor: boolean;
  rank: number | null;
}

/** Below-floor rows last, the measure order preserved inside each block.
 *
 * TWO BUCKETS AND AN APPEND, never `Array.prototype.sort` with a boolean comparator. The
 * requirement is that the incoming order survives inside each block, and this shape makes that
 * STRUCTURAL -- nothing inside a bucket is ever compared, so the stability does not rest on
 * V8's sort being stable, and "re-sorts within the group" is not a change anyone can make here
 * by accident. A comparator would also invite a measure tiebreak later, which is the same bug
 * wearing a different hat.
 *
 * `isBelowFloor` and nothing else decides the bucket -- NOT `reasonFor`. The two are
 * independent signals (see below), and the base rate that matters here is the share of
 * BELOW-FLOOR rows showing some other glyph: roughly one in five shows `Q` or `⌀`, because the
 * gutter picks one code by severity. Partitioning on the winning glyph would leave every one of
 * those sitting among the scored rows -- the same re-coupling `reasonFor`'s own comment exists
 * to prevent, re-introduced one layer down. */
function partitionByFloor(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const scored: Record<string, unknown>[] = [];
  const sparse: Record<string, unknown>[] = [];
  for (const row of rows) (isBelowFloor(row) ? sparse : scored).push(row);
  return [...scored, ...sparse];
}

/** The rendered order and each row's rank, in one pass.
 *
 * RANK COUNTS SCORED ROWS ONLY. A below-floor row gets `null`, which the rank cell renders as
 * `—`: docs/design/system.md says such a row is "sorted below scored rows, excluded from
 * ranking", and a number printed against it would be neither its position by measure nor a
 * withheld one. Measured on the real warehouse, this is not hypothetical -- `/carrier`'s Top
 * routes table renders 297 below-floor rows across 33 of 70 carriers. Twelve of those pages
 * carry ten or more such rows; by the position of their FIRST one they are `4W` (2 of 25, 24
 * below), `JN` (2 of 16, 15), `V8` (3 of 21, 19), `TJ` (3 of 15, 13), `K3` (4 of 25, 22),
 * `7S` (5 of 25, 17), `5V` (6 of 25, 19), `2O` (6 of 25, 20), `AN` (7 of 25, 16), `6F`
 * (8 of 25, 17), `XP` (12 of 25, 13) and `J5` (14 of 25, 12).
 *
 * RE-MEASURED UNDER THE MONTHLY FLOOR (#134), not carried forward: the same table read 141 rows
 * over 24 carriers while the floor was a raw twelve-month departure sum.
 *
 * `partition` is the rule, and `false` is the exception one caller asks for -- see the
 * component's own `partition` note. Defaulted ON there so a sixth table surface inherits the
 * rule rather than the exemption.
 *
 * WITH `partition` OFF, NOTHING IS RANKED. A rank is a row's position among scored rows *in the
 * order the product chose*, so an unpartitioned table has no such order and no rank to state --
 * returning one would number a sequence the floor rule never arranged. Left ranked, the pair
 * renders a column that walks 1, —, 2 down the page. The component makes that combination
 * unwritable (its props reject `rank` beside `partition={false}`); this makes the pure function
 * honest on its own, so a direct caller cannot reach the same shape by another door. */
export function orderRows(
  rows: Record<string, unknown>[],
  partition: boolean,
): OrderedRow[] {
  const ordered = partition ? partitionByFloor(rows) : rows;
  let scored = 0;
  return ordered.map((row) => {
    const belowFloor = isBelowFloor(row);
    return { row, belowFloor, rank: partition && !belowFloor ? ++scored : null };
  });
}

/** The gutter glyph and the below-floor row treatment are independent signals, not one
 * collapsed state. A row can be below floor AND zero-pax at once, and nearly every zero-pax row
 * is; run the other way -- which is the direction that matters -- roughly one in five below-floor
 * rows shows `⌀` or `Q` rather than `n`. A single `reason` used to gate row treatment rendered
 * all of those as ordinary scored rows, silently dropping the below-floor signal from exactly
 * the rows the design system calls the trust moment. The gutter still shows one glyph, chosen
 * by severity (`Q` > `⌀` > `n`,
 * `reasonFor`); the row treatment (`data-below-floor`, dashed rule, muted text, muted gauge
 * tick) is driven by `isBelowFloor()` directly and applies whenever the row is below floor,
 * regardless of which glyph won. See docs/design/system.md, "reason-code gutter". */
function reasonFor(row: Record<string, unknown>): Reason {
  if (isQuarantined(row)) return "quarantined";
  if (isZeroPax(row)) return "zeroPax";
  if (isBelowFloor(row)) return "belowFloor";
  return null;
}

interface DataTableBaseProps {
  columns: ColumnSpec[];
  /** In the caller's own order. This component re-orders them on exactly one axis -- below-floor
   * rows last (`orderRows`) -- and never on a measure: a caller that wants rank-by-measure still
   * sorts `rows` itself before handing them here. */
  rows: Record<string, unknown>[];
  resolved?: Map<string, Resolved>;
}

/** `rank` and `partition` are ONE choice, not two independent ones, so the props make the
 * illegal pair unwritable rather than merely unused.
 *
 * `rank` is a row's position among scored rows in the order the product chose; `partition` is
 * what arranges that order, so ranking an unpartitioned table asks for a position in an order
 * nothing established. `orderRows` answers that honestly -- it ranks nothing at all -- so the
 * pair renders a rank column of em dashes end to end: a column that costs its width and says
 * nothing. No caller writes it today, which is exactly why a comment saying "don't" would not
 * hold: the type is what still refuses it after everyone who read the comment has moved on.
 *
 * - a ranked table takes the partition (`rank` implies `partition` is on or omitted);
 * - an unranked table may decline it -- `/explore` is the one that does.
 *
 * `orderRows` enforces the same rule for a direct caller, which the type cannot reach. */
type DataTableProps = DataTableBaseProps &
  (
    | {
        /** A leading rank column -- `/watch`'s leaderboard shape (system.md, "`/watch`
         * leaderboard": "the standard table plus a leading rank column, mono, --ink-3"). It
         * numbers SCORED rows 1..k in render order; a below-floor row is excluded from ranking
         * and its cell reads `—`. */
        rank: true;
        partition?: true;
      }
    | {
        rank?: false;
        /** Below-floor rows sort last (docs/design/system.md, "The data table"). ON by default,
         * so a table surface added later inherits the rule rather than this exemption.
         *
         * `false` for `/explore` ALONE, and the reason is that page's contract rather than a
         * preference. The floor rule is a property of a RANKED table -- one whose order the
         * product chose. `/explore` renders the order its own query specifies: `s=` carries a
         * sort key AND a direction, and where it is absent the query still resolves to one
         * (`render.ts` falls back to the first selected measure), so either way the rows come
         * back in the order the permalink encodes. Re-ordering them afterwards would break the
         * promise that the page shows the query you wrote -- most visibly for
         * `s=departures_performed` ascending, which is someone explicitly asking to see the
         * sparsest rows first. See the call site in app/explore/page.tsx. */
        partition?: boolean;
      }
  );

export function DataTable(props: DataTableProps) {
  const { columns, rows, resolved } = props;
  const rank = props.rank ?? false;
  const partition = props.partition ?? true;
  const ordered = orderRows(rows, partition);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th className="gut" scope="col" />
            {rank && <th className="rank" scope="col" aria-label="Rank" />}
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
          {ordered.map(({ row, belowFloor, rank: position }, i) => {
            const reason = reasonFor(row);
            return (
              <tr key={i} data-below-floor={belowFloor ? "true" : undefined}>
                <ReasonCode
                  reason={reason}
                  detail={
                    typeof row.quarantine_reasons === "string" ? row.quarantine_reasons : null
                  }
                />
                {rank && (
                  <td className="rank" data-testid="rank-cell">
                    {/* `—` for a row excluded from ranking, never a number and never blank:
                        a blank cell reads as a rendering fault (system.md's own rule for the
                        measure columns), and any number here would be a rank the floor rule
                        says this row does not have. */}
                    {position ?? "\u2014"}
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={c.kind === "identifier" ? "id" : "num"}>
                    {c.dimKey ? (
                      <DimensionCell spec={c} row={row} resolved={resolved} />
                    ) : c.href ? (
                      <IdentifierCell spec={c} row={row} />
                    ) : (
                      format(c.kind, row[c.key])
                    )}
                  </td>
                ))}
                <td>
                  {/* `in`, not `num()`: the pivot templates emit only the measures a query
                      selected, and `num()` maps an ABSENT key and a queried NULL to the same
                      `null`. Here they are different findings; for `isBelowFloor` above they
                      are the SAME one, which is why that function collapses them on purpose and
                      this does not. `departures_performed` is itself a FILTERed SUM, so it
                      comes back NULL for a wholly-quarantined group -- and a row whose
                      departure count is absent and one whose count is unknowable both make no
                      claim about the floor, the single answer `num(...) !== null` gives. A
                      gauge has two answers to give: draw nothing, or draw the axis to say the
                      value cannot be stated. Same collapse, opposite correctness. */}
                  <GaugeRail
                    gauge={"avg_gauge" in row ? num(row.avg_gauge) : undefined}
                    muted={belowFloor}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
