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
  seats?: number;
  passengers?: number;
  departures_performed?: number;
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
 * simply drop the lowest-seat routes with no on-page disclosure today. */
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

/** Assembles one `ArcDatum` per route-grain row, resolving its far endpoint's coordinates and
 * code from `coords`. A far id absent from `coords` (should not happen -- every id here came
 * from a fact row touching a fact-present airport) throws rather than silently rendering a
 * dash; this project's fail-loud rule for a resolution gap (CLAUDE.md's AUS lesson) applies
 * to coordinates exactly as it does to codes. */
function toArcDatum(row: RouteEndpointRow, farId: number, coords: Map<number, AirportCoords>): ArcDatum {
  const c = coords.get(farId);
  if (c === undefined) {
    throw new Error(
      `fetchAirportNetwork: no coordinates resolved for airport_id ${farId} -- ` +
        "map_airport_coords.sql's fact-presence assumption no longer holds",
    );
  }
  const seats = Number(row.seats ?? 0);
  const passengers = Number(row.passengers ?? 0);
  const departures = Number(row.departures_performed ?? 0);
  return {
    code: c.code,
    lat: c.lat,
    lon: c.lon,
    seats,
    departures,
    loadFactor: ratio(passengers, seats),
  };
}

/** The airport network map's data: one `runPivot` at route grain (`airportNetworkQuery`) plus
 * one `map_airport_coords.sql` lookup for every distinct endpoint the result touches,
 * including the origin itself (`AirportRef` carries no lat/lon of its own).
 *
 * Returns `null` when the airport filed nothing in the window -- `/route`'s own rule: a
 * subject with nothing in the window gets NO chart, never a second panel repeating the empty
 * state that `AirportEmptyState` already renders for the carriers table. */
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

  const arcs: ArcDatum[] = rows.map((row, i) => toArcDatum(row, far[i], coords));

  // Same-airport rows (far endpoint === the subject) are NOT dropped here -- their seats must
  // still reach the map's stated total (networkMap.ts's own contract). `renderNetworkMap`
  // excludes them from the DRAWN arcs by code equality; this file only sums what it must not
  // lose.
  const sameAirportSeats = rows.reduce(
    (sum, row, i) => (far[i] === airport.id ? sum + Number(row.seats ?? 0) : sum),
    0,
  );

  return {
    origin: {
      code: originCoords.code,
      lat: originCoords.lat,
      lon: originCoords.lon,
      seats: 0,
      departures: 0,
      loadFactor: null,
    },
    arcs,
    window: `${timeFrom} → ${timeTo}`,
    sameAirportSeats,
  };
}
