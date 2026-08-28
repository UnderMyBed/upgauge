import { Chip, ChipRow } from "@/components/builder/Chips";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import { exploreHref, groupableDimensions, toggleDimension } from "@/lib/pivot/builder";

/**
 * `d`, the ordered multi-select. Adding APPENDS -- the order is what the table's column order
 * and its GROUP BY follow, so a set-shaped implementation would silently re-order the reader's
 * result. There is no reorder control in v1 (spec D5); hand-editing remains the escape hatch.
 *
 * The vocabulary is `groupableDimensions`, which excludes `filter_only`. `endpoint_airport_id`
 * is the one row that carries it, and grouping by it double-counts every row in the table.
 */
export function DimensionChips({ query, allowlist }: { query: PivotQuery; allowlist: Allowlist }) {
  const groupable = groupableDimensions(allowlist, query.grain);
  const groupableKeys = new Set(groupable.map((e) => e.key));

  return (
    <ChipRow urlKey="d" label="Group by">
      {[...allowlist.dims.values()]
        .filter((e) => !e.filterOnly)
        .map((e) => {
          const selected = query.dimensions.includes(e.key);
          if (!groupableKeys.has(e.key)) {
            return (
              <Chip key={e.key} href={null} label={e.label} reason={`not filed at ${query.grain} grain`} />
            );
          }
          if (selected && query.dimensions.length === 1) {
            return (
              <Chip key={e.key} href={null} label={e.label} reason="at least one dimension is required" />
            );
          }
          return (
            <Chip
              key={e.key}
              label={e.label}
              current={selected}
              href={exploreHref(toggleDimension(query, e.key, allowlist))}
            />
          );
        })}
    </ChipRow>
  );
}
