import { encode } from "@/lib/pivot/urlstate";
import { normalizeQuery } from "@/lib/pivot/types";
import type { Grain, Grouping, PivotQuery } from "@/lib/pivot/types";

/** "Top N <dimension> by <measure> in <period>."
 *
 * This adds NO SQL and NO catalog entries -- the same property M4c's chart has. A Top-N view
 * IS an existing pivot: one dimension, sorted descending on a measure, limited. What did not
 * exist was one place deriving both the query and its Explorer permalink from a single spec,
 * so a page could not accidentally link to a query that differs from the table above it.
 *
 * NOT the mechanism behind /watch. features.md and system.md both claimed the presets are
 * "saved instances of the Top-N builder, so their links are ordinary permalinks" -- they are
 * not and cannot be: every measure in meta_pivot_measures is a single-window aggregate, and
 * the presets need deltas. The presets read mart_route_health and share only DataTable's rank
 * column. Both documents were corrected alongside this file. */
export interface TopNSpec {
  grain: Grain;
  /** A catalog dimension key. */
  dimension: string;
  /** `measures[0]` is the one ranked on. */
  measures: string[];
  timeFrom: string;
  timeTo: string;
  filters?: [string, string[]][];
  limit: number;
  grouping?: Grouping;
}

export function topNQuery(spec: TopNSpec): PivotQuery {
  return normalizeQuery({
    grain: spec.grain,
    dimensions: [spec.dimension],
    measures: [...spec.measures],
    timeFrom: spec.timeFrom,
    timeTo: spec.timeTo,
    filters: spec.filters ? spec.filters.map(([k, v]) => [k, [...v]]) : [],
    sort: spec.measures[0],
    sortDesc: true,
    limit: spec.limit,
    grouping: spec.grouping ?? "operating",
  });
}

/** The Explorer permalink for the identical query, so the link under a Top-N table can never
 * drift from the table itself. */
export function topNPermalink(spec: TopNSpec): string {
  return `/explore?${encode(topNQuery(spec))}`;
}
