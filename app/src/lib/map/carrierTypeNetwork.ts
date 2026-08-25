import { runPivot } from "@/lib/db";
import type { PivotQuery } from "@/lib/pivot/types";
import { fetchCoords, type AirportCoords } from "./airportNetwork";
import { NETWORK_ARC_CAP, type GeoNode, type SegmentDatum, type SegmentMapInput } from "./segmentMap";

/** Re-exported, never redefined. The literal lives in segmentMap.ts because it is one cap
 * across all three point-to-point maps and #109 must reach it without importing this file.
 * Wave 2's pinned import path (`from "@/lib/map/carrierTypeNetwork"`) resolves through here. */
export { NETWORK_ARC_CAP };

/** One row of the segment-grain pivot this file drives. `route_key_low`/`route_key_high` are
 * the fact table's own normalized (least/greatest) undirected route identity, so the two
 * filing directions of a pair are already one row.
 *
 * Every measure is OPTIONAL and NULLABLE on purpose. `301_meta_pivot_measures.sql` wraps each
 * SUM in `FILTER (WHERE NOT is_quarantined)`, and a SUM over zero passing rows returns NULL,
 * not 0 -- a group whose every filing was quarantined arrives here with NULL measures. That is
 * "untrustworthy", never "flew nothing", and `drawableRoutes` must not coerce it. */
export interface CarrierTypeRouteRow {
  route_key_low: number;
  route_key_high: number;
  seats?: number | null;
  passengers?: number | null;
  departures_performed?: number | null;
}

/** One (carrier, aircraft type, undirected pair) group that survived the floor: definite
 * numbers, ranked, ready to become a `SegmentDatum` once its coordinates are resolved. */
export interface DrawableRoute {
  routeKeyLow: number;
  routeKeyHigh: number;
  seats: number;
  passengers: number;
  departures: number;
}

export interface DrawableView {
  /** Ranked, same-airport pairs removed, floor applied. Length is the TRUE uncapped total. */
  routes: DrawableRoute[];
  /** Seats on same-airport groups that passed the floor -- kept out of `routes`, disclosed by
   * the renderer's footer rather than dropped. */
  sameAirportSeats: number;
}

/** The ceiling the pivot's `LIMIT` is set to, and the reason this file can state a true total
 * at all.
 *
 * `renderPivot` emits `LIMIT $limit` unconditionally and rejects a non-positive limit, so the
 * pivot path has NO "no limit" representation (`db.ts:251-254` says the same thing from the
 * other side: "A query-scope total would need its own aggregate query (no LIMIT); this layer
 * does not run one"). The one existing "N of M" in this repo is `search.ts`, whose SQL carries
 * no LIMIT and whose cap is applied in TS over the FULL set (`search.ts:266` is a `>` on the
 * whole result, never a `>=` on the page). This file mirrors that as closely as the pivot path
 * permits: fetch under a ceiling nothing can reach, then floor, rank, count and slice in TS.
 *
 * 25,000 is derived, not guessed: the whole dataset holds 23,041 distinct undirected pairs
 * (10,926 inside the trailing 12), which is a hard ceiling on what any single (carrier, type)
 * view can contain. The worst view measured is 1,559. That derivation WILL rot as BTS grows,
 * which is why `drawableRoutes` throws rather than trusting it -- see the guard below. */
export const NETWORK_FETCH_CEILING = 25_000;

// seats and passengers give the load factor as a ratio of SUMS; departures_performed carries
// both the arc's own departure count and the floor below. No `load_factor` measure is
// requested: a derived measure is computed from summed numerator and denominator, never
// averaged, and there is no load_factor column on fct_segment_month to average in the first
// place.
const MEASURES = ["seats", "passengers", "departures_performed"];

/** The one pivot: `fct_segment_month` grouped by the undirected route identity alone, with the
 * carrier and the aircraft type each pinned to a single value by a filter. Grouping by `route`
 * only is therefore already grain (op_airline_id, aircraft_type, undirected pair) -- adding
 * either as a DIMENSION would emit a constant column and change nothing, which is the same
 * argument `airportNetworkQuery` makes for its own single dimension.
 *
 * `grain: "segment"` is forced, not chosen: `aircraft_type` is a SEGMENT-grain dimension
 * (`300_meta_pivot_dimensions.sql:55`) because `fct_route_month` drops that grain entirely,
 * while `route` is grain `both` (`:49`) -- which is precisely what makes this query
 * expressible.
 *
 * `aircraftTypeCode` is passed through as a STRING and must stay one. Codes are zero-padded
 * ('079'), the catalog types the column VARCHAR, and `render.ts`'s `checkFilterValue` therefore
 * applies no numeric bound to it -- int-parsing it to 79 would silently select a different type
 * rather than fail.
 *
 * `grouping: "operating"` always. Operating carrier is the grain and the truth; under
 * `"mainline"` the SELECT would roll up to the parent while this filter still matched the raw
 * `op_airline_id` column (`render.ts:122-127` swaps the dimension expression, not the filter
 * one), so the two halves would disagree about which carrier the map is of. */
export function carrierTypeNetworkQuery(
  airlineId: number,
  aircraftTypeCode: string,
  timeFrom: string,
  timeTo: string,
  limit: number,
): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["route"],
    measures: MEASURES,
    timeFrom,
    timeTo,
    filters: [
      ["op_airline_id", [String(airlineId)]],
      ["aircraft_type", [aircraftTypeCode]],
    ],
    sort: "seats",
    sortDesc: true,
    limit,
    grouping: "operating",
  };
}

/** Descending by seats, then ascending by the route key -- a TOTAL order, so the same rows in
 * any input order rank identically.
 *
 * This is not defensive tidiness. `render.ts:301` emits `ORDER BY <col> DESC` with NO secondary
 * key, and ties land exactly on the cut: measured over the trailing 12, 31 of the 36 views that
 * exceed 400 have a seats tie at `row_number() = 400`, worst `DL` x type `614` with 164 pairs
 * all tied at exactly 160.0 seats (`OO` x `530`: 232 tied at 50.0). "Top 400 by seats" is
 * therefore non-deterministic on the SQL side -- which 164 get drawn could change between two
 * runs or two DuckDB versions. Ranking here instead of in SQL makes the result independent of
 * the engine's row order entirely, which is strictly stronger than a SQL tiebreak, and needs no
 * edit to `render.ts` or to its exact `pipeline/pivot.py` mirror.
 *
 * The tiebreak is the NUMERIC route key, not the airport code: `chart/aircraftMix.ts:341` sets
 * the house precedent for a deterministic tiebreak but reaches for `localeCompare`, which is
 * locale-sensitive. The route key is the row's own identity, carries no locale and needs no
 * display-layer lookup.
 *
 * The pivot's own `sort: "seats"` is therefore NOT what selects the drawn set, and saying so
 * is not pedantry -- it is measured. Mutating the query's sort key to `departures_performed`
 * reddens the query-shape test and NO data test: the fetch ceiling guarantees the whole view
 * is present, so this comparator alone decides what is drawn. The key is kept as `seats`
 * because a query that describes itself wrongly is a trap for the next reader.
 *
 * KNOWN, OUT OF SCOPE: an `/explore` permalink for the same filters at `limit = 400` inherits
 * the tiebreak-less `ORDER BY` and so can disagree with this map about which tied routes make
 * the cut. Closing that means editing `render.ts`, its Python mirror and the goldens. */
function bySeatsThenRouteKey(a: DrawableRoute, b: DrawableRoute): number {
  return (
    b.seats - a.seats || a.routeKeyLow - b.routeKeyLow || a.routeKeyHigh - b.routeKeyHigh
  );
}

/** Turn a raw pivot page into the ranked, drawable route list plus the same-airport seats it
 * sets aside. Pure, and EXPORTED ONLY so `carrierTypeNetwork.test.ts` can drive the three
 * properties `fetchCarrierTypeNetwork` structurally cannot expose -- the same reason
 * `db.ts`'s `connect()` and `watch.ts`'s `maskComments` are exported:
 *
 *  1. Rank determinism needs the SAME rows in a DIFFERENT input order. `Array.sort` is stable,
 *     so a tiebreak-less comparator still returns a fixed answer for a fixed input, and calling
 *     `fetchCarrierTypeNetwork` twice cannot tell the two apart. Permuting the input can.
 *  2. The ceiling guard needs an injectable ceiling; the pinned `fetchCarrierTypeNetwork`
 *     signature has no slot for one.
 *  3. The floor and the same-airport split are assertable here without a warehouse round trip.
 *
 * THE FLOOR: a group is drawable only if it PERFORMED departures in the window. The predicate
 * `departures_performed > 0` is applied here, on the pivot's group sums, because the pivot
 * template has no HAVING -- it is exactly `HAVING sum(departures_performed) > 0`, nothing else.
 * Measured at this grain over the trailing 12: 57 of 41,212 groups have zero-or-NULL performed
 * departures, and ALL 57 carry zero seats (groups with `deps = 0 AND seats > 0`: zero). So the
 * floor never moves a seat figure -- it removes pairs that were FILED and never flown, which
 * would otherwise draw a line between two airports for service that did not operate and, worse,
 * inflate the denominator of the map's own "N of M" disclosure. Two whole views consist of
 * nothing else (`F4` x `489` is 3 groups, all of them phantom).
 *
 * Group-level, never row-level, and that is a deliberate trade: a row-level filter would drop a
 * never-flown MONTH from a pair that flew in other months, making this map's seat figures
 * disagree with `/explore`'s for the identical filter set -- and every insight row on this site
 * is one click from the raw rows that produced it.
 *
 * The rollup codes and the passenger-config filter that issue #105 also lists are deliberately
 * NOT restated: `normalize_t100_segment.sql:71-72` applies `CLASS = 'F'` and
 * `AIRCRAFT_CONFIG IN (1,3,4)` at ingest, into the Parquet, so `service_class` holds exactly one
 * value and `aircraft_config` is already confined to {1,3,4}. Re-stating either here removes
 * zero rows, and a test asserting a clause that cannot change an outcome is the mutant class
 * this repo has already paid for four times. */
export function drawableRoutes(
  rows: CarrierTypeRouteRow[],
  airlineId: number,
  aircraftTypeCode: string,
  ceiling: number = NETWORK_FETCH_CEILING,
): DrawableView {
  // Fail loud rather than under-count. The ceiling exists so the TS-side cap can see the whole
  // view; a result that actually reached it means the view outgrew a derivation this file
  // states in NETWORK_FETCH_CEILING's own comment, and the honest answer is a stack trace, not
  // a disclosure line quietly reporting a total that is itself truncated.
  if (rows.length >= ceiling) {
    throw new Error(
      `drawableRoutes: airline ${airlineId} x aircraft type '${aircraftTypeCode}' returned ` +
        `${rows.length} rows at a fetch ceiling of ${ceiling} -- the view may be truncated, so ` +
        "totalRoutes cannot be stated. Re-measure the distinct-pair ceiling and raise " +
        "NETWORK_FETCH_CEILING.",
    );
  }

  const routes: DrawableRoute[] = [];
  let sameAirportSeats = 0;

  for (const row of rows) {
    const departures = row.departures_performed;
    if (departures === null || departures === undefined || departures <= 0) continue;

    // Unreachable on today's data and asserted rather than assumed: both sums carry the SAME
    // quarantine FILTER, so a group with passing departures has passing rows, and measured,
    // no group has `deps > 0` with NULL or zero seats. If that ever changes, a silent `?? 0`
    // would draw a zero-seat arc as though it were a measurement.
    const seats = row.seats;
    const passengers = row.passengers;
    if (seats === null || seats === undefined || passengers === null || passengers === undefined) {
      throw new Error(
        `drawableRoutes: route ${row.route_key_low}-${row.route_key_high} for airline ` +
          `${airlineId} x type '${aircraftTypeCode}' performed ${departures} departures but ` +
          "has a NULL seats or passengers sum -- the quarantine FILTER's own invariant no " +
          "longer holds.",
      );
    }

    if (row.route_key_low === row.route_key_high) {
      sameAirportSeats += seats;
      continue;
    }

    routes.push({
      routeKeyLow: row.route_key_low,
      routeKeyHigh: row.route_key_high,
      seats,
      passengers,
      departures,
    });
  }

  routes.sort(bySeatsThenRouteKey);
  return { routes, sameAirportSeats };
}

/** A ratio of sums, or null when the denominator is zero -- never an average, and never 0.0 for
 * "nothing flew". The pivot has already summed every month in the window into one row per pair,
 * so this is that pair's own load factor. Averaging the twelve monthly load factors instead is
 * not a rounding difference: on `DL` x `614` `ANC-SEA` the ratio of sums is 0.764858 and the
 * mean of the monthly ratios is 0.732402, 3.2 percentage points apart. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function node(id: number, coords: Map<number, AirportCoords>, context: string): GeoNode {
  const c = coords.get(id);
  if (c === undefined) {
    throw new Error(
      `fetchCarrierTypeNetwork: no coordinates resolved for airport_id ${id} (${context}) -- ` +
        "map_airport_coords.sql's fact-presence assumption no longer holds",
    );
  }
  return { code: c.code, lat: c.lat, lon: c.lon };
}

/** The carrier x aircraft-type network map's data: one segment-grain `runPivot` plus one
 * `map_airport_coords.sql` lookup for the endpoints of the routes actually drawn.
 *
 * `limit` is the DRAW cap, not the query's LIMIT -- the two are different numbers and the
 * signatures keep them apart deliberately. The query is issued at NETWORK_FETCH_CEILING so the
 * whole view is present to be counted; `limit` then decides how much of it is drawn.
 *
 * Returns null when nothing DRAWABLE remains -- the pair filed nothing in the window, or filed
 * only service it never flew (`F4` x `489`: three groups, all phantom, zero drawable). Same
 * "no panel rather than an empty panel" rule `fetchAirportNetwork` follows: a map of zero arcs
 * is an empty panel.
 *
 * Coordinates are resolved for the CAPPED set only, so a 1,559-row view pays for 400 arcs'
 * endpoints rather than all of them. The pivot's own `resolveRows` pass resolves those ids a
 * second time and its output is discarded here -- accepted, not overlooked: `fetchAirportNetwork`
 * pays the identical cost, and bypassing `runPivot` to save it would mean re-implementing its
 * parameter binding and bigint demotion. */
export async function fetchCarrierTypeNetwork(
  airlineId: number,
  aircraftTypeCode: string,
  timeFrom: string,
  timeTo: string,
  limit: number = NETWORK_ARC_CAP,
): Promise<SegmentMapInput | null> {
  const result = await runPivot(
    carrierTypeNetworkQuery(airlineId, aircraftTypeCode, timeFrom, timeTo, NETWORK_FETCH_CEILING),
  );
  const rows = result.rows as unknown as CarrierTypeRouteRow[];
  if (rows.length === 0) return null;

  const { routes, sameAirportSeats } = drawableRoutes(rows, airlineId, aircraftTypeCode);
  if (routes.length === 0) return null;

  const drawn = routes.slice(0, limit);
  const coords = await fetchCoords([
    ...drawn.map((r) => r.routeKeyLow),
    ...drawn.map((r) => r.routeKeyHigh),
  ]);

  const segments: SegmentDatum[] = drawn.map((r) => ({
    from: node(r.routeKeyLow, coords, "route_key_low"),
    to: node(r.routeKeyHigh, coords, "route_key_high"),
    seats: r.seats,
    departures: r.departures,
    loadFactor: ratio(r.passengers, r.seats),
  }));

  // TWO INDEPENDENT DERIVATIONS, compared. `drawnRoutes` comes from the cap arithmetic;
  // `segments.length` comes from the slice that was actually taken. Writing
  // `drawnRoutes = segments.length` would make this check unfalsifiable, which is not a check.
  //
  // The producer owns it because the renderer deliberately does not throw on the served path
  // and nothing else can see it: `drawnRoutes` is the numerator of a sentence a visitor reads
  // ("Showing the N largest routes by seats of M"), so a value disagreeing with the number of
  // segments handed over renders a FALSE claim rather than a wrong-looking one. It fires if
  // the slice bound and the cap arithmetic ever drift apart -- a `slice(0, NETWORK_ARC_CAP)`
  // under a caller-supplied `limit`, or a segment dropped during the map.
  const drawnRoutes = Math.min(routes.length, limit);
  if (drawnRoutes !== segments.length) {
    throw new Error(
      `fetchCarrierTypeNetwork: drawnRoutes ${drawnRoutes} disagrees with ${segments.length} ` +
        "segments -- the disclosure line would state a count the map does not draw.",
    );
  }

  return {
    segments,
    window: `${timeFrom} → ${timeTo}`,
    drawnRoutes,
    // The TRUE count before the cap, which is the whole reason this file fetches past it.
    // Returning `segments.length` here makes the disclosure read "400 of 400".
    totalRoutes: routes.length,
    sameAirportSeats,
  };
}
