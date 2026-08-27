import { runPivot } from "@/lib/db";
import type { PivotQuery } from "@/lib/pivot/types";
import { fetchCoords, type AirportCoords } from "./airportNetwork";
import {
  NETWORK_ARC_CAP,
  drawableSegments,
  type GeoNode,
  type SegmentDatum,
  type SegmentMapInput,
} from "./segmentMap";

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
  /** Ranked, same-airport pairs removed, floor applied, quarantined groups removed. */
  routes: DrawableRoute[];
  /** Seats on same-airport groups that passed the floor -- kept out of `routes`, disclosed by
   * the renderer's footer rather than dropped. */
  sameAirportSeats: number;
  /** Groups whose every filing was quarantined, so their sums are NULL. Not drawable, and NOT
   * in `totalRoutes` -- they are their own disjoint category with their own sentence, never
   * folded into the drawable denominator. Surfaced, never dropped without trace. */
  quarantinedRoutes: number;
  /** How many same-airport groups contributed to `sameAirportSeats`. Carried SEPARATELY from
   * the seat total so the null rule can ask "is this category empty?" without inferring it from
   * a measure. Gating on `sameAirportSeats === 0` instead would be correct only by way of an
   * invariant in another file -- `normalize_t100_segment.sql:81` quarantines
   * `seats = 0 AND departures_performed > 0`, so a group clearing the floor always has seats
   * (verified across the whole dataset: 129,502 groups, zero with departures and no seats).
   * Should that quarantine rule ever narrow, a same-airport-only view that flew with zero filed
   * seats would return no map at all -- this category's version of the bug `quarantinedRoutes`
   * exists to prevent. A count costs one integer and depends on nothing outside this file. */
  sameAirportRoutes: number;
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
 * exceed 400 have a seats tie at `row_number() = 400`. The widest is `OH` x type `638` with 232
 * pairs tied at 76.0 seats, then `9E` x `638` (228), `OO` x `629` (223), `OO` x `530` (211);
 * `DL` x `614`, this file's fixture, is sixth with 164 tied at exactly 160.0. Every figure is
 * measured on the DRAWABLE population this comparator ranks -- quarantined and same-airport
 * groups already removed. "Top 400" is
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
 * NULL AND ZERO ARE DIFFERENT FACTS, and this function's shape follows from that. Every measure
 * is a FILTERed sum (`301_meta_pivot_measures.sql:22-24`), so a group arrives in one of two
 * very different states:
 *
 *   departures IS NULL  every filing on the pair was quarantined, so the sums are unknowable --
 *                       NOT zero. Measured over the trailing 12 at this grain: 34 such groups,
 *                       every one of which PERFORMED departures before quarantine, and every
 *                       one quarantined `zero_seats` -- a passenger aircraft flew and filed a
 *                       seat count of zero. THEY FLEW. Counted in `quarantinedRoutes` and
 *                       surfaced, never silently discarded.
 *   departures = 0      the pair was filed and genuinely not flown -- 23 such groups. Neither
 *                       drawn nor counted: an arc would claim service that did not operate, and
 *                       the carrier did not serve the pair, so it is not a route it flew.
 *
 * Collapsing the two into one `departures <= 0` branch reads their NULL as zero, which is the
 * coercion `CarrierTypeRouteRow` above forbids, and describes 34 pairs that flew as pairs that
 * did not.
 *
 * THE FLOOR is group-level, never row-level, and that is a deliberate trade: a row-level filter
 * would drop a never-flown MONTH from a pair that flew in other months, making this map's seat
 * figures disagree with `/explore`'s for the identical filter set -- and every insight row on
 * this site is one click from the raw rows that produced it.
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
  let sameAirportRoutes = 0;
  let quarantinedRoutes = 0;

  for (const row of rows) {
    const departures = row.departures_performed ?? null;
    const seats = row.seats ?? null;
    const passengers = row.passengers ?? null;

    // SAME-AIRPORT FIRST, and the order is load-bearing. A filing whose two endpoints are one
    // airport is not a route the carrier served, whatever its quarantine state, so it must not
    // reach `quarantinedRoutes` -- which counts route PAIRS and feeds a sentence about them.
    // Measured over the trailing 12: exactly one such group is also fully quarantined (`8V` x
    // `416`), and counting it made one of that view's ten "quarantined route pairs" a pair with
    // one endpoint. Its sums are NULL, so there is no seat figure to preserve and nothing is
    // lost by dropping it; what would be lost by keeping it is the meaning of the count.
    //
    // A same-airport pair that FLEW still contributes its seats, below -- that branch sits
    // under the floor, so one that never flew contributes nothing.
    if (row.route_key_low === row.route_key_high && (row.departures_performed ?? null) === null) {
      continue;
    }

    if (departures === null || seats === null || passengers === null) {
      // ONE null means ALL null: the three measures carry the IDENTICAL quarantine FILTER, so
      // they go null together or not at all. Asserted rather than assumed -- were that FILTER
      // ever dropped from one measure and not the others, the mismatch would otherwise surface
      // as a silently wrong seat figure instead of a stack trace. This is the branch that would
      // fire, and it is why the check sits HERE and not after the floor, where a partially-null
      // group could never reach it.
      if (departures !== null || seats !== null || passengers !== null) {
        throw new Error(
          `drawableRoutes: route ${row.route_key_low}-${row.route_key_high} for airline ` +
            `${airlineId} x type '${aircraftTypeCode}' has a PARTIALLY null measure sum ` +
            `(departures=${departures}, seats=${seats}, passengers=${passengers}) -- the three ` +
            "measures no longer share one quarantine FILTER.",
        );
      }
      // Every filing quarantined: untrustworthy, NOT unflown. Surfaced rather than dropped.
      // Same-airport filings never reach here -- the branch above takes them -- so this counts
      // route pairs only, which is what its name and the sentence built from it both claim.
      quarantinedRoutes += 1;
      continue;
    }

    // Filed, genuinely not flown. Neither drawn nor counted -- the carrier did not serve this
    // pair on this type, so it is not part of the network the disclosure describes.
    if (departures <= 0) continue;

    // BELOW the floor deliberately: a same-airport pair that never flew contributes no seats.
    // Hoisting this branch above it is a real mutant -- those seats would reach the footer --
    // so the fixture guarding the order carries seats AND zero departures, never zero seats.
    if (row.route_key_low === row.route_key_high) {
      sameAirportSeats += seats;
      sameAirportRoutes += 1;
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
  return { routes, sameAirportSeats, sameAirportRoutes, quarantinedRoutes };
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

/** True when a view has nothing to draw AND nothing to disclose -- the only shape that earns no
 * panel at all.
 *
 * ALL THREE CATEGORIES, each asked its own question. Any one of them alone justifies a map:
 * drawable routes get arcs; fully-quarantined pairs get a count and a reason, without which the
 * reader is told nothing about them at all; same-airport filings get their seats. Gating on
 * `totalRoutes` alone suppresses the second and third, which is the bug their fields exist to
 * prevent -- and gating same-airport on `sameAirportSeats` rather than `sameAirportRoutes`
 * outsources the question to a quarantine rule in another file (see `DrawableView`).
 *
 * EXPORTED so both of those can be driven directly. Neither is reachable through
 * `fetchCarrierTypeNetwork` against today's warehouse -- a same-airport group that flew always
 * has seats -- so a test that could only go through the live path could not tell the two gates
 * apart. Same precedent as `drawableRoutes` and `segmentsForDrawing` above. */
export function hasNothingToShow(view: DrawableView): boolean {
  return view.routes.length === 0 && view.quarantinedRoutes === 0 && view.sameAirportRoutes === 0;
}

/** Assemble the capped routes into segments, and refuse to hand over a set the renderer would
 * draw a different number of.
 *
 * TWO INDEPENDENT DERIVATIONS, compared. `expected` is the caller's cap arithmetic; the check
 * counts `drawableSegments(segments)` -- what `renderSegmentMap` will actually draw from this
 * same array, by the renderer's own function, the one that also words its `aria-label`.
 * Comparing against `segments.length` instead would make the check unfalsifiable, because
 * `segments` is built by mapping over a slice and is equal to it by construction.
 *
 * The reachable trigger is a segment whose two endpoints resolve to ONE CODE while carrying
 * two different airport_ids. `drawableRoutes` excludes same-ID pairs, which is NOT the same
 * guarantee: 37 codes in `dim_airport` (is_latest) are carried by more than one airport_id.
 * None of those collisions is fact-present today, so the map cannot currently produce one --
 * but a code that starts colliding in a future rebuild would otherwise ship a disclosure line
 * counting a route the renderer silently declines to draw.
 *
 * EXPORTED for that test, and for no other caller. The precedent is `drawableRoutes` above:
 * a pure function extracted so an invariant of the impure entry point can be driven directly. */
export function segmentsForDrawing(
  drawn: DrawableRoute[],
  coords: Map<number, AirportCoords>,
  expected: number,
): SegmentDatum[] {
  const segments: SegmentDatum[] = drawn.map((r) => ({
    from: node(r.routeKeyLow, coords, "route_key_low"),
    to: node(r.routeKeyHigh, coords, "route_key_high"),
    seats: r.seats,
    departures: r.departures,
    loadFactor: ratio(r.passengers, r.seats),
  }));

  const drawable = drawableSegments(segments).length;
  if (expected !== drawable) {
    throw new Error(
      `segmentsForDrawing: cap arithmetic says ${expected} routes but the renderer would draw ` +
        `${drawable} of the ${segments.length} segments handed over -- the disclosure line ` +
        "would state a count the map does not draw.",
    );
  }
  return segments;
}

/** The carrier x aircraft-type network map's data: one segment-grain `runPivot` plus one
 * `map_airport_coords.sql` lookup for the endpoints of the routes actually drawn.
 *
 * `limit` is the DRAW cap, not the query's LIMIT -- the two are different numbers and the
 * signatures keep them apart deliberately. The query is issued at NETWORK_FETCH_CEILING so the
 * whole view is present to be counted; `limit` then decides how much of it is drawn.
 *
 * RETURNS NULL ONLY WHEN THERE IS NOTHING TO SAY -- which is narrower than "nothing to draw",
 * and the difference is the point. Null means: no filing in the window, or nothing left after
 * every category is accounted for. A view with zero drawable routes still returns a MAP when it
 * has something to disclose:
 *
 *   `F4` x `489`  three pairs, every filing on all three quarantined -> a map with zero
 *                 segments, `totalRoutes: 0` and `quarantinedRoutes: 3`. The reader is told the
 *                 count and the reason, instead of being shown nothing at all.
 *   `8E` x `340`  one same-airport filing carrying 5 seats -> a map with zero segments and
 *                 `sameAirportSeats: 5`.
 *
 * A caller must therefore handle a non-null input whose `segments` is empty. `fetchAirportNetwork`
 * gates on `rows.length === 0` for the same reason: "no drawable arcs" is a different question
 * from "nothing filed".
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
  // Mirrors `render.ts:141-143`, which rejects a non-positive limit rather than emitting one.
  // A zero or negative cap here would slice to nothing and return the empty panel this module
  // exists to refuse, wearing a `totalRoutes` that says the routes are there. No caller passes
  // one today; that is a reason to state the rule, not to leave it to chance.
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`fetchCarrierTypeNetwork: limit must be a positive integer, got ${limit}`);
  }

  const result = await runPivot(
    carrierTypeNetworkQuery(airlineId, aircraftTypeCode, timeFrom, timeTo, NETWORK_FETCH_CEILING),
  );
  const rows = result.rows as unknown as CarrierTypeRouteRow[];
  const view = drawableRoutes(rows, airlineId, aircraftTypeCode);
  const { routes, sameAirportSeats, quarantinedRoutes } = view;

  // The null rule NAMES ALL THREE CATEGORIES, and must. `totalRoutes` counts drawable routes
  // only, so gating on it alone would return null for a view whose every pair is quarantined
  // (`F4` x `489`) or whose only filing is same-airport (`8E` x `340`) -- suppressing exactly
  // the disclosures the other two fields exist to carry. Each category independently justifies
  // a map; only all three empty means there is nothing to say.
  //
  // A view where everything filed was genuinely never flown also lands here, and that arm has
  // real fixtures rather than being stated for the case: `DL` x `650` over 2015 is five pairs,
  // every one of them zero seats on zero performed departures. The window is a caller-supplied
  // parameter, so a view being unreachable in the trailing 12 does not make it unreachable.
  //
  // Same-airport is gated on its COUNT, never on `sameAirportSeats` -- see `sameAirportRoutes`.
  const totalRoutes = routes.length;
  if (hasNothingToShow(view)) return null;

  const drawn = routes.slice(0, limit);
  const coords = await fetchCoords([
    ...drawn.map((r) => r.routeKeyLow),
    ...drawn.map((r) => r.routeKeyHigh),
  ]);

  const segments = segmentsForDrawing(drawn, coords, Math.min(routes.length, limit));

  return {
    segments,
    window: `${timeFrom} → ${timeTo}`,
    // The TRUE count of DRAWABLE routes before the cap, which is the whole reason this file
    // fetches past it. Returning `segments.length` makes the disclosure read "400 of 400".
    //
    // Quarantined pairs are NOT in here. `totalRoutes - drawn`
    // has to be purely the routes the cap elided, every one of them genuinely smaller, or the
    // sentence built from it mixes two unrelated exclusions and becomes false -- on `8V` x
    // `035`, "14 smaller routes are not drawn" about 14 pairs that are quarantined, not
    // smaller. Three disjoint categories, three sentences, no arithmetic across them:
    // `totalRoutes` counts what is drawable, `quarantinedRoutes` gets its own, and
    // `sameAirportSeats` gets its own.
    totalRoutes,
    sameAirportSeats,
    quarantinedRoutes,
  };
}
