import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, demoteBigInts } from "@/lib/db";
import { numOrNull } from "@/lib/nullSum";
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

/** The DISPLAY vocabulary for those categories, owned here beside the order for the same reason
 * the order is owned here: so the surface rendering the panels does not carry a second copy that
 * can drift from the one the producer writes into `SegmentMapInput.title`.
 *
 * Short on purpose. `title` is PAINTED INTO THE SVG on its own footer row and cannot wrap
 * (segmentMap.ts) -- these are nowhere near the ~158-character ceiling, and nothing longer
 * belongs in this table. */
export const DIFF_CATEGORY_LABELS: Record<DiffCategory, string> = {
  added: "Added",
  dropped: "Dropped",
  downgauged: "Downgauged",
};

/** The carrier-qualified caption a PAGE puts on one panel, e.g. `AS added`.
 *
 * WHY the page needs a different string from the bare label the producer sets: `renderSegmentMap`
 * composes the map's whole accessible name as `${title}. Route map, ${window}.` plus
 * `arcsSentence`, and `arcsSentence` emits "225 routes drawn" -- shared #104 copy, correctly
 * uncarrier-qualified because the hub map uses it too. A screen-reader user reaching
 * `role="img"` by graphic navigation never sees the section heading above it, so a bare "Added"
 * leaves the map announcing a COUNT that does not name the carrier. This grain is
 * (op_airline_id, route): a count that does not name the carrier is a claim the query never
 * made, and /watch/new-routes is what that costs. The fix is one word, in the one field that
 * reaches the accessible name.
 *
 * Built from DIFF_CATEGORY_LABELS rather than from a second literal, so the vocabulary still has
 * exactly one owner and this is a refinement of it rather than a duplicate of it. */
export function diffPanelTitle(carrierCode: string, category: DiffCategory): string {
  return `${carrierCode} ${DIFF_CATEGORY_LABELS[category].toLowerCase()}`;
}

/** What `fetchCarrierDiff` returns.
 *
 * `quarantinedRoutes` sits HERE and not on a panel because it is a CARRIER-WIDE quantity: a route
 * excluded because the window deciding it was wholly quarantined has no category -- that is what
 * being excluded means -- so there is no panel it belongs to. Putting it on each panel, which an
 * earlier revision did to satisfy `SegmentMapInput`'s required field, stated 8V's same 16 routes
 * three times over, and a reader summing the small multiple got 48. Each panel now carries 0,
 * which is true of it (`quarantinedNote` renders nothing at 0), and the real count is stated once
 * by whatever renders the section.
 *
 * `panels` is 0-to-3 entries in `DIFF_CATEGORIES` order; `quarantinedRoutes` is meaningful even
 * when `panels` is empty, which is the whole reason this is a record rather than an array. F4
 * (21615) is exactly that carrier: 3 undrawable carrier-routes and no drawable arc at all. */
export interface CarrierDiffResult {
  panels: CarrierDiff[];
  quarantinedRoutes: number;
}

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
export interface DiffRow {
  /** NULL on the anchor row a carrier with no drawable arc returns. Never NULL on an arc row --
   *  `panel` filtered `category IS NOT NULL` before the join, so this cannot collide with data. */
  category: string | null;
  window_start_month: string;
  window_end_month: string;
  dataset_end_month: string;
  /** Carrier-wide, identical on every row including the anchor. */
  undrawable_routes: number;
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
  /** The downgauged panel's ranking key, in seats per departure. NULL on added and dropped. */
  gauge_fall: number | null;
  category_total: number;
  /** Per category. Null when this carrier filed no same-airport pair in that category. */
  /** How many same-airport pairs this category has. NULL only when the LEFT JOIN missed, i.e.
   *  it has none -- which is what tells `same_airport_seats`'s NULL apart from a wholly
   *  quarantined one (sql/03_queries/map_carrier_diff.sql, `same_airport` CTE). */
  same_airport_pairs: number | null;
  same_airport_seats: number | null;
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
    // The downgauged panel is cut and ordered by gauge fall, which no arc channel encodes -- so
    // the value travels with the segment rather than being implied by its position. Null on
    // added and dropped, which rank on `seats`, a field the segment already carries.
    rankedBy: row.gauge_fall,
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
 * THAT GUARD IS UNCONDITIONAL, which it was not until the query grew its anchor row. The month
 * is now read off a row that always exists rather than off an arc, so it is checked for every
 * carrier -- including the 48 of 114 codes `sitemap_carriers.sql` emits that have no drawable arc
 * at all. Two earlier revisions justified skipping those: one on a cost that was never real
 * ("a second query on the majority of carrier pages" -- 48 of 114 is 42%), one on the sound but
 * narrower ground that a carrier with no panel renders no window line. Neither is needed now, and
 * the residual they left open -- a caller asking for a window this query does not serve being
 * told `[]` rather than refused -- is closed.
 */
export async function fetchCarrierDiff(
  airlineId: number,
  asOf: string,
  cap: number = NETWORK_ARC_CAP,
): Promise<CarrierDiffResult> {
  const statement = readFileSync(path.join(QUERIES_DIR, "map_carrier_diff.sql"), "utf8");
  const con = await connect();
  const prepared = await con.prepare(statement);
  prepared.bind({ airline_id: airlineId, cap });
  const result = await prepared.run();
  const rows = (await result.getRowObjects()).map(
    (r) => demoteBigInts(r) as unknown as DiffRow,
  );
  // The query returns an anchor row unconditionally, so this cannot be empty and the two carrier-
  // wide facts below are always readable -- including for a carrier with no drawable arc.
  //
  // STRUCTURALLY UNREACHABLE, and the scenario an earlier revision named for it does not produce
  // it: run against an EMPTY fct_route_month the query returns ONE row, not zero, because
  // `bounds` is a bare aggregate and `anchor` selects from `windows`. That row carries a NULL
  // `dataset_end_month`, so control reaches the asOf guard below and is refused there instead.
  // This branch can only fire if `anchor` or `windows` has been edited into something that can
  // return no rows -- which is what it should say when it fires.
  if (rows.length === 0) {
    throw new Error(
      "fetchCarrierDiff: map_carrier_diff.sql returned no rows. Its `anchor` CTE selects from " +
        "`windows`, which is one row by construction, so this is not an empty-warehouse " +
        "condition (that yields one row with a NULL dataset_end_month) -- `anchor` or `windows` " +
        "has been changed into something that can return nothing.",
    );
  }

  const datasetEnd = rows[0].dataset_end_month;
  if (datasetEnd !== asOf) {
    throw new Error(
      `fetchCarrierDiff: called with asOf '${asOf}' but fct_route_month's latest month is ` +
        `'${datasetEnd}'. The windows come from the fact table, so serving this would put a ` +
        "window line on the map that disagrees with the page's DATA AS OF badge.",
    );
  }

  return { panels: toPanels(rows, cap), quarantinedRoutes: rows[0].undrawable_routes };
}

/** The rows -> panels fold, split out of `fetchCarrierDiff` so the `sameAirportSeats` mapping
 * below can be driven with a row shape the warehouse does not currently produce (#121).
 *
 * THE EXTRACTION DOES NOT PIN THE WIRING -- `fetchCarrierDiff`'s own live tests do, since they
 * assert panel order and panel contents that only exist if this function is called. What the
 * extraction buys is the ability to hand this a head row whose same-airport pairs are ALL
 * quarantined, which no carrier on this warehouse has (measured: all 115 scanned, zero such
 * panels) and which a live fixture therefore cannot reach. */
export function toPanels(rows: DiffRow[], cap: number = NETWORK_ARC_CAP): CarrierDiff[] {
  // Grouped in arrival order, which the query has already sorted by each category's OWN ranking
  // key with a total-order tiebreak -- seats for added and dropped, GAUGE FALL for downgauged.
  // So `segments[0]` is the largest of whatever that panel ranks on, which on a downgauged panel
  // is NOT the heaviest arc: OO leads with ATW-SBN at 200 seats over 4 departures, while its
  // widest drawn arc carries 367,195 -- three orders of magnitude more. (ATW-SBN's 50 is its seats
  // PER DEPARTURE, the unit the fall is measured in, not a seat count: anything writing "the
  // biggest" about a panel must name which quantity.) `segmentMap.ts`'s `segmentOrder` still
  // imposes its own thinnest-first stroke order downstream; this order is the ranking, not the
  // draw order.
  const byCategory = new Map<DiffCategory, DiffRow[]>();
  for (const row of rows) {
    // The anchor row carries the carrier-wide counts and no arc. It is the ONLY row that can have
    // a null category, so this is a shape test rather than a data test.
    if (row.category === null) continue;
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
  const panels: CarrierDiff[] = [];
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
    // on a cut nobody can reproduce. Caught mutant 12b -- an off-by-one between the query's
    // `rn <= $cap` and this arithmetic.
    const expectedDrawn = Math.min(head.category_total, cap);
    if (expectedDrawn !== segments.length) {
      throw new Error(
        `fetchCarrierDiff: ${category} panel cut ${segments.length} segments where the ` +
          `pre-cap total ${head.category_total} against cap ${cap} implies ${expectedDrawn} -- ` +
          "the query's cap filter and this arithmetic have drifted apart",
      );
    }
    panels.push({
      category,
      window: `${head.window_start_month} → ${head.window_end_month}`,
      map: {
        segments,
        window: `${head.window_start_month} → ${head.window_end_month}`,
        // The TRUE count before the cap, straight off `count(*) OVER (PARTITION BY category)`,
        // which the query computes over the full partition before the cap filters it. Never
        // `segments.length` -- that
        // is the capped count, and it makes the disclosure line read "400 of 400".
        totalRoutes: head.category_total,
        // ZERO on every panel, and true of each: an undrawable route has no category, so no
        // route of THIS category went undrawn. The carrier-wide count is on the result record
        // instead -- see CarrierDiffResult for why it cannot live here.
        quarantinedRoutes: 0,
        // Seats on pairs whose two endpoints are the same airport: never an arc, never in
        // `totalRoutes`, but disclosed rather than lost. REQUIRED, and an explicit 0 when the
        // carrier filed none in this category -- the field's own contract says to pass 0 rather
        // than omit, because an omitted optional disclosure is the failure it exists to prevent.
        //
        // TWO CAUSES OF NULL, AND `?? 0` ANSWERED THE WRONG ONE (#121). A missing pair COUNT is
        // the LEFT JOIN missing -- no same-airport pair in this category -- and 0 is the honest
        // rendering: nothing is being withheld. A present count with NULL seats is a pair that
        // IS being withheld whose seats cannot be summed, because `fct_route_month.seats` is
        // itself `SUM(...) FILTER (WHERE NOT is_quarantined)` and every filing behind it was
        // quarantined. Rendering that as 0 told the reader nothing was withheld.
        //
        // LATENT, NOT LIVE, and the two are one measurement apart. The wholly-quarantined
        // same-airport PAIR is real (8V's VEE-VEE in the trailing 12, airline 21745's STT-STT in
        // the prior 12), but a panel folds every same-airport pair in its category together and
        // every such fold on this warehouse includes at least one stateable pair -- measured
        // across all 115 carriers with route-month rows, zero panels come back NULL. So no page
        // renders the wrong sentence today. The coercion is removed regardless: it is one refresh
        // from being live, and the SQL it reads from states the rule itself.
        sameAirportSeats: head.same_airport_pairs === null ? 0 : numOrNull(head.same_airport_seats),
        // SET HERE, not left to the consumer, because `title` is the ONLY channel into the map's
        // accessible name and without it two of these three panels announce themselves
        // IDENTICALLY: `renderSegmentMap` falls back to `Route map, ${window}.`, and added and
        // downgauged share the trailing window. The only thing left separating them would be
        // position -- which DIFF_CATEGORIES is already spending on category. A consumer that
        // hands `panel.map` straight to `renderSegmentMap` now gets three distinct captions and
        // three distinct accessible names without knowing this was ever a hazard.
        //
        // A PAGE should refine this with `diffPanelTitle(code, category)` -- see its docstring
        // for why the carrier has to reach the accessible name. This is the floor, not the
        // ceiling: the bare label is what is true without a carrier code, which is all this
        // function is given.
        title: DIFF_CATEGORY_LABELS[category],
      },
    });
  }
  return panels;
}
