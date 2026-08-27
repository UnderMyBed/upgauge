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
   * NULL"). `/airport`'s totals (app/airport/[code]/endpoints.ts) already produce that null and
   * reach `cardStats` through this type; `sumTotals` below does NOT yet -- see its own note. */
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
 * `null`, never 0.0, when the denominator is zero: absence is not a measurement (lib/format.ts). */
export function sumTotals(rows: Record<string, unknown>[]): EntityTotals {
  // ISSUE #121, OPEN: `?? 0` here restates an unknowable sum as zero, and the `+` would do it
  // again even with the `??` removed. Measured over the trailing 12: 11 route pairs have no
  // un-quarantined filing at all, of which 10 are REACHABLE pages that render three fabricated
  // zeros in the stat strip and on the card. The eleventh is VEE-VEE, which `lib/routePair.ts`
  // 404s as a same-airport slug before any lookup -- so 11 is the pair count and 10 is the page
  // count, and they are not interchangeable. The type above is already `number | null` for
  // `/airport`'s sake; this function simply never returns one yet, so the widened type is NOT
  // evidence this is handled.
  const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const seats = sum("seats");
  const passengers = sum("passengers");
  const departures = sum("departures_performed");
  return {
    seats,
    passengers,
    departures,
    loadFactor: seats === 0 ? null : passengers / seats,
    avgGauge: departures === 0 ? null : seats / departures,
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
