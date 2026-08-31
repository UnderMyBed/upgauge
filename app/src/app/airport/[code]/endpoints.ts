import { runPivot } from "@/lib/db";
import {
  AIRCRAFT_MIX_LIMIT,
  BY_AIRCRAFT_TYPE,
  fetchAircraftMix,
  type MixRow,
} from "@/lib/chart/aircraftMix";
import { addSum, numOrNull, ratio } from "@/lib/nullSum";
import type { PivotQuery } from "@/lib/pivot/types";
import type { Resolved } from "@/lib/resolve";

/** THE RULE THIS FILE EXISTS FOR: an airport is BOTH endpoints.
 *
 * Every figure on /airport/<code> must match `origin_airport_id = X OR dest_airport_id = X`.
 * An origin-only page is not obviously broken -- it renders every stat, every carrier row and
 * every chart band in exactly the right shape, and is silently about half the airport.
 * Measured at SEA (14747) over 2025-06..2026-05: 53,372,100 seats both ways against
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
 * through every call of it) is gone, replaced by a first-class endpoint filter. Recorded in
 * docs/architecture/pipeline.md § Composite and either-endpoint dimensions.
 *
 * The rows a single `endpoint_airport_id` query returns still span BOTH directions of every
 * route (an SEA->PDX row and a PDX->SEA row are different `(origin, dest)` groups) and same-
 * airport rows still exist -- `origin = dest` rows: 3,177 of them over the TRAILING 12 MONTHS
 * (2025-06..2026-05) across 356 airports, 598,829 seats, QUARANTINED ROWS INCLUDED -- 3,173 /
 * 355 / 598,829 without them, and 12,995 / 532 / 1,933,052 (12,953 / 532 / 1,932,821 without)
 * over the full 2015-01..2026-05 window. The window and the quarantine qualifier are both
 * load-bearing: the four answers differ by 4x, and this file's own window is the trailing 12
 * for the table and the FULL window for the chart. docs/data/invariants.md § Route identity
 * tabulates all four. At SEA: 17 rows carrying 12,207 seats and 166 departures -- real activity
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
  /** NULL, never 0, when every filing behind this group was quarantined. Each measure is
   * `SUM(x) FILTER (WHERE NOT is_quarantined)` (sql/02_marts/301_meta_pivot_measures.sql:21-32)
   * and a SUM over zero passing rows returns NULL -- "nothing filed here can be trusted", which
   * is a different finding from "nothing flew" and must stay distinguishable from it.
   * Measured: the 26 rows behind the 21 such groups in the trailing 12 all filed
   * `departures_performed` between 1 and 7 against a seat count of zero, so a row rendered as
   * "0 departures" is not merely unknowable, it is the opposite of what BTS filed. */
  seats: number | null;
  passengers: number | null;
  departures: number | null;
  /** A COUNT, not a measure: `count(*) FILTER (WHERE is_quarantined)`
   * (sql/03_queries/pivot_segment.sql:20) cannot return NULL, and 0 here is the real
   * measurement "none of this group's filings were quarantined". */
  quarantinedRows: number;
  /** Why they were quarantined, verbatim from the pivot's own
   * `string_agg(DISTINCT quarantine_reason, ',')` (pivot_segment.sql:21-22), or null where
   * nothing was. The em dash says the sums cannot be stated; this is what says why. */
  quarantineReasons: string | null;
}

/** Seats descending, NULLS LAST -- the ordering `pivot_segment.sql` already returns, since
 * DuckDB places NULLs last under DESC.
 *
 * Written out rather than `(b.seats ?? 0) - (a.seats ?? 0)` because a carrier that measurably
 * flew nothing and a carrier whose figures are unknowable are different findings, and `?? 0`
 * ties them -- leaving the winner to insertion order, which is the "right answer by accident
 * of row order" failure this project has already paid for once. */
function bySeatsDesc(a: EndpointRow, b: EndpointRow): number {
  if (a.seats === b.seats) return 0;
  if (a.seats === null) return 1;
  if (b.seats === null) return -1;
  return b.seats - a.seats;
}

/** The union of two rows' quarantine reasons, de-duplicated and comma-joined -- the same shape
 * `string_agg(DISTINCT quarantine_reason, ',')` produces, since folding several groups into one
 * carrier row means folding their reasons too. */
function mergeReasons(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return [...new Set([...a.split(","), ...b.split(",")])].join(",");
}

/** The carriers table's rows: one per operating carrier, endpoints folded away.
 *
 * Emitted in the shape DataTable and the pivot vocabulary already use (`op_airline_id`,
 * `load_factor`, `quarantined_rows`) so the component, the reason-code gutter and the gauge
 * rail all work unchanged -- these rows stand in for a pivot result the pivot cannot express.
 * Sorted by seats descending, matching what the ORDER BY would have been. */
export function carrierRows(
  rows: EndpointRow[],
  activeMonths: ReadonlyMap<string, number>,
): Record<string, unknown>[] {
  const byCarrier = new Map<string, EndpointRow>();
  for (const row of rows) {
    const key = String(row.carrierId);
    const existing = byCarrier.get(key);
    if (existing === undefined) {
      byCarrier.set(key, { ...row });
      continue;
    }
    existing.seats = addSum(existing.seats, row.seats);
    existing.passengers = addSum(existing.passengers, row.passengers);
    existing.departures = addSum(existing.departures, row.departures);
    existing.quarantinedRows += row.quarantinedRows;
    existing.quarantineReasons = mergeReasons(existing.quarantineReasons, row.quarantineReasons);
  }
  return [...byCarrier.values()]
    .sort(bySeatsDesc)
    .map((r) => ({
      op_airline_id: r.carrierId,
      seats: r.seats,
      passengers: r.passengers,
      departures_performed: r.departures,
      load_factor: ratio(r.passengers, r.seats),
      avg_gauge: ratio(r.seats, r.departures),
      quarantined_rows: r.quarantinedRows,
      quarantine_reasons: r.quarantineReasons,
      // THE FLOOR'S DENOMINATOR, AND IT DOES NOT COME FROM THE FOLD ABOVE (#134).
      //
      // Every other field here folds arithmetically -- sums add, reasons union as strings. A
      // DISTINCT-MONTH COUNT DOES NOT. The truth for this row is the number of months the
      // carrier flew AT THIS AIRPORT AT ALL, which is the union of its per-endpoint month
      // sets, and a union is not recoverable from the counts: `max()` is only a lower bound
      // and `sum()` double-counts every month two endpoints share. Measured over every
      // /airport page in the trailing 12 (3,457 folded carrier rows), `max()` gives the wrong
      // month count on 342 and the wrong BELOW-FLOOR VERDICT on 18; `sum()` flips 1,186.
      //
      // So it comes from `airportCarrierMonthsQuery` -- a second pivot grouped by carrier
      // alone, where DuckDB does the DISTINCT over exactly that union. Undefined for a carrier
      // the count query did not return, which `DataTable` reads as "no claim about the floor"
      // rather than as a denominator of zero.
      active_months: activeMonths.get(String(r.carrierId)),
    }));
}

export interface AirportTotals {
  /** NULL, never 0, when every row the airport has is unknowable -- measured for A18, JZM and
   * OQZ, whose entire trailing-12 window is a single quarantined filing. See EndpointRow. */
  seats: number | null;
  passengers: number | null;
  departures: number | null;
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
  // Seeded `null`, not 0, and folded with addSum: seeding 0 would make the stat strip of an
  // airport whose every filing was quarantined read "0 seats" -- the page-level form of the
  // same defect (issue #118). The counts below are unaffected; they count what was FILED.
  //
  // Folded here rather than through `sumColumn` because these rows are `EndpointRow`s, already
  // mapped to `number | null` fields by `toEndpointRows`; `sumColumn` takes raw pivot rows and
  // does the `numOrNull` step itself. Same three functions either way.
  const seats = rows.reduce<number | null>((a, r) => addSum(a, r.seats), null);
  const passengers = rows.reduce<number | null>((a, r) => addSum(a, r.passengers), null);
  const departures = rows.reduce<number | null>((a, r) => addSum(a, r.departures), null);
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

/** Measured ceiling for the carrier-months query below. The most operating carriers any one
 * airport sees over a trailing 12 months is 43 (ORD, 13930) on the 2026-05 warehouse, and 70
 * carriers file anything at all anywhere in that window -- so this cannot truncate on any
 * airport in the database, and 500 leaves an order of magnitude of headroom besides. Unlike
 * `AIRPORT_ENDPOINT_LIMIT` this bounds a query whose grain is one row per CARRIER, not one per
 * (carrier, origin, dest), which is why it is three orders of magnitude smaller. */
export const AIRPORT_CARRIER_LIMIT = 500;

/** THE FLOOR'S DENOMINATOR, AS ITS OWN PIVOT (#134).
 *
 * Deliberately the SAME window, the SAME filter, the SAME grain and the SAME grouping as
 * `airportTrafficQuery`, differing on exactly one axis: it groups by `op_airline_id` ALONE.
 * That single difference is the whole point -- `active_months` is a `count(DISTINCT
 * year_month)` computed per GROUP, so grouping by carrier alone makes it the union over every
 * endpoint that carrier served, which is what the folded row in `carrierRows` needs and what
 * no fold of the per-endpoint counts can reconstruct.
 *
 * A SECOND QUERY, NOT A SECOND SOURCE OF TRUTH: nothing but the month count is read from it.
 * The seats, passengers and departures the table shows still come from the one traffic pivot,
 * so the two cannot disagree about a displayed number.
 *
 * THE ONE SEAM, stated so the next reader does not rediscover it as a bug: if the traffic
 * pivot ever came back at exactly `AIRPORT_ENDPOINT_LIMIT` its departures would be truncated
 * while this query's month count would not, making the rate slightly understated on a page
 * that is already declaring `truncated` and under-reporting every figure on it. The real worst
 * case is ORD at 1,732 groups against a 5,000 limit, so it does not happen today. */
export function airportCarrierMonthsQuery(
  airportId: number,
  timeFrom: string,
  timeTo: string,
): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: CARRIER_MEASURES,
    timeFrom,
    timeTo,
    filters: [["endpoint_airport_id", [String(airportId)]]],
    sort: "seats",
    sortDesc: true,
    limit: AIRPORT_CARRIER_LIMIT,
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
    // NOT `?? 0`. See EndpointRow, `lib/nullSum.ts`, and issue #118: these three are FILTERed sums
    // that return NULL for a wholly-quarantined group, and restating that as 0 turns "we
    // cannot say" into "nothing flew". `quarantined_rows` keeps its `?? 0` because it is a
    // count, not a measure, and cannot be NULL.
    seats: numOrNull(r.seats),
    passengers: numOrNull(r.passengers),
    departures: numOrNull(r.departures_performed),
    quarantinedRows: Number(r.quarantined_rows ?? 0),
    quarantineReasons: typeof r.quarantine_reasons === "string" ? r.quarantine_reasons : null,
  }));
}

export interface AirportTraffic {
  rows: EndpointRow[];
  /** Display values for the carrier ids on these rows. */
  resolved: Map<string, Resolved>;
  /** The pivot came back at exactly `limit` rows, so the table and stat strip under-report and
   * the page must say so. */
  truncated: boolean;
  /** Months each carrier ACTUALLY FLEW at this airport, keyed by `String(airline_id)` -- the
   * departure floor's denominator, from `airportCarrierMonthsQuery`. Not derivable from
   * `rows`: see `carrierRows`. */
  activeMonths: Map<string, number>;
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
  // CONCURRENT, not a sequential second await: the two pivots share nothing and `connect()`
  // hands each its own DuckDBConnection off the single memoized instance -- the same shape
  // /route and /carrier already use for their several pivots.
  const [result, months] = await Promise.all([
    runPivot(airportTrafficQuery(airportId, timeFrom, timeTo, limit)),
    runPivot(airportCarrierMonthsQuery(airportId, timeFrom, timeTo)),
  ]);
  return {
    rows: toEndpointRows(result.rows, String(airportId)),
    resolved: result.resolved,
    truncated: result.rows.length >= limit,
    activeMonths: new Map(
      months.rows.map((r) => [String(r.op_airline_id), Number(r.active_months)]),
    ),
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
