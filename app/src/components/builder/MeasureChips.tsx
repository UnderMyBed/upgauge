import { Chip, ChipRow } from "@/components/builder/Chips";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import { exploreHref, toggleMeasure } from "@/lib/pivot/builder";

/** `m`. Every measure is valid at every grain, so the only refusal here is the last one --
 *  `m=` empty is a server rejection. Derived measures render dashed (system.md), read from the
 *  catalog's own `isAdditive` flag rather than a second hand-copied list of measure keys. */
export function MeasureChips({ query, allowlist }: { query: PivotQuery; allowlist: Allowlist }) {
  return (
    <ChipRow urlKey="m" label="Measures">
      {[...allowlist.meas.values()].map((e) => {
        const selected = query.measures.includes(e.key);
        const last = selected && query.measures.length === 1;
        return (
          <Chip
            key={e.key}
            label={e.label}
            derived={!e.isAdditive}
            current={selected}
            href={last ? null : exploreHref(toggleMeasure(query, e.key))}
            reason={last ? "at least one measure is required" : undefined}
          />
        );
      })}
    </ChipRow>
  );
}
