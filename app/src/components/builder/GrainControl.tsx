import { Chip, ChipRow } from "@/components/builder/Chips";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";
import { exploreHref, setGrain, setGrouping } from "@/lib/pivot/builder";

const GRAINS = [
  ["segment", "Segment"],
  ["route", "Route"],
] as const;
const GROUPINGS = [
  ["operating", "Operating"],
  ["mainline", "Mainline"],
] as const;

export function GrainControl({ query, allowlist }: { query: PivotQuery; allowlist: Allowlist }) {
  return (
    <>
      <ChipRow urlKey="k" label="Grain">
        {GRAINS.map(([value, label]) => (
          <Chip
            key={value}
            label={label}
            current={query.grain === value}
            // The href is built through setGrain, so the repair travels with the link. Building
            // it as `{...query, grain: value}` here would emit a dimension list the new grain
            // rejects -- the defect the round-trip property names.
            href={exploreHref(setGrain(query, value, allowlist))}
          />
        ))}
      </ChipRow>
      <ChipRow urlKey="g" label="Carrier rollup">
        {GROUPINGS.map(([value, label]) => (
          <Chip
            key={value}
            label={label}
            current={query.grouping === value}
            href={exploreHref(setGrouping(query, value))}
          />
        ))}
      </ChipRow>
    </>
  );
}
