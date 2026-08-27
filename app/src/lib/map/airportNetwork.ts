import { readFileSync } from "node:fs";
import path from "node:path";
import type { DuckDBValue } from "@duckdb/node-api";
import { connect, runPivot } from "@/lib/db";
import type { AirportRef } from "@/lib/resolve";
import type { PivotQuery } from "@/lib/pivot/types";
import type { ArcDatum } from "./arcs";
import type { NetworkMapInput } from "./networkMap";

// Same anchor, same reason, as db.ts's ROOT / resolve.ts's QUERIES_DIR: process.cwd() is
// correct in production; Vitest gets UPGAUGE_ROOT from vitest.config.ts's setupFiles.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

/** One row of the `route`-grain pivot this file drives: `route_key_low`/`route_key_high` are
 * the fact table's own normalized (least/greatest) undirected route identity -- NOT
 * `origin_airport_id`/`dest_airport_id`, which is what `endpoint_airport_id`'s filter matches
 * against. `farEndpoints` below reads only these two columns; `passengers` and
 * `departures_performed` are read separately by `toArcDatum`. */
export interface RouteEndpointRow {
  route_key_low: number;
  route_key_high: number;
  seats?: number | null;
  passengers?: number | null;
  departures_performed?: number | null;
}

/** The far end of each row, relative to `subjectId` -- the destination of a departure, the
 * origin of an arrival, and `subjectId` itself for a same-airport filing (both keys equal
 * `subjectId`, so either branch returns it). Route keys are ordered by airport ID
 * (`least`/`greatest` at the fact-table level), so the subject is the LOW key for some routes
 * and the HIGH key for others -- this must not assume one or the other. Mirrors
 * `endpoints.ts`'s `otherEndpoint`, on the route-grain columns rather than the segment-grain
 * ones. */
export function farEndpoints(rows: RouteEndpointRow[], subjectId: number): number[] {
  return rows.map((r) => (r.route_key_low === subjectId ? r.route_key_high : r.route_key_low));
}

/** Measured ceiling (M7 Task 8), not a guess: over the trailing 12 months, the worst
 * fact-present airport by distinct-route count is ORD (13930) at 268 -- checked over every
 * airport, not assumed from ORD alone. 1,000 clears that ~3.7x; NetworkMapInput carries no
 * truncation field (unlike endpoints.ts's tables), so a future refresh crossing this needs a
 * fresh measurement and a limit raise, not a silent undercount -- `runPivot`'s LIMIT would
 * simply drop the lowest-seat routes with no on-page disclosure today.
 *
 * `quarantinedRoutes` inherits that bound and is slightly worse off, because a wholly-quarantined
 * pair sorts LAST: `pivot_route.sql` orders `seats DESC` and DuckDB places NULLs last under DESC
 * (checked, not recalled), so such a pair is the FIRST row a LIMIT would drop. The count is
 * therefore exact only while a result is under this ceiling. It is nowhere near it today -- the
 * worst affected airport over the trailing 12 is GAL at 27 route pairs against a limit of 1,000
 * -- and the fix is the same one this comment already prescribes: re-measure and raise, never
 * quietly under-report. */
export const AIRPORT_NETWORK_LIMIT = 1000;

const MEASURES = ["seats", "passengers", "departures_performed"];

/** The one pivot: `fct_route_month` grouped by the undirected route identity, filtered to
 * rows touching `airport.id` at either end. Unlike `endpoints.ts`'s segment-grain query, this
 * carries no carrier dimension -- a network map draws one arc per destination, not one row per
 * (carrier, destination) -- so `route_key_low`/`route_key_high` alone already fold every
 * carrier and every month in the window into one row per route, and `grouping` never matters
 * (no `op_airline_id` dimension for it to touch). */
export function airportNetworkQuery(
  airportId: number,
  timeFrom: string,
  timeTo: string,
  limit: number,
): PivotQuery {
  return {
    grain: "route",
    dimensions: ["route"],
    measures: MEASURES,
    timeFrom,
    timeTo,
    filters: [["endpoint_airport_id", [String(airportId)]]],
    sort: "seats",
    sortDesc: true,
    limit,
    grouping: "operating",
  };
}

/** Exported alongside `fetchCoords` below, for map/carrierTypeNetwork.ts. */
export interface AirportCoords {
  id: number;
  code: string;
  name: string;
  lat: number;
  lon: number;
}

/** Read `map_airport_coords.sql`, bind the given ids as parameter NAMES (never concatenated),
 * and return coordinates keyed by id. Mirrors `resolve.ts`'s `{{IDS}}` substitution discipline,
 * but for a numeric id set rather than uppercased code slugs -- there is no dedup-by-code
 * concern here (an airport_id is already a key, not a slug that can collide). Empty input
 * returns without opening a connection, the same guard `resolve.ts`'s `runSlugLookup` has.
 *
 * EXPORTED for map/carrierTypeNetwork.ts, which needs BOTH endpoints of every row rather than
 * one far end, and which must not re-derive the `{{IDS}}` substitution discipline or open
 * `map_airport_coords.sql` a second way. It stays here rather than moving to a module of its
 * own only because that is the smaller diff; if a third caller appears, lifting these two into
 * `map/airportCoords.ts` is a pure move. */
export async function fetchCoords(ids: number[]): Promise<Map<number, AirportCoords>> {
  const out = new Map<number, AirportCoords>();
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return out;

  const names = distinct.map((_, i) => `$id${i}`);
  const raw = readFileSync(path.join(QUERIES_DIR, "map_airport_coords.sql"), "utf8");
  const occurrences = raw.split("{{IDS}}").length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `map_airport_coords.sql: expected exactly one {{IDS}} token, found ${occurrences}`,
    );
  }
  const statement = raw.replace("{{IDS}}", `(${names.join(", ")})`);

  const params: Record<string, DuckDBValue> = {};
  distinct.forEach((id, i) => {
    params[`id${i}`] = id as DuckDBValue;
  });

  const con = await connect();
  const prepared = await con.prepare(statement);
  prepared.bind(params);
  const result = await prepared.run();
  for (const r of await result.getRowObjects()) {
    out.set(Number(r.id), {
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      lat: Number(r.lat),
      lon: Number(r.lon),
    });
  }
  return out;
}

/** A ratio of sums, or null when the denominator is zero -- never an average, and never 0.0
 * for "nothing flew". Per-row here rather than per-group because `airportNetworkQuery` has
 * already summed every carrier and every month in the window into one row per route; this is
 * the row's own load factor, not a further aggregation across rows. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** One route-grain row that survived classification: definite numbers, far endpoint resolved,
 * ready to become an `ArcDatum` once its coordinates are looked up. */
export interface DrawableRouteRow {
  farId: number;
  seats: number;
  passengers: number;
  departures: number;
}

/** What `classifyRouteRows` sorted the window's rows into. Every row lands in exactly one of
 * these three, and nothing is discarded without a trace. */
export interface ClassifiedRoutes {
  /** Rows that become arcs, in the CALLER'S OWN ORDER -- the order `runPivot` returned, which
   * `renderNetworkMap` emits nodes in and which `networkGolden.fixture.ts` pins. A filter
   * preserves relative order, so removing quarantined rows cannot reorder the survivors. */
  drawable: DrawableRouteRow[];
  /** Seats on same-airport rows that carry real numbers. Not arcs (a great circle between one
   * point and itself has zero length), but their seats must still reach the reader or the map's
   * stated total falls out of step with the stat strip above it. */
  sameAirportSeats: number;
  /** Undirected pairs whose every filing in the window was quarantined, so their sums are NULL.
   * Excluded from `drawable` and surfaced with a count and a reason, never silently dropped. */
  quarantinedRoutes: number;
}

/**
 * Sorts the window's route-grain rows into what can be drawn, what can only be counted, and
 * what is a same-airport filing -- WITHOUT coercing a NULL sum into a zero.
 *
 * NULL AND ZERO ARE DIFFERENT FACTS, and this function's shape follows from that. Every measure
 * is a FILTERed sum (`301_meta_pivot_measures.sql`), so a pair arrives in one of two very
 * different states:
 *
 *   seats IS NULL   every filing on the pair was quarantined -- the sums are unknowable, NOT
 *                   zero. Measured over the trailing 12 at route grain: 11 such pairs, every
 *                   one quarantined `zero_seats` and every one having PERFORMED a departure
 *                   (departures_performed = 1 on all 11). THEY FLEW. Counted in
 *                   `quarantinedRoutes` and surfaced, never drawn and never discarded.
 *   seats = 0       the pair was filed and genuinely carried nothing. A real measurement,
 *                   drawn exactly as it was before #114.
 *
 * Before #114 both reached `Number(row.seats ?? 0)` and became the same arc: 0 seats, 0
 * departures, below `DEPARTURE_FLOOR`, dotted and muted -- "barely flown", which is a positive
 * claim the data does not support for the first group. `/airport/BTT` drew `UMT` that way, and
 * for `A18`, `JZM` and `OQZ` the quarantined pair is the airport's ENTIRE trailing-12 network,
 * so the page's only arc was the fabricated one.
 *
 * SAME-AIRPORT IS TESTED FIRST, and the order is load-bearing rather than incidental. A filing
 * whose two endpoints are one airport is not a route the airport served, whatever its
 * quarantine state, so it must not reach `quarantinedRoutes` -- which counts route PAIRS and
 * feeds a sentence about them. This is #105's rule at route grain, and the dataset has exactly
 * one fixture that can tell the two orders apart: `VEE` carries BOTH a wholly-quarantined route
 * pair (`BTI-VEE`) and a wholly-quarantined same-airport pair (`VEE-VEE`), so it must report 1,
 * not 2. Every other affected airport reports the same number under either order.
 *
 * A same-airport row with real numbers is NOT removed from `drawable` -- it stays, and
 * `renderNetworkMap` filters its polyline by code equality (`drawableSegments`). That is
 * `networkMap.ts`'s stated contract ("the caller never puts a same-airport row in `arcs` in the
 * first place, or, if it does, `renderNetworkMap` filters it below"), and preserving it is what
 * keeps `airportNetwork.test.ts`'s 268-rows-to-267-polylines assertion meaningful.
 *
 * EXPORTED for the reason `carrierTypeNetwork.ts` exports `drawableRoutes`: the partial-null
 * guard below cannot be reached from the warehouse (zero partially-null pairs exist, measured),
 * so only a synthetic row can prove it fires.
 */
export function classifyRouteRows(
  rows: RouteEndpointRow[],
  far: number[],
  subjectId: number,
): ClassifiedRoutes {
  const drawable: DrawableRouteRow[] = [];
  let sameAirportSeats = 0;
  let quarantinedRoutes = 0;

  rows.forEach((row, i) => {
    const seats = row.seats ?? null;
    const passengers = row.passengers ?? null;
    const departures = row.departures_performed ?? null;
    const isSameAirport = row.route_key_low === row.route_key_high;

    if (seats === null || passengers === null || departures === null) {
      // ONE null means ALL null: the three measures carry the IDENTICAL quarantine FILTER, so
      // they go null together or not at all (verified across the trailing 12 -- 11 pairs null,
      // 0 partially null). Asserted rather than assumed: were that FILTER ever dropped from one
      // measure and not the others, the mismatch would otherwise surface as a silently wrong
      // seat figure on a drawn arc instead of a stack trace.
      if (seats !== null || passengers !== null || departures !== null) {
        throw new Error(
          `classifyRouteRows: route ${row.route_key_low}-${row.route_key_high} at airport ` +
            `${subjectId} has a PARTIALLY null measure sum (seats=${seats}, ` +
            `passengers=${passengers}, departures=${departures}) -- the three measures no ` +
            "longer share one quarantine FILTER.",
        );
      }
      // Same-airport first: not a route pair, so it is counted in neither category. Its sums
      // are NULL, so there is no seat figure to preserve and nothing is lost by dropping it;
      // what would be lost by counting it is the meaning of `quarantinedRoutes`.
      if (!isSameAirport) quarantinedRoutes += 1;
      return;
    }

    if (isSameAirport) sameAirportSeats += seats;
    drawable.push({ farId: far[i], seats, passengers, departures });
  });

  return { drawable, sameAirportSeats, quarantinedRoutes };
}

/** Assembles one `ArcDatum` per route-grain row, resolving its far endpoint's coordinates and
 * code from `coords`. A far id absent from `coords` (should not happen -- every id here came
 * from a fact row touching a fact-present airport) throws rather than silently rendering a
 * dash; this project's fail-loud rule for a resolution gap (CLAUDE.md's AUS lesson) applies
 * to coordinates exactly as it does to codes. */
function toArcDatum(row: DrawableRouteRow, coords: Map<number, AirportCoords>): ArcDatum {
  const c = coords.get(row.farId);
  if (c === undefined) {
    throw new Error(
      `fetchAirportNetwork: no coordinates resolved for airport_id ${row.farId} -- ` +
        "map_airport_coords.sql's fact-presence assumption no longer holds",
    );
  }
  // No `?? 0` here, and there must never be one again (#114): `classifyRouteRows` has already
  // proven these three are non-null, so a coercion at this point could only re-introduce the
  // exact defect the classifier exists to prevent.
  return {
    code: c.code,
    lat: c.lat,
    lon: c.lon,
    seats: row.seats,
    departures: row.departures,
    loadFactor: ratio(row.passengers, row.seats),
  };
}

/** The airport network map's data: one `runPivot` at route grain (`airportNetworkQuery`) plus
 * one `map_airport_coords.sql` lookup for every distinct endpoint the result touches,
 * including the origin itself (`AirportRef` carries no lat/lon of its own).
 *
 * Returns `null` when the airport filed nothing in the window -- `/route`'s own rule: a
 * subject with nothing in the window gets NO chart, never a second panel repeating the empty
 * state that `AirportEmptyState` already renders for the carriers table. Filing something that
 * cannot be DRAWN is a different answer and returns a map: see `classifyRouteRows`. */
export async function fetchAirportNetwork(
  airport: AirportRef,
  timeFrom: string,
  timeTo: string,
  limit: number = AIRPORT_NETWORK_LIMIT,
): Promise<NetworkMapInput | null> {
  const result = await runPivot(airportNetworkQuery(airport.id, timeFrom, timeTo, limit));
  const rows = result.rows as unknown as RouteEndpointRow[];
  if (rows.length === 0) return null;

  const far = farEndpoints(rows, airport.id);
  const coords = await fetchCoords([airport.id, ...far]);

  const originCoords = coords.get(airport.id);
  if (originCoords === undefined) {
    throw new Error(
      `fetchAirportNetwork: no coordinates resolved for the subject airport_id ${airport.id}`,
    );
  }

  // ONE traversal, not two. Same-airport seats used to be summed in a second `reduce` with its
  // own `?? 0`, so the coercion had to be removed in two places and could be re-introduced in
  // either; now the null rule is stated once and both outputs come out of it.
  const { drawable, sameAirportSeats, quarantinedRoutes } = classifyRouteRows(rows, far, airport.id);

  const arcs: ArcDatum[] = drawable.map((row) => toArcDatum(row, coords));

  // NOT gated on `arcs.length === 0`. An airport whose entire window is one wholly-quarantined
  // pair (`A18`, `JZM`, `OQZ` over the trailing 12) has nothing to draw and something real to
  // say, and returning null here would leave no trace that anything was filed at all -- the
  // failure `quarantinedRoutes` exists to prevent, and the same rule `DiffMap` follows for a
  // carrier with no drawable arc. `rows.length === 0` -- the airport filed NOTHING in the
  // window -- remains the only null, exactly as before.
  return {
    origin: {
      code: originCoords.code,
      lat: originCoords.lat,
      lon: originCoords.lon,
      // Not a measurement and never rendered as one: `renderNetworkMap` passes this as the
      // `marker`, which reads only `code`/`lat`/`lon`. The three weight fields exist because
      // `ArcDatum` is the shape the marker travels in.
      seats: 0,
      departures: 0,
      loadFactor: null,
    },
    arcs,
    window: `${timeFrom} → ${timeTo}`,
    sameAirportSeats,
    quarantinedRoutes,
  };
}
