export type Grain = "segment" | "route";
export type Grouping = "operating" | "mainline";

export const GRAINS: readonly Grain[] = ["segment", "route"];
export const GROUPINGS: readonly Grouping[] = ["operating", "mainline"];

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
