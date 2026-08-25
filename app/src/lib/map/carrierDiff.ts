import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, demoteBigInts } from "@/lib/db";
import { NETWORK_ARC_CAP, type GeoNode, type SegmentDatum, type SegmentMapInput } from "./segmentMap";

// Same anchor, same reason, as db.ts's ROOT / airportNetwork.ts's QUERIES_DIR: process.cwd() is
// correct in production; Vitest gets UPGAUGE_ROOT from vitest.config.ts's setupFiles.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

/** What one carrier did to a route pair between the prior 12 months and the trailing 12.
 *
 * Three categories, MUTUALLY EXCLUSIVE by construction rather than by three filters agreeing --
 * `sql/03_queries/map_carrier_diff.sql` assigns them in a single CASE whose arms are the disjoint
 * cells of a two-boolean truth table, so no carrier-route can reach two of them. */
export type DiffCategory = "added" | "dropped" | "downgauged";

/** The panel order, and it is the ENCODING, not a presentation detail: the diff map spends
 * position on category because `arcs.ts` has already spent width on seats, dash on load factor
 * and dotted-muted on the departure floor. One owner for that order, so the surface rendering the
 * panels does not carry a second copy of it that can drift. */
export const DIFF_CATEGORIES: readonly DiffCategory[] = ["added", "dropped", "downgauged"];

export interface CarrierDiff {
  category: DiffCategory;
  /** The window THIS category's seats come from -- trailing for added and downgauged, prior for
   * dropped. Read off the query's own row, never re-derived from `asOf`, so the label and the
   * data cannot disagree. It is also why panels do not share a seat ramp: an added route's seats
   * and a dropped route's are two denominators, and one width scale across both would look
   * comparable without being comparable. */
  window: string;
  map: SegmentMapInput;
}

/** One row of `map_carrier_diff.sql`. `from_*`/`to_*` are LEFT-JOINed, so any of them can be null
 * -- see `toSegment`, which refuses rather than rendering a dash. */
interface DiffRow {
  category: string;
  window_start_month: string;
  window_end_month: string;
  dataset_end_month: string;
  route_key_low: number;
  route_key_high: number;
  from_code: string | null;
  from_lat: number | null;
  from_lon: number | null;
  to_code: string | null;
  to_lat: number | null;
  to_lon: number | null;
  seats: number;
  departures: number;
  load_factor: number | null;
  category_total: number;
}

function isDiffCategory(value: string): value is DiffCategory {
  return (DIFF_CATEGORIES as readonly string[]).includes(value);
}

/** Both endpoints of one row, or a throw. `map_carrier_diff.sql` LEFT JOINs `dim_airport` so an
 * unresolvable endpoint arrives as null instead of silently removing the row from a result whose
 * `category_total` already counted it. Every endpoint here came from a fact row, and lat/lon are
 * NOT NULL for all fact-present airports (map_airport_coords.sql), so this is the same fail-loud
 * airportNetwork.ts's `toArcDatum` has: a resolution gap is reported, never rendered as a dash. */
function node(code: string | null, lat: number | null, lon: number | null, airportId: number): GeoNode {
  if (code === null || lat === null || lon === null) {
    throw new Error(
      `fetchCarrierDiff: no coordinates resolved for airport_id ${airportId} -- ` +
        "dim_airport's is_latest row is missing or carries no lat/lon, and the fact-presence " +
        "assumption map_airport_coords.sql documents no longer holds",
    );
  }
  return { code, lat, lon };
}

/** `from` is always the LOW airport id and `to` the high, so two runs over the same data emit the
 * same endpoint order. The pair is undirected -- T-100 files each direction separately and this
 * query groups on `route_key_low`/`route_key_high` -- so which end is drawn first is a
 * determinism choice, not a claim about direction of travel. */
function toSegment(row: DiffRow): SegmentDatum {
  return {
    from: node(row.from_code, row.from_lat, row.from_lon, row.route_key_low),
    to: node(row.to_code, row.to_lat, row.to_lon, row.route_key_high),
    seats: row.seats,
    departures: row.departures,
    loadFactor: row.load_factor,
  };
}

/**
 * What `airlineId` added, dropped and downgauged between the prior 12 months and the trailing 12,
 * as one `SegmentMapInput` per category.
 *
 * EVERY ROW IS A CARRIER-ROUTE PAIR, NEVER A ROUTE, and the copy rendering these panels has to say
 * so: 3,638 of 5,959 dropped carrier-routes (61.1%) had a DIFFERENT carrier flying the same pair
 * inside the trailing window, and 4,608 of 8,357 added ones (55.1%) had one inside the prior
 * window. "Added" is re-entry, not first appearance -- 4,690 of 8,357 (56.1%) had filed that pair
 * before the prior window. `map_carrier_diff.sql`'s header carries every one of these
 * measurements and the query that produced it; take page copy from there, not from issue #109,
 * whose per-carrier table has the dropped and added labels swapped.
 *
 * ONLY NON-EMPTY CATEGORIES ARE RETURNED, so this is a 0-to-3 length array in
 * `DIFF_CATEGORIES` order. That is `fetchAirportNetwork`'s rule -- no panel rather than an empty
 * panel -- and it is live, not theoretical: 33 of the 66 carriers with any change at all have at
 * least one empty category, and ZW has 92 dropped, 0 added and 0 downgauged. A caller rendering a
 * fixed three-panel layout must handle a missing category.
 *
 * `asOf` is checked, not used to compute: the windows are derived inside the SQL from
 * `fct_route_month`'s own `max(year_month)`, verbatim the expression `mart_route_health` uses. A
 * mismatch throws rather than serving a map whose window line disagrees with the page's DATA AS
 * OF badge -- the disagreement `lib/entityFacts.ts` exists to make structurally impossible for
 * the entity pages.
 */
export async function fetchCarrierDiff(
  airlineId: number,
  asOf: string,
  cap: number = NETWORK_ARC_CAP,
): Promise<CarrierDiff[]> {
  const statement = readFileSync(path.join(QUERIES_DIR, "map_carrier_diff.sql"), "utf8");
  const con = await connect();
  const prepared = await con.prepare(statement);
  prepared.bind({ airline_id: airlineId, cap });
  const result = await prepared.run();
  const rows = (await result.getRowObjects()).map(
    (r) => demoteBigInts(r) as unknown as DiffRow,
  );
  if (rows.length === 0) return [];

  const datasetEnd = rows[0].dataset_end_month;
  if (datasetEnd !== asOf) {
    throw new Error(
      `fetchCarrierDiff: called with asOf '${asOf}' but fct_route_month's latest month is ` +
        `'${datasetEnd}'. The windows come from the fact table, so serving this would put a ` +
        "window line on the map that disagrees with the page's DATA AS OF badge.",
    );
  }

  // Grouped in arrival order, which the query has already sorted by seats DESC with a
  // deterministic tiebreak inside each category -- so the panel draws heaviest-first over the
  // same routes on every run, and `arcOrder` still gets to impose its own thinnest-first
  // stroke order downstream.
  const byCategory = new Map<DiffCategory, DiffRow[]>();
  for (const row of rows) {
    if (!isDiffCategory(row.category)) {
      throw new Error(
        `fetchCarrierDiff: map_carrier_diff.sql returned category '${row.category}', which is ` +
          `not one of ${DIFF_CATEGORIES.join(", ")}`,
      );
    }
    const bucket = byCategory.get(row.category);
    if (bucket === undefined) byCategory.set(row.category, [row]);
    else bucket.push(row);
  }

  // DIFF_CATEGORIES order, not the query's ORDER BY, which is alphabetical and puts downgauged
  // second. Position is the category encoding, so the order is semantic and belongs to this
  // module rather than to a collation.
  const out: CarrierDiff[] = [];
  for (const category of DIFF_CATEGORIES) {
    const bucket = byCategory.get(category);
    if (bucket === undefined) continue;
    const head = bucket[0];
    out.push({
      category,
      window: `${head.window_start_month} → ${head.window_end_month}`,
      map: {
        segments: bucket.map(toSegment),
        window: `${head.window_start_month} → ${head.window_end_month}`,
        drawnRoutes: bucket.length,
        // The TRUE count before the cap, straight off `count(*) OVER (PARTITION BY category)`,
        // which the query computes before its QUALIFY filters. Never `bucket.length` -- that is
        // the capped count, and it makes the disclosure line read "400 of 400".
        totalRoutes: head.category_total,
      },
    });
  }
  return out;
}
