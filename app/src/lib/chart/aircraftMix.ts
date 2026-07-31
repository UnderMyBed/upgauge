import { runPivot } from "@/lib/db";
import { displayValue, resolutionKey } from "@/lib/resolve";
import type { PivotQuery } from "@/lib/pivot/types";

/** One (month, aircraft type) cell of the mix, with the type already resolved for display.
 *
 * `code` is the raw BTS AIRCRAFT_TYPE key -- a zero-padded VARCHAR ('079'), never a number
 * (CLAUDE.md: int-parsing it breaks the join silently). It stays on the row because it is the
 * identity the pivot, and any drill-down permalink, is keyed on. `label` is what a reader
 * sees ('A321/LR'), and the two must not be confused: '612' is the 737-700, not the A321.
 *
 * `departures` is here for one reason: the chart's shade ordering is by gauge
 * (seats / departures), which is a different ordering from band membership (total seats).
 * See toBands, and docs/superpowers/specs/2026-07-31-m4c-aircraft-mix-chart-design.md
 * § Encoding. */
export interface MixRow {
  month: string;
  code: string;
  label: string;
  seats: number;
  departures: number;
}

/** High enough that the chart is never silently truncated, and low enough to stay a bound.
 *
 * Measured against the built warehouse over the full 2015-01..2026-04 window: the worst-case
 * route produces 1,908 (month, type) groups, and the most aircraft types any one route
 * carries is 36 over 136 months (a 4,896-row absolute ceiling). JFK-LAX -- the flagship
 * example -- returns 996. 10,000 clears the measured worst case 5x and the structural ceiling
 * 2x. A truncated chart would not look broken, it would look like an airline stopped flying,
 * which is precisely the failure this headroom exists to avoid; aircraftMix.test.ts pins the
 * returned count strictly below this bound rather than trusting the arithmetic. */
const AIRCRAFT_MIX_LIMIT = 10000;

/** The pivot the chart is drawn from. No new SQL and no new catalog entries: the existing
 * segment-grain pivot answers this directly (the spec's § Data).
 *
 * `aircraft_type` is segment-grain only in meta_pivot_dimensions, so `grain` is not a choice.
 * `grouping: "operating"` because the operating carrier is the grain and the truth
 * (CLAUDE.md) -- rolling Endeavor into Delta would not change a single seat here, but it is
 * not the filing this chart describes.
 *
 * `sort: null` with `sortDesc: true` is the normalized form of "no explicit sort"
 * (normalizeQuery in lib/pivot/types.ts -- the other combination is unrepresentable in the
 * URL format). Order does not matter to this consumer: toBands re-sorts twice, by two
 * different keys, on purpose.
 *
 * Quarantined rows are already excluded by the measure expressions
 * (`SUM(seats) FILTER (WHERE NOT is_quarantined)`); this layer inherits that and must never
 * re-filter. */
export function aircraftMixQuery(
  filters: [string, string[]][],
  timeFrom: string,
  timeTo: string,
): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["year_month", "aircraft_type"],
    measures: ["seats", "departures_performed"],
    timeFrom,
    timeTo,
    filters,
    sort: null,
    sortDesc: true,
    limit: AIRCRAFT_MIX_LIMIT,
    grouping: "operating",
  };
}

export async function fetchAircraftMix(
  filters: [string, string[]][],
  timeFrom: string,
  timeTo: string,
): Promise<MixRow[]> {
  const result = await runPivot(aircraftMixQuery(filters, timeFrom, timeTo));
  return result.rows.map((r) => {
    const code = String(r.aircraft_type);
    return {
      month: String(r.year_month),
      code,
      // displayValue(), not `hit?.code ?? code`: the three-way display contract
      // (absent -> raw id, resolved-without-a-code -> the name, resolved -> the code) lives
      // in exactly one place, and re-deriving it locally is how the two copies drift --
      // lib/resolve.ts's own header records that having happened once already.
      label: displayValue(result.resolved.get(resolutionKey("aircraft_type", code)), code),
      seats: Number(r.seats ?? 0),
      departures: Number(r.departures_performed ?? 0),
    };
  });
}
