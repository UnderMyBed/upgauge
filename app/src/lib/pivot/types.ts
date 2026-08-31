export type Grain = "segment" | "route";
export type Grouping = "operating" | "mainline";

export const GRAINS: readonly Grain[] = ["segment", "route"];
export const GROUPINGS: readonly Grouping[] = ["operating", "mainline"];

/** COLUMNS EVERY PIVOT EMITS THAT ARE NOT PIVOT VOCABULARY, and so must never become a table
 * column. The templates append them unconditionally, beside whatever measures the query asked
 * for (sql/03_queries/pivot_segment.sql, pivot_route.sql); the four pages that build a
 * `ColumnSpec[]` from a result's column list all filter through this set.
 *
 * ONE DECLARATION, and that is the point. This set was hand-copied into
 * app/explore/page.tsx, route/[pair]/page.tsx, carrier/[code]/page.tsx and
 * aircraft/[name]/page.tsx, each with a comment saying it matched the others -- so adding
 * `active_months` (#134) meant editing four files, and forgetting one rendered a bookkeeping
 * count as a visible IDENTIFIER column (`defaultKind` has no catalog entry to type it, so it
 * falls to "identifier" and lands left-aligned in the `td.id` slot). That is the same
 * duplicated-constant defect #134 exists to close, one layer over.
 *
 * NOT the same thing as a measure the query did not select: these are always present. A
 * consumer reading one by name (`DataTable`'s reason-code gutter reads `quarantined_rows`, its
 * floor mark reads `active_months`) is reading a real column; only the column LIST excludes
 * them. */
export const NON_DISPLAY_COLUMNS: ReadonlySet<string> = new Set([
  "quarantined_rows",
  "quarantine_reasons",
  "active_months",
]);

export class PivotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PivotError";
  }
}

export interface PivotQuery {
  grain: Grain;
  dimensions: string[];
  measures: string[];
  timeFrom: string;
  timeTo: string;
  filters: [string, string[]][];
  sort: string | null;
  sortDesc: boolean;
  limit: number;
  grouping: Grouping;
}

/** Mirrors PivotQuery.__post_init__ in pipeline/pivot.py.
 *
 * `sort === null` with `sortDesc === false` is unrepresentable in the URL format, so it is
 * normalized away at construction. Without this, encode() would not round-trip. */
export function normalizeQuery(q: PivotQuery): PivotQuery {
  return q.sort === null ? { ...q, sortDesc: true } : q;
}

/** Read a golden fixture's `query` object (snake_case) into a PivotQuery. */
export function queryFromJsonable(d: unknown): PivotQuery {
  const o = d as Record<string, unknown>;
  return normalizeQuery({
    grain: o.grain as Grain,
    dimensions: [...(o.dimensions as string[])],
    measures: [...(o.measures as string[])],
    timeFrom: o.time_from as string,
    timeTo: o.time_to as string,
    filters: (o.filters as [string, string[]][]).map(([k, v]) => [k, [...v]]),
    sort: (o.sort as string | null) ?? null,
    sortDesc: o.sort_desc as boolean,
    limit: o.limit as number,
    grouping: o.grouping as Grouping,
  });
}
