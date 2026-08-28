import { Chip, ChipRow } from "@/components/builder/Chips";
import { EARLIEST_MONTH } from "@/lib/entityFacts";
import { exploreHref, setWindow } from "@/lib/pivot/builder";
import type { PivotQuery } from "@/lib/pivot/types";
import { yearTrack } from "@/lib/year";

/** Step back `months - 1` from `asOf`, so a trailing-12 ending 2026-04 starts 2025-05. */
function monthsBefore(asOf: string, months: number): string {
  const [y, m] = asOf.split("-").map(Number);
  const zero = y * 12 + (m - 1) - (months - 1);
  return `${String(Math.floor(zero / 12)).padStart(4, "0")}-${String((zero % 12) + 1).padStart(2, "0")}`;
}

/**
 * `t`. Presets plus a year track -- an arbitrary month pair stays hand-editable, which
 * system.md says this audience does.
 *
 * ASOF, NEVER `new Date()`. The dataset's newest month is the ceiling, and a control computing
 * its own "last 12 months" from the wall clock would emit a window past the data the day BTS is
 * late -- `checkBounds` would refuse it and the chip would be a dead link. Same relationship
 * `lib/year.ts` already has with `/airport`'s `y`.
 */
export function WindowControl({ query, asOf }: { query: PivotQuery; asOf: string }) {
  const presets: [string, string, string][] = [
    ["Trailing 12", monthsBefore(asOf, 12), asOf],
    ["Trailing 24", monthsBefore(asOf, 24), asOf],
    ["Full window", EARLIEST_MONTH, asOf],
  ];
  const isPreset = (from: string, to: string) => query.timeFrom === from && query.timeTo === to;
  // Whenever `asOf`'s month is December, Trailing 12's window IS the asOf year's own calendar
  // window -- both predicates fire on their own chip, and two `aria-current="page"` chips in one
  // control tells a screen reader two different things are the current view. The rows are made
  // mutually exclusive, preset wins: the presets are the coarser, more prominent control and the
  // year track only refines them, so "Trailing 12" is the more informative statement of what the
  // query is. Not reachable with today's `asOf` (2026-04), which is exactly why this needs its
  // own December-fixture test rather than trusting the trailing-12/current-year test above.
  const anyPresetCurrent = presets.some(([, from, to]) => isPreset(from, to));

  return (
    <>
      <ChipRow urlKey="t" label="Window">
        {presets.map(([label, from, to]) => (
          <Chip
            key={label}
            label={label}
            current={isPreset(from, to)}
            href={exploreHref(setWindow(query, from, to, asOf))}
          />
        ))}
      </ChipRow>
      <ChipRow urlKey="t" label="Year">
        {yearTrack(asOf).map(({ year, partial }) => {
          // setWindow clamps `${year}-12` down to asOf, so the partial year needs no special
          // case in the href -- only in the LABEL. Presenting a four-month year identically to
          // a twelve-month one is the same false claim `yearTrack`'s own docstring names.
          const from = `${year}-01`;
          const to = `${year}-12`;
          const clamped = setWindow(query, from, to, asOf);
          return (
            <Chip
              key={year}
              label={partial ? `${year}*` : String(year)}
              current={
                !anyPresetCurrent && query.timeFrom === clamped.timeFrom && query.timeTo === clamped.timeTo
              }
              href={exploreHref(clamped)}
            />
          );
        })}
      </ChipRow>
    </>
  );
}
