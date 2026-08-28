import { Chip, ChipRow } from "@/components/builder/Chips";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import {
  exploreHref,
  filterableDimensions,
  filterListHref,
  removeFilterValue,
} from "@/lib/pivot/builder";
import { filterValueDisplay, type Resolved } from "@/lib/resolve";

/**
 * `f`, in two halves: what is filtered now (removable), and where to go to add one.
 *
 * THE LOOKUP IS KEYED ON THE FACT COLUMN, NOT ON THE DIMENSION KEY. `runPivot`'s `resolved` map
 * is built as `resolutionKey(column, id)` (lib/resolve.ts), so keying it on `key` here misses for
 * `route` (two columns), for `endpoint_airport_id` (two columns) and for anything whose key ever
 * stops equalling its column -- and `displayValue` then falls back to the raw BTS id, rendering
 * `Route = 12478-12892` on a real page while a hand-keyed test fixture showed `PDX-SEA`.
 * `filterValueDisplay` owns the three catalog shapes; this component does not re-derive them.
 *
 * WHAT `resolved` MUST CARRY, and this is a PRECONDITION ON THE CALLER, not something this
 * component can satisfy. `runPivot` resolves only the ids present in the rows it returned, so a
 * query that FILTERS on a dimension without GROUPING by it resolves nothing for it -- measured:
 * `d=year_month&f=op_airline_id:19790` comes back with `resolved.size === 0`, and this chip then
 * renders `Carrier = 19790`. Keying the lookup correctly (below) does not reach that case and
 * nothing inside a synchronous component can: the fix is for the page mounting this to resolve
 * its filter values too -- build one synthetic row per filter value and hand it to
 * `resolveRows(rows, allowlist)` (lib/resolve.ts:414), then merge into the pivot's own map. Until
 * it does, an unresolved filter degrades to its raw BTS id, which is the honest fallback
 * (`displayValue`'s contract: absence of a NAME is not absence of DATA) and is pinned by a test
 * below rather than left to be discovered.
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
/** A filter naming a dimension the catalog does not carry cannot be resolved and cannot be
 *  shaped -- it renders as its raw value under the same rules a one-column dimension gets. This
 *  is unreachable through `decodeRequest` (which validates every `f` key against the catalog) and
 *  is here so an unknown key degrades to the honest raw string instead of throwing on a render
 *  path. */
const UNKNOWN_DIMENSION = {
  key: "",
  label: "",
  columnExpr: "",
  grain: "both",
  joinDim: null,
  joinKey: null,
  filterOnly: false,
  filterMode: null,
  valueType: "VARCHAR",
} as const;

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
                label={`${allowlist.dims.get(key)?.label ?? key} = ${filterValueDisplay(
                  allowlist.dims.get(key) ?? UNKNOWN_DIMENSION,
                  value,
                  resolved,
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
