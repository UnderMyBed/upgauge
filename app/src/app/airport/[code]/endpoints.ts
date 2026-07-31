import { runPivot } from "@/lib/db";
import { fetchAircraftMix, type MixRow } from "@/lib/chart/aircraftMix";
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
 * The pivot vocabulary cannot express that OR. `meta_pivot_dimensions` offers
 * `origin_airport_id` and `dest_airport_id` as separate dimensions, filters are AND-ed
 * together, and the one composite dimension (`route`) filters on a whole route PAIR, not on a
 * single endpoint. So the OR is assembled here, as inclusion-exclusion over three ordinary
 * pivots -- origin, dest, and their overlap -- rather than by adding a catalog entry and a
 * second composite-filter semantics to render.ts AND pipeline/pivot.py in lockstep. Recorded
 * in docs/architecture/pipeline.md § M4d; a first-class endpoint filter is M5's call.
 *
 * The overlap term is not decoration. `origin = dest` rows exist: 3,187 of them over the
 * trailing 12 months across 359 airports (601,573 seats), 18 at SEA carrying 12,646 seats and
 * 172 departures. The M4d design spec states these "do not exist" at segment grain -- that is
 * true of route IDENTITY (docs/data/invariants.md § Route identity excludes them as non-routes)
 * and false of fct_segment_month, which is what this page queries. Without the subtraction SEA
 * reads 53,386,452 seats.
 */

/** One (carrier, other-endpoint) cell of the airport's traffic, direction already folded away.
 *
 * `endpointId` is the airport at the OTHER end -- the destination of a departure, the origin
 * of an arrival, and the airport itself for a same-airport filing. Keeping it (rather than
 * aggregating to the carrier in SQL) is what lets one pair of queries answer both "which
 * carriers" and "how many destinations", and is the only way the overlap rows stay
 * identifiable at all. */
export interface EndpointRow {
  carrierId: unknown;
  endpointId: unknown;
  seats: number;
  passengers: number;
  departures: number;
  quarantinedRows: number;
}

const ENDPOINT_MEASURES = ["seats", "passengers", "departures", "quarantinedRows"] as const;
const MIX_MEASURES = ["seats", "departures"] as const;

/** |A ∪ B| = |A| + |B| − |A ∩ B|, applied to summed measures rather than to counts.
 *
 * Generic over the row shape because the page needs it twice at two different grains -- once
 * keyed on (carrier, endpoint) for the table and the stat strip, once on (month, aircraft
 * type) for the chart -- and two copies of an arithmetic identity is how one of them silently
 * loses its third term.
 *
 * Identity fields (everything not named in `measures`) come from the first side that carried
 * the key, so `label` on a MixRow survives untouched.
 *
 * A key in `both` that is not on BOTH other sides throws, because SQL makes that impossible:
 * a row matching `origin = X AND dest = X` matches `origin = X` and matches `dest = X`. The
 * only way to reach it is a coding error -- reading the wrong endpoint column, say -- and the
 * consequence of shrugging it off is a measure driven negative, which formats as a perfectly
 * ordinary number under a DATA AS OF badge.
 *
 * `partial` is the one legitimate exception, and it is not hypothetical: each side is a
 * `LIMIT`-ed pivot, so a truncated side can drop rows the overlap query still returns. When a
 * side has been truncated the row was counted at most once already, so there is nothing to
 * subtract, and the page is separately disclosing that its totals cover only the rows it got.
 * Without this the page would 500 for being big -- strictly worse than disclosing truncation.
 * Found by the truncation test, not by reading. */
export function inclusionExclusion<T extends object>(
  sides: { origin: T[]; dest: T[]; both: T[] },
  keyOf: (row: T) => string,
  measures: readonly (keyof T & string)[],
  options: { partial?: boolean } = {},
): T[] {
  // `T extends object`, not `T extends Record<string, unknown>`: an interface without an index
  // signature (EndpointRow, MixRow -- i.e. both real callers) does not satisfy the latter, and
  // Vitest would never have said so, since esbuild strips types without checking them. Caught
  // by `make app-check`. The two casts below are the price of indexing a named-property type
  // by a key the caller chose; `measures` is `keyof T`, so they cannot name a field that does
  // not exist.
  const cell = (row: T, m: keyof T & string): number =>
    Number((row as Record<string, unknown>)[m] ?? 0);
  const acc = new Map<string, T>();
  const seen = { origin: new Set<string>(), dest: new Set<string>() };
  const add = (rows: T[], which: "origin" | "dest") => {
    for (const row of rows) {
      const key = keyOf(row);
      seen[which].add(key);
      const existing = acc.get(key);
      if (existing === undefined) {
        acc.set(key, { ...row });
        continue;
      }
      for (const m of measures) {
        (existing as Record<string, unknown>)[m] = cell(existing, m) + cell(row, m);
      }
    }
  };
  add(sides.origin, "origin");
  add(sides.dest, "dest");

  for (const row of sides.both) {
    const key = keyOf(row);
    if (!seen.origin.has(key) || !seen.dest.has(key)) {
      if (options.partial) continue;
      throw new Error(
        `overlap row '${key}' is missing from the origin and/or destination side -- the ` +
          "origin ∩ dest term must be a subset of both, or subtracting it drives a measure " +
          "negative",
      );
    }
    const existing = acc.get(key)!;
    for (const m of measures) {
      (existing as Record<string, unknown>)[m] = cell(existing, m) - cell(row, m);
    }
  }
  return [...acc.values()];
}

function endpointKey(row: EndpointRow): string {
  // NUL separator, same reasoning as lib/resolve.ts's resolutionKey: it cannot occur in
  // either id, so no pair of distinct (carrier, endpoint) tuples can collide.
  return `${String(row.carrierId)}\u0000${String(row.endpointId)}`;
}

export function unionSides(
  origin: EndpointRow[],
  dest: EndpointRow[],
  both: EndpointRow[],
  options: { partial?: boolean } = {},
): EndpointRow[] {
  return inclusionExclusion({ origin, dest, both }, endpointKey, ENDPOINT_MEASURES, options);
}

export function unionMix(origin: MixRow[], dest: MixRow[], both: MixRow[]): MixRow[] {
  return inclusionExclusion(
    { origin, dest, both },
    (r) => `${r.month}\u0000${r.code}`,
    MIX_MEASURES,
  );
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
 * over the union's rows, never an average of the carrier rows the table shows.
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

/** Measured ceiling, not a guess: the busiest airport in the database produces 959 distinct
 * (operating carrier, other endpoint) groups over a trailing 12 months, per side -- SEA
 * produces 374 departing and 293 arriving. 5,000 clears the measured worst case 5x. If a
 * future refresh ever reaches it the page says so (`truncated`) rather than under-reporting,
 * exactly as /route/<pair> does at its own limit. */
export const AIRPORT_ENDPOINT_LIMIT = 5000;

const CARRIER_MEASURES = ["seats", "passengers", "departures_performed"];

/** The three pivots, as data. `origin` and `dest` each carry the OTHER endpoint as their
 * second dimension; `both` is the overlap -- two single-column filters AND-ed, which is
 * exactly `origin = X AND dest = X`. */
export function endpointQueries(
  airportId: number,
  timeFrom: string,
  timeTo: string,
  limit: number,
): { origin: PivotQuery; dest: PivotQuery; both: PivotQuery } {
  const id = String(airportId);
  const base = {
    grain: "segment",
    measures: CARRIER_MEASURES,
    timeFrom,
    timeTo,
    sort: "seats",
    sortDesc: true,
    limit,
    // The operating carrier is the grain and the truth (CLAUDE.md): a Delta-branded regional
    // flown by Endeavor files as 9E, and this page reports what was operated at this airport.
    grouping: "operating",
  } as const;
  return {
    origin: {
      ...base,
      dimensions: ["op_airline_id", "dest_airport_id"],
      filters: [["origin_airport_id", [id]]],
    },
    dest: {
      ...base,
      dimensions: ["op_airline_id", "origin_airport_id"],
      filters: [["dest_airport_id", [id]]],
    },
    both: {
      ...base,
      dimensions: ["op_airline_id", "dest_airport_id"],
      filters: [
        ["origin_airport_id", [id]],
        ["dest_airport_id", [id]],
      ],
    },
  };
}

function toEndpointRows(rows: Record<string, unknown>[], endpointColumn: string): EndpointRow[] {
  return rows.map((r) => ({
    carrierId: r.op_airline_id,
    endpointId: r[endpointColumn],
    seats: Number(r.seats ?? 0),
    passengers: Number(r.passengers ?? 0),
    departures: Number(r.departures_performed ?? 0),
    quarantinedRows: Number(r.quarantined_rows ?? 0),
  }));
}

export interface AirportTraffic {
  rows: EndpointRow[];
  /** Display values for the carrier ids on these rows, merged across the two sides. */
  resolved: Map<string, Resolved>;
  /** A side came back at exactly `limit` rows, so the union under-reports and the page must
   * say so. */
  truncated: boolean;
}

/** The trailing-12 table and the stat strip, in one wave of three concurrent pivots. */
export async function fetchAirportTraffic(
  airportId: number,
  timeFrom: string,
  timeTo: string,
  limit: number = AIRPORT_ENDPOINT_LIMIT,
): Promise<AirportTraffic> {
  const q = endpointQueries(airportId, timeFrom, timeTo, limit);
  // CONCURRENT: three independent queries against one memoized instance, each handed its own
  // connection -- the same reasoning as /route/<pair>'s two-pivot Promise.all. Serially this
  // page would pay for all three in turn for no reason.
  const [origin, dest, both] = await Promise.all([
    runPivot(q.origin),
    runPivot(q.dest),
    runPivot(q.both),
  ]);
  const truncated = origin.rows.length >= limit || dest.rows.length >= limit;
  return {
    rows: unionSides(
      toEndpointRows(origin.rows, "dest_airport_id"),
      toEndpointRows(dest.rows, "origin_airport_id"),
      toEndpointRows(both.rows, "dest_airport_id"),
      // A truncated side can no longer carry every overlap row, so the subset invariant the
      // union asserts is genuinely suspended -- see inclusionExclusion's header.
      { partial: truncated },
    ),
    resolved: new Map([...origin.resolved, ...dest.resolved]),
    truncated,
  };
}

/** The chart's full-window mix, same three-term union at (month, aircraft type) grain.
 *
 * Measured: the busiest airport produces 4,118 distinct (month, type) groups over the full
 * 2015-2026 window per side, comfortably inside fetchAircraftMix's own 10,000-row bound, so
 * no side is silently truncated. */
export async function fetchAirportMix(
  airportId: number,
  timeFrom: string,
  timeTo: string,
): Promise<MixRow[]> {
  const id = String(airportId);
  const [origin, dest, both] = await Promise.all([
    fetchAircraftMix([["origin_airport_id", [id]]], timeFrom, timeTo),
    fetchAircraftMix([["dest_airport_id", [id]]], timeFrom, timeTo),
    fetchAircraftMix(
      [
        ["origin_airport_id", [id]],
        ["dest_airport_id", [id]],
      ],
      timeFrom,
      timeTo,
    ),
  ]);
  return unionMix(origin, dest, both);
}
