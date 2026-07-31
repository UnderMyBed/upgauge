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

/** The six-token monochrome ramp from app/src/app/globals.css, in ramp order. `--g0` is
 * reserved for Other and is not assignable to a type band, which is why it is not in this
 * list -- docs/design/system.md § Charts owns the values. */
export const BAND_TOKENS = ["--g1", "--g2", "--g3", "--g4", "--g5"] as const;
export type BandToken = (typeof BAND_TOKENS)[number];

/** The token the Other bucket always carries: lightest, and outside the gauge ordering
 * entirely -- Other is a mixture of metal sizes, so it has no gauge to be ordered by. */
export const OTHER_TOKEN = "--g0";

export interface SeriesPoint {
  month: string;
  seats: number;
}

export interface Band {
  code: string;
  label: string;
  token: BandToken;
  series: SeriesPoint[];
}

export interface OtherSummary {
  /** How many aircraft types this bucket aggregates. Zero means there is no Other band to
   * draw, and `series` is empty rather than a row of zeroes. */
  typeCount: number;
  /** Share of the route's TOTAL seats, not of the remainder. The legend rail states this out
   * loud because Other is often not a rounding error: top-5 + Other covers a median 94.7% of
   * seats on multi-type routes, but 1,571 of 4,618 fall below 90% and the worst is 48.2%
   * (measured -- the spec's § "The Other band is not a rounding error"). */
  seatShare: number;
  series: SeriesPoint[];
}

/** Total seats and total departures per aircraft type, plus its label. */
interface TypeTotal {
  code: string;
  label: string;
  seats: number;
  departures: number;
}

/** Seats per departure over the whole window, or `null` when nothing was flown.
 *
 * `null`, not 0 and not NaN, and the distinction is load-bearing. A type with no performed
 * departures has an UNKNOWN gauge, not a small one -- aircraft type 650 (DC-9-50) appears on
 * JFK-LAX with 0 seats and 0 departures, so the naive `seats / departures` is 0/0 = NaN, and
 * a NaN comparator result makes Array.prototype.sort's order implementation-defined. Treating
 * it as 0 instead would be worse than undefined behaviour: it would make an aircraft that flew
 * nothing the LIGHTEST band on the chart, which is a claim about metal size drawn from no
 * evidence. Unknown sorts last, matching DuckDB's own NULLS LAST default for `ORDER BY ASC`. */
function gauge(t: TypeTotal): number | null {
  return t.departures === 0 ? null : t.seats / t.departures;
}

/** Ascending, nulls last. */
function byGaugeAscNullsLast(a: TypeTotal, b: TypeTotal): number {
  const ga = gauge(a);
  const gb = gauge(b);
  if (ga === null && gb === null) return a.code.localeCompare(b.code);
  if (ga === null) return 1;
  if (gb === null) return -1;
  // Ties are real (four types at an identical gauge is unlikely; two is not), and an
  // unbroken tie leaves the token assignment at the mercy of input order. `code` is the only
  // stable identity available here -- an arbitrary but deterministic tiebreak, which is the
  // property that matters: the same data must always produce the same chart.
  return ga - gb || a.code.localeCompare(b.code);
}

/** Descending, with the same deterministic tiebreak. */
function bySeatsDesc(a: TypeTotal, b: TypeTotal): number {
  return b.seats - a.seats || a.code.localeCompare(b.code);
}

/** Fold the flat (month, type) rows into stacked-area bands.
 *
 * TWO ORDERINGS, and they are not the same one applied twice. This is the single most
 * important detail in M4c (the spec's § Encoding) and the easiest to collapse by accident:
 *
 *   - MEMBERSHIP -- which five types get their own band -- is by TOTAL SEATS, descending.
 *     Everything else is aggregated into Other.
 *   - SHADE -- which of `--g1`..`--g5` a band gets -- is by GAUGE, ascending, so the lightest
 *     band is the smallest metal and an upgauge darkens the stack.
 *
 * On JFK-LAX the A321/LR is first by seats AND the lightest by gauge, so it alone cannot tell
 * a correct implementation from a single-sort one; positions 2-5 disagree completely (seats:
 * B767-3/R, B767-4, B757-2, A320-1/2 -- gauge: A320-1/2, B757-2, B767-3/R, B767-4). A chart
 * built from one sort looks entirely plausible and encodes nothing.
 *
 * Returned in SHADE order, `--g1` first. That makes the array directly usable as the stack
 * order: light at the bottom, dark on top, so the ramp reads as a gradient rather than as
 * six unrelated greys, which is the whole reason the categories are ordered at all.
 *
 * Every band carries a point for EVERY month in the input, zero-filled where a type did not
 * fly. A stacked area with gaps misaligns rather than showing a hole. */
export function toBands(rows: MixRow[]): { bands: Band[]; other: OtherSummary } {
  const months = [...new Set(rows.map((r) => r.month))].sort();

  const totals = new Map<string, TypeTotal>();
  for (const r of rows) {
    const t = totals.get(r.code) ?? { code: r.code, label: r.label, seats: 0, departures: 0 };
    t.seats += r.seats;
    t.departures += r.departures;
    totals.set(r.code, t);
  }

  const members = [...totals.values()].sort(bySeatsDesc).slice(0, BAND_TOKENS.length);
  const memberCodes = new Set(members.map((t) => t.code));

  // A SECOND sort, of the same five, on a different key. Not `.reverse()`, not a re-slice of
  // the first sort -- see this function's header.
  const shaded = [...members].sort(byGaugeAscNullsLast);

  // month -> code -> seats, so a band's series is a lookup per month rather than a scan.
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? new Map<string, number>();
    m.set(r.code, (m.get(r.code) ?? 0) + r.seats);
    byMonth.set(r.month, m);
  }

  const bands: Band[] = shaded.map((t, i) => ({
    code: t.code,
    label: t.label,
    token: BAND_TOKENS[i],
    series: months.map((month) => ({ month, seats: byMonth.get(month)?.get(t.code) ?? 0 })),
  }));

  const otherTypes = [...totals.values()].filter((t) => !memberCodes.has(t.code));
  const totalSeats = [...totals.values()].reduce((a, t) => a + t.seats, 0);
  const otherSeats = otherTypes.reduce((a, t) => a + t.seats, 0);

  const other: OtherSummary = {
    typeCount: otherTypes.length,
    // Guarded, not because a route with zero seats is expected, but because the alternative
    // is rendering NaN% in the legend rail under a DATA AS OF badge.
    seatShare: totalSeats === 0 ? 0 : otherSeats / totalSeats,
    // Empty, not zero-filled, when there is nothing to aggregate: the renderer gates on
    // `typeCount > 0`, and an all-zero series would otherwise put an invisible band and a
    // "0 other types" legend entry on every chart of a five-type route.
    series:
      otherTypes.length === 0
        ? []
        : months.map((month) => {
            const m = byMonth.get(month);
            return {
              month,
              seats: otherTypes.reduce((a, t) => a + (m?.get(t.code) ?? 0), 0),
            };
          }),
  };

  return { bands, other };
}
