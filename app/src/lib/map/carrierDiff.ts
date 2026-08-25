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
  /** Per category. Null when this carrier filed no same-airport pair in that category. */
  same_airport_seats: number | null;
  /** Carrier-wide, identical on every row: routes no category could reach because a window was
   *  wholly quarantined. */
  undrawable_routes: number;
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
 * so: 3,640 of 5,959 dropped carrier-routes (61.1%) had a DIFFERENT carrier flying the same pair
 * inside the trailing window, and 4,608 of 8,357 added ones (55.1%) had one inside the prior
 * window. "Added" is re-entry, not first appearance -- 4,691 of 8,357 (56.1%) had filed that pair
 * before the prior window. `map_carrier_diff.sql`'s header states each of these with the exact
 * predicate that produced it; take page copy from there, not from issue #109, whose per-carrier
 * table has the dropped and added labels swapped.
 *
 * THE PANELS DO NOT SHARE A RANKING KEY. Added and dropped rank on seats, because seats is the
 * magnitude of what those labels claim. Downgauged ranks on the FALL IN GAUGE, because seats is
 * orthogonal to what that label claims -- ranking it by seats drew the smallest downgauges and
 * cut the largest. #110's disclosure for that panel must name its key: "400 of 584" alone reads
 * as the largest 400 routes, which is not what the cut selects.
 *
 * ONLY NON-EMPTY CATEGORIES ARE RETURNED, so this is a 0-to-3 length array in
 * `DIFF_CATEGORIES` order. That is `fetchAirportNetwork`'s rule -- no panel rather than an empty
 * panel -- and it is live, not theoretical: 26 of the 66 carriers with any change at all have at
 * least one empty category, and ZW has 92 dropped, 0 added and 0 downgauged. A caller rendering a
 * fixed three-panel layout must handle a missing category.
 *
 * `asOf` is checked, not used to compute: the windows are derived inside the SQL from
 * `fct_route_month`'s own `max(year_month)`, verbatim the expression `mart_route_health` uses. A
 * mismatch throws rather than serving a map whose window line disagrees with the page's DATA AS
 * OF badge -- the disagreement `lib/entityFacts.ts` exists to make structurally impossible for
 * the entity pages.
 *
 * THAT GUARD IS ROW-CONDITIONAL, and deliberately so rather than by oversight. The month it
 * checks against is read off the query's own rows, so a carrier with no categorized route --
 * 48 of the 114 codes `sitemap_carriers.sql` emits, since 66 carriers have at least one -- gets
 * `[]` without the check running. It rests on soundness, not on cost: the failure it prevents is
 * a window line disagreeing with the badge, and a carrier with no panel renders no window line,
 * so there is nothing that could disagree. (An earlier revision justified it as "a second query
 * on the majority of carrier pages"; 48 of 114 is 42%, so that argument was false and is not the
 * reason.) What it leaves open is narrow and worth naming: a caller asking for a window this
 * query does not serve gets `[]` for an empty carrier rather than a refusal, which reads as "no
 * change in the window you asked for". `refuses an asOf...` and `does NOT check asOf...` in
 * `carrierDiff.test.ts` pin both halves, so it stays a stated property rather than an accident.
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

  // Grouped in arrival order, which the query has already sorted by each category's OWN ranking
  // key with a total-order tiebreak -- seats for added and dropped, GAUGE FALL for downgauged.
  // So `segments[0]` is the largest of whatever that panel ranks on, which on a downgauged panel
  // is NOT the heaviest arc: OO leads with ATW-SBN at 50 seats over 4 departures while its widest
  // drawn arc is three orders of magnitude bigger. Anything writing "the biggest" about a panel
  // must name which quantity. `arcOrder` still imposes its own thinnest-first stroke order
  // downstream; this order is the ranking, not the draw order.
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
    const segments = bucket.map(toSegment);
    // `drawnRoutes` is NOT an input any more (A6): the renderer derives the drawn count from
    // `drawableSegments(segments).length`, because a caller-supplied count that must equal a
    // derived one can only ever be wrong -- it produced an aria-label carrying two different
    // counts of one quantity. The invariant is still worth asserting HERE, though, where both
    // halves are knowable: the SQL cut this panel at `$cap` and the window function counted the
    // same partition before that cut, so if they ever disagree the disclosure "N of M" is built
    // on a cut nobody can reproduce. Caught mutant 12b -- an off-by-one between the QUALIFY's
    // `<= $cap` and this arithmetic.
    const expectedDrawn = Math.min(head.category_total, cap);
    if (expectedDrawn !== segments.length) {
      throw new Error(
        `fetchCarrierDiff: ${category} panel cut ${segments.length} segments where the ` +
          `pre-cap total ${head.category_total} against cap ${cap} implies ${expectedDrawn} -- ` +
          "the query's QUALIFY and this arithmetic have drifted apart",
      );
    }
    out.push({
      category,
      window: `${head.window_start_month} → ${head.window_end_month}`,
      map: {
        segments,
        window: `${head.window_start_month} → ${head.window_end_month}`,
        // The TRUE count before the cap, straight off `count(*) OVER (PARTITION BY category)`,
        // which the query computes before its QUALIFY filters. Never `segments.length` -- that
        // is the capped count, and it makes the disclosure line read "400 of 400".
        totalRoutes: head.category_total,
        // Routes no category could reach because a window was wholly quarantined -- absent from
        // `segments` and from `totalRoutes` alike, so without this they leave no trace at all.
        //
        // CARRIER-WIDE, not per-panel, and unavoidably so: an uncategorized route has no category
        // to be counted under, and attributing it to one would be inventing the very fact the
        // quarantine destroyed. The consequence for #110 is that ALL THREE panels of one carrier
        // carry the SAME number -- 8V's three each say 16, the same 16 -- so a reader summing the
        // small multiple gets 48. It belongs in a page-level disclosure, next to the one the SQL
        // header already hands over for the 5 carrier-category pairs whose only member is a
        // same-airport pair. Rendering it per panel face-value triple-counts it.
        //
        // NOTE the contract text at segmentMap.ts says "every filing behind them was
        // quarantined". True of #105's 34; NOT true of these 25, where ONE window is wholly
        // quarantined and the other can be clean -- 8V BTI-VEE has 8 clean prior-window
        // departures. Both are "could not be drawn because quarantine destroyed what decides
        // them", which is the property the field actually carries.
        quarantinedRoutes: head.undrawable_routes,
        // Seats on pairs whose two endpoints are the same airport: never an arc, never in
        // `totalRoutes`, but disclosed rather than lost. REQUIRED, and an explicit 0 when the
        // carrier filed none in this category -- the field's own contract says to pass 0 rather
        // than omit, because an omitted optional disclosure is the failure it exists to prevent.
        // The SQL returns NULL for "no same-airport pair here"; 0 is the honest rendering of
        // that at this boundary, since the question the field answers is "how many seats are
        // being withheld from the arcs", and the answer is none.
        sameAirportSeats: head.same_airport_seats ?? 0,
      },
    });
  }
  return out;
}
