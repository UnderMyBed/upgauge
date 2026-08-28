import { Chip, ChipRow } from "@/components/builder/Chips";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import { exploreHref, isSortable, setSort } from "@/lib/pivot/builder";

function labelFor(key: string, a: Allowlist): string {
  return a.meas.get(key)?.label ?? a.dims.get(key)?.label ?? key;
}

export function SortControl({ query, allowlist }: { query: PivotQuery; allowlist: Allowlist }) {
  return (
    <ChipRow urlKey="s" label="Sort by">
      {[...query.dimensions, ...query.measures]
        .filter((key) => isSortable(key, query, allowlist))
        .map((key) => (
          <Chip
            key={key}
            label={
              query.sort === key
                ? `${labelFor(key, allowlist)} ${query.sortDesc ? "↓" : "↑"}`
                : labelFor(key, allowlist)
            }
            current={query.sort === key}
            href={exploreHref(setSort(query, key, allowlist))}
          />
        ))}
    </ChipRow>
  );
}
