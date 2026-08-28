import { Chip, ChipRow } from "@/components/builder/Chips";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import {
  exploreHref,
  filterableDimensions,
  filterListHref,
  removeFilterValue,
} from "@/lib/pivot/builder";
import { displayValue, resolutionKey, type Resolved } from "@/lib/resolve";

/**
 * `f`, in two halves: what is filtered now (removable), and where to go to add one.
 *
 * THE DISPLAY VALUE IS RESOLVED, THE FILTER VALUE IS NOT. `f=op_airline_id:19790` filters on the
 * BTS id and must keep doing so -- `dim_carrier` carries the CURRENT carrier code (CLAUDE.md), so
 * a code-valued filter would silently change meaning across a rebuild. The reader sees "DL"; the
 * URL keeps 19790.
 *
 * THE REMOVAL HREF GOES THROUGH `removeFilterValue`, NEVER A SPREAD OF `query.filters`. Dropping a
 * filter's last value must drop the whole `f` chunk -- `f` with no values is a server rejection
 * (`filter 'x' has no values`) -- and that repair lives in the mutation helper, not here.
 *
 * The "add" half is a list of ROUTES, not of controls: choosing a value needs the warehouse, which
 * a chip row cannot reach, so each entry links to `/explore/filter/:dim` and that page runs the
 * one-dimension pivot. Every dimension the catalog will accept in an `f` is offered, `filter_only`
 * included -- `endpoint_airport_id` ("this airport at EITHER end") is filter-only precisely
 * because it cannot be GROUPED by, and omitting it from the FILTER vocabulary would hide the one
 * filter this product has that no other T-100 tool expresses.
 */
export function FilterChips({
  query,
  allowlist,
  resolved,
}: {
  query: PivotQuery;
  allowlist: Allowlist;
  resolved: Map<string, Resolved>;
}) {
  return (
    <>
      <ChipRow urlKey="f" label="Filters">
        {query.filters.length === 0 ? (
          <span className="chip chip-off">none</span>
        ) : (
          query.filters.flatMap(([key, values]) =>
            values.map((value) => (
              <Chip
                key={`${key}:${value}`}
                label={`${allowlist.dims.get(key)?.label ?? key} = ${displayValue(
                  resolved.get(resolutionKey(key, value)),
                  value,
                )} ✕`}
                href={exploreHref(removeFilterValue(query, key, value))}
              />
            )),
          )
        )}
      </ChipRow>
      {/* A wrapper around the shared `ChipRow`, not a second copy of its markup: the only thing
          this row needs that the primitive does not give it is a class to hang its own rule on. */}
      <div className="filter-list">
        <ChipRow urlKey="f" label="Add filter">
          {filterableDimensions(allowlist, query.grain).map((e) => (
            <Chip key={e.key} label={`${e.label} →`} href={filterListHref(query, e.key)} />
          ))}
        </ChipRow>
      </div>
    </>
  );
}
