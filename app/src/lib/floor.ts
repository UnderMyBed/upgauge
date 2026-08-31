/**
 * THE DEPARTURE FLOOR, DECLARED ONCE (#134).
 *
 * It used to be declared twice -- `lib/map/arcs.ts` and `components/DataTable.tsx` each held
 * their own `const DEPARTURE_FLOOR = 30` -- and the two DOCUMENTED DIFFERENT GRAINS: the map
 * called it a trailing-window count, the table applied it to whatever `departures_performed`
 * a row happened to carry, and `app/watch/[preset]/page.tsx` described a third understanding
 * again. Editing one moved none of the others. This module is the single declaration, and the
 * grain is stated here so there is one place to read it from.
 *
 * THE FLOOR IS MONTHLY: fewer than 30 departures in an average month the subject ACTUALLY
 * FLEW. That is what `docs/design/system.md` states and what the served copy says in words --
 * "under 30 departures a month flown", in the legend rail and in the `n` glyph's title -- and it
 * is what the four entity pages, the Explorer and both maps compare against.
 *
 * WHY THE DENOMINATOR IS "MONTHS FLOWN" AND NOT THE WINDOW LENGTH. Every surface that applies
 * the floor does so over a trailing-12 window, so the two obvious readings are both wrong:
 *
 *   - against the raw twelve-month SUM (what shipped): 30 departures spread over a year is
 *     2.5/month and cleared the floor, so the rule was ~12x too lenient and genuinely sparse
 *     rows read as scored. Measured on the 2026-05 warehouse, that was 141 of 1,180 rendered
 *     rows on /carrier's Top routes and 85 of 1,103 on Top origins that SHOULD have been
 *     marked and were not (see the commit message for the full before/after).
 *   - against a flat 360 (30 x 12): a route flown three months at 40 departures/month is a
 *     real, dense seasonal operation, and 120 < 360 would brand it sparse.
 *
 * Dividing by the months that flew answers both: it is the frequency the subject ran AT, over
 * exactly the period it was running. A single-month row (an /explore pivot grouped by
 * `year_month`) divides by 1 and so keeps the plain monthly reading unchanged.
 *
 * The denominator is `active_months`, a companion COUNT emitted by both pivot templates
 * (sql/03_queries/pivot_segment.sql, pivot_route.sql) beside `quarantined_rows` -- not a
 * catalog measure, so it is never selectable, sortable or rendered as a column.
 */

/** Departures per month FLOWN, below which a row is sparse. Never a window total. */
export const DEPARTURE_FLOOR = 30;

/**
 * `departures / activeMonths < DEPARTURE_FLOOR`, with absence making NO claim either way.
 *
 * ABSENCE IS NOT ZERO (lib/format.ts's opening rule). Three different absences reach here and
 * all three mean "this row says nothing about the floor":
 *
 *   - `departures === undefined` -- the query never selected `departures_performed`. The pivot
 *     templates emit only the measures a query asked for, so this is every /explore permalink
 *     that did not ask. Reading it as 0 marked 100% of those rows below floor.
 *   - `departures === null` -- it was selected and is UNKNOWABLE: each measure is
 *     `SUM(x) FILTER (WHERE NOT is_quarantined)`, so a wholly-quarantined group sums to NULL.
 *   - `activeMonths` absent -- the row did not come from a pivot at all. This is no longer how
 *     /watch behaves: since #148 `mart_route_health` carries `t12_months_flown`, the four
 *     presets alias it as `active_months`, and their floor mark is a real division rather than
 *     an abstention. It comes out false on every preset row because the mart's OWN admission
 *     gate is this rule (`t12_departures_performed >= 30 * t12_months_flown`), so a row below
 *     the floor is not in the table to be marked. The branch stays for any future producer that
 *     supplies a departure count without a month count.
 *
 * This returns `false` rather than throwing on the one shape that IS a producer bug -- a
 * departure count present with no month count beside it. A throw here would surface as a 500
 * from a page render, under whichever `Cache-Control` proxy.ts already committed (the cached-5xx
 * shape `lib/pivot/render.ts` documents for #87), and a missing row mark is not worth that. The
 * structural guard is `app/src/app/floorPartition.callsites.test.tsx`, which counts the real
 * below-floor rows every DataTable call site produces against the real warehouse and goes red if
 * a surface stops marking them.
 *
 * `activeMonths <= 0` is below floor, not a division by zero: the count only rises for a month
 * that PERFORMED departures, so zero of them means the group filed and never flew. That is the
 * sparsest a row can be, and it is also what the pre-#134 rule said about it (`0 < 30`), so the
 * never-flown row keeps its mark instead of silently losing it to the new denominator.
 */
export function belowFloor(
  departures: number | null | undefined,
  activeMonths: number | null | undefined,
): boolean {
  if (departures === null || departures === undefined) return false;
  if (activeMonths === null || activeMonths === undefined) return false;
  if (activeMonths <= 0) return true;
  return departures / activeMonths < DEPARTURE_FLOOR;
}
