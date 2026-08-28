import { DimensionChips } from "@/components/builder/DimensionChips";
import { FilterChips } from "@/components/builder/FilterChips";
import { GrainControl } from "@/components/builder/GrainControl";
import { LimitControl } from "@/components/builder/LimitControl";
import { MeasureChips } from "@/components/builder/MeasureChips";
import { SortControl } from "@/components/builder/SortControl";
import { WindowControl } from "@/components/builder/WindowControl";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import type { Resolved } from "@/lib/resolve";

/**
 * The `.builder` block: every control, in URL-key order (`k` `g` `d` `m` `t` `f` `s` `n`), so a
 * reader learns the permalink format from the interface (docs/design/system.md § The Explorer).
 *
 * PURE COMPOSITION AND DELIBERATELY SYNCHRONOUS. Nothing here queries, decides or repairs -- each
 * control owns its own vocabulary and its own refusals, and every href it emits is built through
 * `lib/pivot/builder.ts`'s mutation helpers rather than by spreading the query, so the repair
 * travels with the link. A control added here is a row added to the block, not a branch.
 *
 * `resolved` IS A PRECONDITION ON THE CALLER, and it is the one thing this component cannot fix
 * for itself. `FilterChips` renders a filter's display value out of this map, and `runPivot`'s own
 * `resolved` carries ONLY the ids present in the rows it returned -- so a query that FILTERS on a
 * dimension it does not GROUP by (`d=year_month&f=op_airline_id:19790`) arrives with
 * `resolved.size === 0` and the chip degrades to `Carrier = 19790`. The mount must therefore
 * resolve its own filter values (`resolveFilterValues`, lib/resolve.ts) and merge them in;
 * `/explore`'s does. See `FilterChips`'s own docstring for the measurement.
 */
export function ExplorerBuilder({
  query,
  allowlist,
  asOf,
  resolved,
}: {
  query: PivotQuery;
  allowlist: Allowlist;
  asOf: string;
  resolved: Map<string, Resolved>;
}) {
  return (
    <div className="builder">
      <GrainControl query={query} allowlist={allowlist} />
      <DimensionChips query={query} allowlist={allowlist} />
      <MeasureChips query={query} allowlist={allowlist} />
      <WindowControl query={query} asOf={asOf} />
      <FilterChips query={query} allowlist={allowlist} resolved={resolved} />
      <SortControl query={query} allowlist={allowlist} />
      <LimitControl query={query} />
    </div>
  );
}
