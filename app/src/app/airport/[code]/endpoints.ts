import { runPivot } from "@/lib/db";
import {
  AIRCRAFT_MIX_LIMIT,
  BY_AIRCRAFT_TYPE,
  fetchAircraftMix,
  type MixRow,
} from "@/lib/chart/aircraftMix";
import type { PivotQuery } from "@/lib/pivot/types";
import type { Resolved } from "@/lib/resolve";

/** THE RULE THIS FILE EXISTS FOR: an airport is BOTH endpoints.
 *
 * Every figure on /airport/<code> must match `origin_airport_id = X OR dest_airport_id = X`.
 * An origin-only page is not obviously broken -- it renders every stat, every carrier row and
 * every chart band in exactly the right shape, and is silently about half the airport.
 * Measured at SEA (14747) over 2025-05..2026-04: 53,373,806 seats both ways against
 * 26,710,000 departing only, and 143 destinations against 140.
 *
 * THE MECHANISM, as of M7 Task 3: `endpoint_airport_id`, a first-class `meta_pivot_dimensions`
 * entry (filter_only, filter_mode='either', M7 Tasks 1-2) that compiles to
 * `(origin_airport_id IN (...) OR dest_airport_id IN (...))` in both render.ts and
 * pipeline/pivot.py. This page is therefore ONE pivot per grain -- one for the table/stat strip
 * (`fetchAirportTraffic`), one for the chart (`fetchAirportMix`) -- filtered on that dimension,
 * with SQL doing the OR and counting a same-airport row exactly once because it is one GROUP BY
 * row, not a set-arithmetic identity applied to two or three separate query results.
 *
 * THROUGH M6 the OR had to be assembled here instead, as inclusion-exclusion over three
 * ordinary pivots -- origin, dest, and their overlap -- because `meta_pivot_dimensions` offered
 * only `origin_airport_id` and `dest_airport_id` as separate (AND-ed) dimensions and the one
 * composite dimension (`route`) filters on a whole route PAIR, not a single endpoint. That
 * assembly (`inclusionExclusion`/`unionSides`/`unionMix`, plus the `partial` flag threaded
 * through every call of it) is gone; a first-class endpoint filter was M5's deferred call,
 * picked up here. Recorded in docs/architecture/pipeline.md § M4d and § M7.
 *
 * The rows a single `endpoint_airport_id` query returns still span BOTH directions of every
 * route (an SEA->PDX row and a PDX->SEA row are different `(origin, dest)` groups) and same-
 * airport rows still exist -- `origin = dest` rows: 3,187 of them over the TRAILING 12 MONTHS
 * (2025-05..2026-04) across 359 airports, 601,573 seats, QUARANTINED ROWS INCLUDED -- 3,182 /
 * 358 / 601,565 without them, and 12,738 / 530 / 1,887,424 (12,696 / 530 / 1,887,193 without)
 * over the full 2015-01..2026-04 window. The window and the quarantine qualifier are both
 * load-bearing: the four answers differ by 4x, and this file's own window is the trailing 12
 * for the table and the FULL window for the chart. docs/data/invariants.md § Route identity
 * tabulates all four. At SEA: 18 rows carrying 12,646 seats and 172 departures -- real activity
 * that `fct_segment_month` carries (the M4d design spec's "do not exist" is true only of route
 * IDENTITY, docs/data/invariants.md § Route identity, which excludes them as non-routes).
 * `toEndpointRows` below folds both directions and the same-airport case down to one
 * (carrier, other-endpoint) identity per fact row; `carrierRows`/`airportTotals` then sum over
 * however many rows share a carrier or an endpoint id, so nothing downstream needs the two
 * directions, or the same-airport case, kept separate or de-duplicated by hand -- the query
 * already returned each fact row once.
 */

/** One (carrier, other-endpoint) cell of the airport's traffic. Rows are NOT pre-deduplicated
 * by (carrier, endpoint) -- the pivot groups by (carrier, origin, dest), so a route flown in
 * both directions by the same carrier is two rows here, both naming the same `endpointId`.
 * That is fine: every consumer (`carrierRows`, `airportTotals`) sums or Set()s over however
 * many rows share a key, so nothing downstream needs a single row per (carrier, endpoint).
 *
 * `endpointId` is the airport at the OTHER end -- the destination of a departure, the origin
 * of an arrival, and the airport itself for a same-airport filing. Keeping it (rather than
 * aggregating to the carrier in SQL) is what lets one query answer both "which carriers" and
 * "how many destinations". */
export interface EndpointRow {
  carrierId: unknown;
  endpointId: unknown;
  seats: number;
  passengers: number;
  departures: number;
  quarantinedRows: number;
}

/** A ratio of sums, or null when the denominator is zero. Never an average of the rows above,
 * and never 0.0 for "nothing flew" -- absence is not a measurement (lib/format.ts). */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** The carriers table's rows: one per operating carrier, endpoints folded away.
 *
 * Emitted in the shape DataTable and the pivot vocabulary already use (`op_airline_id`,
 * `load_factor`, `quarantined_rows`) so the component, the reason-code gutter and the gauge
 * rail all work unchanged -- these rows stand in for a pivot result the pivot cannot express.
 * Sorted by seats descending, matching what the ORDER BY would have been. */
export function carrierRows(rows: EndpointRow[]): Record<string, unknown>[] {
  const byCarrier = new Map<string, EndpointRow>();
  for (const row of rows) {
    const key = String(row.carrierId);
    const existing = byCarrier.get(key);
    if (existing === undefined) {
      byCarrier.set(key, { ...row });
      continue;
    }
    existing.seats += row.seats;
    existing.passengers += row.passengers;
    existing.departures += row.departures;
    existing.quarantinedRows += row.quarantinedRows;
  }
  return [...byCarrier.values()]
    .sort((a, b) => b.seats - a.seats)
    .map((r) => ({
      op_airline_id: r.carrierId,
      seats: r.seats,
      passengers: r.passengers,
      departures_performed: r.departures,
      load_factor: ratio(r.passengers, r.seats),
      avg_gauge: ratio(r.seats, r.departures),
      quarantined_rows: r.quarantinedRows,
    }));
}

export interface AirportTotals {
  seats: number;
  passengers: number;
  departures: number;
  loadFactor: number | null;
  avgGauge: number | null;
  carriers: number;
  destinations: number;
  quarantinedRows: number;
}

/** The stat strip. Same ratio-of-sums discipline as carrierRows, one level up: this is a sum
 * over the pivot's rows, never an average of the carrier rows the table shows.
 *
 * `destinations` excludes the airport itself. Its own same-airport filings are real activity
 * and stay in every measure, but SEA is not one of SEA's destinations. Measured over the
 * trailing 12 months at SEA: 144 distinct other-endpoint ids including itself, 143 without. */
export function airportTotals(rows: EndpointRow[], airportId: number): AirportTotals {
  const seats = rows.reduce((a, r) => a + r.seats, 0);
  const passengers = rows.reduce((a, r) => a + r.passengers, 0);
  const departures = rows.reduce((a, r) => a + r.departures, 0);
  const endpoints = new Set(rows.map((r) => String(r.endpointId)));
  endpoints.delete(String(airportId));
  return {
    seats,
    passengers,
    departures,
    loadFactor: ratio(passengers, seats),
    avgGauge: ratio(seats, departures),
    carriers: new Set(rows.map((r) => String(r.carrierId))).size,
    destinations: endpoints.size,
    quarantinedRows: rows.reduce((a, r) => a + r.quarantinedRows, 0),
  };
}

/** Measured ceiling, not a guess. M7 Task 3 re-measured it for the single `endpoint_airport_id`
 * pivot below, which is NOT the same query the M4d-era "per side" figure described: that
 * comment counted (operating carrier, other endpoint) groups on two separate LIMIT-ed pivots,
 * pre-folded to one row per route by each side's own GROUP BY; this one groups by (operating
 * carrier, origin, dest) on ONE pivot, which keeps both directions of a route as separate rows
 * rather than folding them together the way the old union's key did -- so this figure is larger
 * than the old "per side"/"union" ones for the same airport, not comparable to them. Checked
 * against the 25 busiest airports by trailing-12 segment-row count, not assumed from ORD alone:
 * the busiest airport in the database (ORD, 13930) produces 1,732 such groups over a trailing 12
 * months, next is DFW (11298) at 1,237; SEA produces 666. 5,000 clears the real worst case 2.9x.
 * If a future refresh ever reaches it the page says so (`truncated`) rather than under-reporting,
 * exactly as /route/<pair> does at its own limit. */
export const AIRPORT_ENDPOINT_LIMIT = 5000;

const CARRIER_MEASURES = ["seats", "passengers", "departures_performed"];

/** The one pivot. `origin_airport_id` and `dest_airport_id` are carried as dimensions (not
 * folded into a single "other endpoint" column at the SQL layer, which the vocabulary has no
 * expression for) so `toEndpointRows` below can recover, per row, which end is the airport
 * itself and which is the other one -- the only thing this query still needs from TypeScript
 * rather than SQL. The filter is what does the OR: `endpoint_airport_id` is `filter_only`, so
 * it is accepted here and would be rejected if it appeared in `dimensions` instead (Task 2). */
export function airportTrafficQuery(
  airportId: number,
  timeFrom: string,
  timeTo: string,
  limit: number,
): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["op_airline_id", "origin_airport_id", "dest_airport_id"],
    measures: CARRIER_MEASURES,
    timeFrom,
    timeTo,
    filters: [["endpoint_airport_id", [String(airportId)]]],
    sort: "seats",
    sortDesc: true,
    limit,
    // The operating carrier is the grain and the truth (CLAUDE.md): a Delta-branded regional
    // flown by Endeavor files as 9E, and this page reports what was operated at this airport.
    grouping: "operating",
  };
}

/** The airport at the OTHER end of a row that is guaranteed (by the `endpoint_airport_id`
 * filter) to have `airportId` at one end or the other -- the destination of a departure, the
 * origin of an arrival, and `airportId` itself for a same-airport filing (both columns equal
 * `airportId`, so either branch below returns it). This is the one piece of the old
 * inclusion-exclusion the SQL layer cannot express on its own: `meta_pivot_dimensions` has no
 * CASE-shaped "other endpoint" column, only the two real ones. */
function otherEndpoint(row: Record<string, unknown>, airportId: string): unknown {
  return String(row.origin_airport_id) === airportId ? row.dest_airport_id : row.origin_airport_id;
}

export function toEndpointRows(rows: Record<string, unknown>[], airportId: string): EndpointRow[] {
  return rows.map((r) => ({
    carrierId: r.op_airline_id,
    endpointId: otherEndpoint(r, airportId),
    seats: Number(r.seats ?? 0),
    passengers: Number(r.passengers ?? 0),
    departures: Number(r.departures_performed ?? 0),
    quarantinedRows: Number(r.quarantined_rows ?? 0),
  }));
}

export interface AirportTraffic {
  rows: EndpointRow[];
  /** Display values for the carrier ids on these rows. */
  resolved: Map<string, Resolved>;
  /** The pivot came back at exactly `limit` rows, so the table and stat strip under-report and
   * the page must say so. */
  truncated: boolean;
}

/** The trailing-12 table and the stat strip, in one pivot -- no union. `carrierRows` and
 * `airportTotals` both sum over every row they are handed regardless of how many rows share a
 * carrier or an endpoint id, so a route's two directions (or a same-airport filing) needing
 * more than one row here to preserve is a non-issue: the totals come out the same whether this
 * query returns one folded row per (carrier, other-endpoint) or several unfolded ones. */
export async function fetchAirportTraffic(
  airportId: number,
  timeFrom: string,
  timeTo: string,
  limit: number = AIRPORT_ENDPOINT_LIMIT,
): Promise<AirportTraffic> {
  const result = await runPivot(airportTrafficQuery(airportId, timeFrom, timeTo, limit));
  return {
    rows: toEndpointRows(result.rows, String(airportId)),
    resolved: result.resolved,
    truncated: result.rows.length >= limit,
  };
}

export interface AirportMix {
  rows: MixRow[];
  /** The pivot came back at exactly `limit` cells, so the chart under-reports and the page must
   * say so -- the same contract, and the same word, as AirportTraffic's. */
  truncated: boolean;
}

/** The chart's full-window mix, one `endpoint_airport_id`-filtered pivot at (month, aircraft
 * type) grain -- no union, and no per-row "other endpoint" to recover, since the chart's grain
 * doesn't carry one.
 *
 * Measured over 2015-01..2026-04, again checked against the 25 busiest airports rather than
 * assumed: the worst case in the database is ORD (13930) at 4,118 distinct (month, type)
 * groups, comfortably inside `AIRCRAFT_MIX_LIMIT` -- unchanged from the M4d-era union figure,
 * because this grain never carried a direction to begin with (year_month x aircraft_type has
 * no origin/dest column), so collapsing three pivots into one changes nothing about what gets
 * counted here. ATL is 3,592 and SEA 2,886 (endpoints.test.ts's existing SEA assertion, unmoved).
 * endpoints.test.ts asserts ORD comes back untruncated, so a refresh that approaches the bound
 * fails a TEST rather than a page. */
export async function fetchAirportMix(
  airportId: number,
  timeFrom: string,
  timeTo: string,
  limit: number = AIRCRAFT_MIX_LIMIT,
): Promise<AirportMix> {
  const id = String(airportId);
  const rows = await fetchAircraftMix(
    [["endpoint_airport_id", [id]]],
    timeFrom,
    timeTo,
    BY_AIRCRAFT_TYPE,
    limit,
  );
  return { rows, truncated: rows.length >= limit };
}
