import { ratio, sumColumn } from "@/lib/nullSum";
import type { AirportRef } from "@/lib/resolve";
import type { PivotQuery } from "@/lib/pivot/types";

/** WHAT THE FOUR ENTITY PAGES' NUMBERS ARE -- the one definition, shared by each page and by
 * its `opengraph-image` route.
 *
 * A social card is a data view under a `DATA AS OF` badge, so a card that disagrees with the
 * page it previews is the same class of false claim as a stale badge. The only structural way
 * to make that disagreement impossible is for the two to compute the totals ONCE: the window,
 * the row limit that bounds it, and the ratio-of-sums arithmetic all live here, and both
 * callers import them. A second copy of "what the totals are" is what this module exists to
 * refuse -- the four pages had four copies of `trailing12From` and three of the totals
 * function before the cards needed a fifth.
 *
 * `/airport` is the exception, and deliberately: its figures are an either-endpoint query that
 * TypeScript folds per row, so its shared definition is `app/airport/[code]/endpoints.ts` and
 * its card imports `airportTotals`/`fetchAirportTraffic` from there. It still takes the window
 * from here, because the window is the same trailing 12 on every one of the four. */

// data/raw/ holds the full 2015-2026 window (CLAUDE.md's Status section) -- the widest window
// any query against this database can have. The mix chart on every entity page is fetched over
// it, and so is every card's chart.
export const EARLIEST_MONTH = "2015-01";

/** Measured: the busiest route carries 16 distinct operating carriers over a trailing 12
 * months, 99th percentile 8. 50 leaves generous headroom so the totals always cover every
 * carrier. If a future refresh exceeds it the page says so rather than under-reporting -- see
 * `truncated` in route/[pair]/page.tsx. */
export const ROUTE_CARRIER_LIMIT = 50;

/** Measured: the busiest carrier operates 18 distinct aircraft types over a trailing 12 months
 * and 23 all-time. 100 clears both by 4x. */
export const CARRIER_TYPE_LIMIT = 100;

/** Measured: the most operating carriers any one aircraft type carries is 25 (BTS type 416)
 * over the full window, 7 for the 737-800 the /aircraft tests use. 50 leaves generous
 * headroom. */
export const AIRCRAFT_CARRIER_LIMIT = 50;

/** The trailing-12-month window every entity page and card shows, computed from `asOf` the
 * same way mart_route_health's own t12 window is (sql/02_marts/200_mart_route_health.sql:
 * `end_m - INTERVAL 11 MONTH`) -- 11 months back from asOf, inclusive of asOf, is 12 months. */
export function trailing12From(asOf: string): string {
  const [y, m] = asOf.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 11, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface EntityTotals {
  /** `number | null`, because a total over rows whose every filing was quarantined is
   * unknowable rather than zero (docs/data/invariants.md, "A wholly-quarantined group sums to
   * NULL"), and so is a total over no rows at all. Both `sumTotals` below and `/airport`'s
   * `airportTotals` (app/airport/[code]/endpoints.ts) produce that null, and every consumer --
   * the four stat strips, `cardStats`, `cardSixthStat` -- reads it through this type. */
  seats: number | null;
  passengers: number | null;
  departures: number | null;
  loadFactor: number | null;
  avgGauge: number | null;
}

/** Ratios of sums, never averages of the rows above -- CLAUDE.md's hard rule, and the #1 bug in
 * every homemade T-100 tool.
 *
 * Measured for Delta over 2025-06..2026-05: the correct load factor is 82.87% and the mean of
 * the 17 per-type load factors is 83.33%; the correct gauge is 163.6 and the mean of the rows
 * is 194.7. Both wrong answers look entirely plausible on screen, which is why
 * carrier/[code]/page.test.tsx asserts the right figures AND the absence of these two. On
 * /aircraft the temptation is sharper still: an aircraft type HAS a nominal seat count, so
 * averaging the carriers' gauges looks like it would recover it. It would not -- it would
 * weight Sun Country's 186-seat 737-800 equally with Southwest's 175-seat one regardless of how
 * many either flew.
 *
 * `null`, never 0.0 and never a fabricated 0, whenever a figure cannot be stated -- an
 * unknowable sum, an unknowable ratio input, or a zero denominator. Absence is not a
 * measurement (lib/format.ts's opening rule; lib/nullSum.ts is its arithmetic half). */
export function sumTotals(rows: Record<string, unknown>[]): EntityTotals {
  // SUM() SEMANTICS, through `lib/nullSum.ts` -- the same three functions `/airport` folds with,
  // never a second implementation of the same rule. Each measure is
  // `SUM(x) FILTER (WHERE NOT is_quarantined)`, so a group whose every filing was quarantined
  // arrives NULL, and this used to restate that as zero TWICE OVER: `?? 0` in the mapper, and a
  // `+` fold that would have coerced it anyway. Deleting one and not the other is not a fix.
  //
  // Measured over the trailing 12 (2026-05 warehouse), and the page count is the one that
  // matters: 11 route pairs have no un-quarantined filing at all, of which 10 are REACHABLE
  // pages -- the eleventh is VEE-VEE, which `lib/routePair.ts` 404s as a same-airport slug
  // before any lookup. Two aircraft types are in the same state (BTS 201 `/aircraft/TRISLNDR`
  // and 489 `/aircraft/SHORT360`, both F4 in 2025-08 with 5 and 27 PERFORMED departures against
  // a filed seat count of 0), which issue #121 did not measure and which is why the footprint
  // is 12 pages and not 10. No carrier is in that state in this window.
  const seats = sumColumn(rows, "seats");
  const passengers = sumColumn(rows, "passengers");
  const departures = sumColumn(rows, "departures_performed");
  return {
    seats,
    passengers,
    departures,
    // `ratio`, never `x === 0 ? null : a / b`: typed to `number`, that form reads `null === 0`
    // as false and evaluates `null / null`, which is NaN -- and `formatGauge(NaN)` is not the
    // em dash, it is the literal string "NaN" under a DATA AS OF badge. Measured on /airport
    // during #118.
    loadFactor: ratio(passengers, seats),
    avgGauge: ratio(seats, departures),
  };
}

/** The trailing-12 pivot behind an entity page's table and stat strip, and behind its card's
 * stat row. Only the dimension and the filter differ between /route, /carrier and /aircraft --
 * the measures, the sort, the window and the grouping are the same query three times, so they
 * are written once here.
 *
 * `grouping: "operating"` is not a default falling through: the operating carrier is the grain
 * and the truth (CLAUDE.md). A Delta-branded regional flown by Endeavor files as 9E, and every
 * one of these pages reports what was operated. */
export function trailing12Query({
  dimensions,
  filters,
  asOf,
  limit,
}: {
  dimensions: string[];
  filters: [string, string[]][];
  asOf: string;
  limit: number;
}): PivotQuery {
  return {
    grain: "segment",
    dimensions,
    measures: ["seats", "passengers", "departures_performed", "load_factor", "avg_gauge"],
    timeFrom: trailing12From(asOf),
    timeTo: asOf,
    filters,
    sort: "seats",
    sortDesc: true,
    limit,
    grouping: "operating",
  };
}

/** The route's subject line, en-dashed. Shared by the page's entity header, the page's chart
 * subtitle and the card's title, so the three can never name the pair differently. */
export function routeTitle(canonical: string): string {
  return canonical.replace("-", "–");
}

/** The pair's two airports in the order the CANONICAL SLUG spells them, which is alphabetical
 * by code and is NOT the order `low`/`high` arrive in (that one is by airport id). The two
 * disagree for 215 of 22,509 routes -- IFP-IAH is one: id order is IFP,IAH but the header reads
 * "IAH–IFP". Pairing each half of `canonical` back to its airport BY CODE, rather than assuming
 * `canonical.split("-")` lines up with `[low, high]`, keeps a displayed name attached to the
 * code it is actually under. A `JFK–LAX`-shaped fixture cannot fail this way, so any test for
 * it needs a disagreeing pair. */
export function routeEndpoints(
  low: AirportRef,
  high: AirportRef,
  canonical: string,
): [AirportRef, AirportRef] {
  const [codeA, codeB] = canonical.split("-");
  const airports = [low, high];
  return [
    airports.find((x) => x.code === codeA) ?? low,
    airports.find((x) => x.code === codeB) ?? high,
  ];
}
