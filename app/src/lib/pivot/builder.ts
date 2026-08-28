import { EARLIEST_MONTH } from "@/lib/entityFacts";
import type { Allowlist, DimensionEntry } from "@/lib/pivot/allowlist";
import { MAX_LIMIT } from "@/lib/pivot/bounds";
import { normalizeQuery, type Grain, type Grouping, type PivotQuery } from "@/lib/pivot/types";
import { encode } from "@/lib/pivot/urlstate";

/** The permalink for a query. Four page files each kept a private copy of this one line
 *  before Task 1; the builder is the natural owner because it is the thing that emits hrefs. */
export function exploreHref(q: PivotQuery): string {
  return `/explore?${encode(q)}`;
}

/** A dimension is usable at `grain` when the catalog says 'both' or names that grain. */
function atGrain(e: DimensionEntry, grain: string): boolean {
  return e.grain === "both" || e.grain === grain;
}

/** GROUPING vocabulary: `filter_only` is excluded. `endpoint_airport_id` means "this airport at
 *  EITHER end", so grouping by it puts ORD->LAX in both the ORD and the LAX group and summing
 *  double-counts every row -- structurally T-100's CLASS rollup problem. */
export function groupableDimensions(a: Allowlist, grain: string): DimensionEntry[] {
  return [...a.dims.values()].filter((e) => atGrain(e, grain) && !e.filterOnly);
}

/** FILTER vocabulary: `filter_only` is INCLUDED. The two lists differ by exactly that flag, and
 *  keeping them as one list with a boolean argument is how they drift. */
export function filterableDimensions(a: Allowlist, grain: string): DimensionEntry[] {
  return [...a.dims.values()].filter((e) => atGrain(e, grain));
}

/** Re-point `s` when the column it names is no longer selected. `null` is legal (render.ts
 *  substitutes `q.sort ?? q.measures[0]`), so clearing is always a valid repair -- but preferring
 *  the first remaining measure keeps the visible order stable across an unrelated toggle. */
function repairSort(q: PivotQuery): PivotQuery {
  if (q.sort === null) return q;
  if (q.dimensions.includes(q.sort) || q.measures.includes(q.sort)) return q;
  return normalizeQuery({ ...q, sort: q.measures[0] ?? null });
}

export function setGrain(q: PivotQuery, grain: Grain, a: Allowlist): PivotQuery {
  const keeps = (k: string) => {
    const e = a.dims.get(k);
    return e === undefined || atGrain(e, grain);
  };
  const dimensions = q.dimensions.filter((k) => keeps(k) && !a.dims.get(k)?.filterOnly);
  return repairSort(
    normalizeQuery({
      ...q,
      grain,
      // Never emit an empty `d` -- the server rejects it. Falling back to the first groupable
      // dimension at the NEW grain is the only choice that is always available.
      dimensions: dimensions.length > 0 ? dimensions : [groupableDimensions(a, grain)[0].key],
      filters: q.filters.filter(([k]) => keeps(k)),
    }),
  );
}

export function setGrouping(q: PivotQuery, grouping: Grouping): PivotQuery {
  return normalizeQuery({ ...q, grouping });
}

export function toggleDimension(q: PivotQuery, key: string, a: Allowlist): PivotQuery {
  const e = a.dims.get(key);
  // Unknown, wrong-grain and filter_only are all refusals, and a refusal is a no-op rather than
  // a throw: nothing on a render path may throw, and the component is what states the reason.
  if (e === undefined || !atGrain(e, q.grain) || e.filterOnly) return q;
  const on = q.dimensions.includes(key);
  if (on && q.dimensions.length === 1) return q;
  return repairSort(
    normalizeQuery({
      ...q,
      dimensions: on ? q.dimensions.filter((k) => k !== key) : [...q.dimensions, key],
    }),
  );
}

export function toggleMeasure(q: PivotQuery, key: string): PivotQuery {
  const on = q.measures.includes(key);
  if (on && q.measures.length === 1) return q;
  return repairSort(
    normalizeQuery({
      ...q,
      measures: on ? q.measures.filter((k) => k !== key) : [...q.measures, key],
    }),
  );
}

/** A composite dimension is NOT sortable. `render.ts:286` builds its `sortable` map with
 *  `if (dimensionColumns(...).length === 1)`, so `route` -- (route_key_low, route_key_high) --
 *  throws `unknown sort key 'route'`. Guarding on membership alone emits that dead link. */
export function isSortable(key: string, q: PivotQuery, a: Allowlist): boolean {
  if (q.measures.includes(key)) return true;
  if (!q.dimensions.includes(key)) return false;
  return (a.dims.get(key)?.columnExpr.split(",").length ?? 0) === 1;
}

export function setSort(q: PivotQuery, key: string, a: Allowlist): PivotQuery {
  if (!isSortable(key, q, a)) return q;
  return normalizeQuery(
    q.sort === key ? { ...q, sortDesc: !q.sortDesc } : { ...q, sort: key, sortDesc: true },
  );
}

export function setLimit(q: PivotQuery, n: number): PivotQuery {
  if (!Number.isInteger(n)) return q;
  return normalizeQuery({ ...q, limit: Math.min(Math.max(n, 1), MAX_LIMIT) });
}

/** `asOf` is the dataset's newest month, so the ceiling is discovered rather than declared --
 *  the same relationship `lib/year.ts` has with `/airport`'s `y`. A reversed pair is corrected,
 *  not refused: a control that produced `from > to` would otherwise emit a dead link. */
export function setWindow(q: PivotQuery, from: string, to: string, asOf: string): PivotQuery {
  const clamp = (m: string) => (m < EARLIEST_MONTH ? EARLIEST_MONTH : m > asOf ? asOf : m);
  const lo = clamp(from);
  const hi = clamp(to);
  return normalizeQuery({
    ...q,
    timeFrom: lo <= hi ? lo : hi,
    timeTo: lo <= hi ? hi : lo,
  });
}

export function addFilter(q: PivotQuery, key: string, value: string): PivotQuery {
  const existing = q.filters.find(([k]) => k === key);
  if (existing !== undefined && existing[1].includes(value)) return q;
  const filters: [string, string[]][] = existing
    ? q.filters.map(([k, vs]): [string, string[]] => (k === key ? [k, [...vs, value]] : [k, vs]))
    : [...q.filters, [key, [value]]];
  return normalizeQuery({ ...q, filters });
}

/** Dropping a filter's LAST value drops the whole filter -- `f` with no values is a server
 *  rejection (`filter 'x' has no values`), not an empty filter. */
export function removeFilterValue(q: PivotQuery, key: string, value: string): PivotQuery {
  const filters = q.filters
    .map(([k, vs]): [string, string[]] => (k === key ? [k, vs.filter((v) => v !== value)] : [k, vs]))
    .filter(([, vs]) => vs.length > 0);
  return normalizeQuery({ ...q, filters });
}
