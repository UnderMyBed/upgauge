import type { PivotResult } from "@/lib/db";
import { displayValue, resolutionKey, type Resolved } from "@/lib/resolve";

/** One filter link under a point-to-point map. `value` is what goes in the query string;
 * `label` is what the reader sees; `title` is the long form behind it. */
export interface PickerOption {
  /** THE FILTER VALUE, and it is `filterValueOf`'s answer -- NEVER the row's raw dimension id.
   *
   *  The id space and the filter vocabulary are two different value spaces, and conflating them
   *  was a live defect on both pages that mount a picker. `proxy.ts:442` declares the
   *  vocabulary -- "`/carrier/:code?type=<aircraft slug>`" -- and `mapFilter.ts` admits only
   *  that: an aircraft SLUG (`ERJ-175`) or a carrier CODE (`OO`). BTS ids (`673`, `20304`) are
   *  refused on arrival. Verified live against the warehouse before the fix, not reasoned about:
   *
   *      resolveTypeFilter("673")       -> unknown  "unknown aircraft type '673'"
   *      resolveTypeFilter("ERJ-175")   -> ok, id "673"
   *      resolveCarrierFilter("20304")  -> unknown
   *      resolveCarrierFilter("OO")     -> ok, id 20304
   *
   *  and it was EVERY option on EVERY page, not an edge case: zero of `dim_aircraft_type`'s
   *  short names are bare numerics, so no id has ever resolved as a slug.
   *
   *  `selected` is compared against THIS, for the same reason -- an id-valued `value` against a
   *  slug-valued selection marks nothing current, so no picker ever showed which view you were
   *  looking at. */
  value: string;
  /** What the reader sees -- `displayValue`'s answer, so "CRJ-700" for an aircraft type and
   *  the carrier CODE ("OO") for an airline id. Never the raw BTS id when the dimension
   *  resolved. */
  label: string;
  /** The full designation behind `label` ("CANADAIR RJ-700", "SkyWest Airlines"), or null when
   *  the dimension did not resolve. `MapPicker` hangs an `<abbr title>` on it, which is exactly
   *  what `DataTable`'s `DimensionCell` already does for every resolved id in this app
   *  (`DataTable.tsx:73-77`) -- a picker whose only label is "OO" is opaque, and the name is
   *  already in the Map the page awaited, so surfacing it costs no query. */
  title: string | null;
  /** NULL IS ABSENCE, ZERO IS A MEASUREMENT (`format.ts:1`), and this field must keep them
   *  apart. `seats` is `SUM(seats) FILTER (WHERE NOT is_quarantined)`
   *  (`301_meta_pivot_measures.sql:23`), and a SUM over zero passing rows returns NULL, not 0 --
   *  so a group whose every filing was quarantined arrives here with NULL. `?? 0` would turn
   *  that into a seat total of zero: a measurement claim about data that is absent, rendered on
   *  the page and sorted as though the type flew nothing.
   *
   *  LIVE, not theoretical. `/carrier/F4` (Air Charter, Inc d/b/a Air Flamenco, airline_id
   *  21615) has exactly this over the trailing 12 to 2026-05: type `489` (5 quarantined filings)
   *  and type `201` (2), both NULL, beside type `131`'s real 24,289. `render.ts` emits no
   *  `HAVING` and no `IS NOT NULL`, so these rows reach the picker.
   *
   *  `carrierTypeNetwork.ts:180-196` reaches the identical conclusion at the route grain and is
   *  the pattern this follows; issue #114 is the same coercion left standing in
   *  `airportNetwork.ts:145-147`. */
  seats: number | null;
  href: string;
  selected: boolean;
}

/**
 * Turns the rows a page has ALREADY awaited into the map's filter links. Neither entity page
 * needs a new query for this: `/carrier`'s primary pivot groups by `aircraft_type`
 * (`carrier/[code]/page.tsx:266`) and `/aircraft`'s by `op_airline_id`
 * (`aircraft/[name]/page.tsx:139`), so each page already holds exactly the dimension the other
 * map filters on.
 *
 * `resolved` IS A `Map<string, Resolved>` KEYED BY `resolutionKey()`, never a nested
 * `{ [dim]: { [id]: label } }` object -- `db.ts:259` and `resolve.ts:402` are the two ends of
 * that contract. This is worth stating because the nested shape is the intuitive guess and it
 * FAILS SILENTLY: indexing a Map as an object yields `undefined`, `displayValue` then falls
 * back to the raw id, and every option on both pages renders "673" instead of "CRJ-700" with
 * nothing throwing and no test failing unless its fixture is a real Map. picker.test.ts builds
 * one through `resolutionKey` for that reason, and takes a second fixture straight off
 * `runPivot`.
 *
 * The label goes through `displayValue` rather than a local `hit?.code ?? raw`, because
 * `resolve.ts:38-52` is explicit that two independent copies of the three-way display contract
 * is how one of them drifts -- it has already cost this repo a fix round, where a local
 * fallback collapsed "absent from the map" and "resolved with code: null" into one branch and
 * rendered a city market's id instead of its name.
 *
 * Ordering is by seats descending and is a REAL property, not incidental: the set of options is
 * identical under a dropped sort, so picker.test.ts asserts the sequence. The tiebreak on
 * `value` is load-bearing for the same reason `segmentMap.ts` imposes one on node emission --
 * this order is a function of the DATA, never of the array a producer handed over. Since #136 the
 * pivot's own `ORDER BY` carries a tiebreak, so a query-fed caller is stable too -- that is a
 * second line of defence, not a reason to drop this one. A pure comparator is assertable with no
 * warehouse round trip and keeps the picker correct for every caller, not just that query.
 *
 * Values stay STRINGS. `AIRCRAFT_TYPE` 079 becomes 79 if int-parsed and the join breaks
 * silently (CLAUDE.md, Data gotchas).
 *
 * A NULL-SEAT OPTION IS STILL OFFERED, deliberately. `fetchCarrierTypeNetwork` returns a real
 * map for such a group rather than null -- `carrierTypeNetwork.ts:429-442` names `F4` x `489` as
 * the case its three-category rule exists for, because gating on `totalRoutes` alone would
 * "suppress exactly the disclosures the other two fields exist to carry". The destination states
 * "5 quarantined routes not drawn -- failed an invariant, never clamped." Dropping the link
 * would hide that, which inverts CLAUDE.md's rule that quarantined rows are surfaced with count
 * and reason because showing the dirt is a trust feature. So the link stays and the OPTION is
 * honest about what the reader will get.
 */
export function pickerOptions(args: {
  rows: PivotResult["rows"];
  resolved: PivotResult["resolved"];
  /** The dimension key these rows are grouped by -- "aircraft_type" | "op_airline_id". */
  dimKey: string;
  /** The page's own path, e.g. "/carrier/OO" | "/aircraft/CRJ-700". */
  basePath: string;
  /** The query key the map filters on -- "type" | "carrier" (canonicalQuery.ts's key sets). */
  filterKey: string;
  /** THE FILTER VOCABULARY: one row's raw dimension id and its resolved label in, the value the
   *  query string must carry out. `/carrier` passes `slugFor(label)`; `/aircraft` passes
   *  `label`.
   *
   *  REQUIRED, AND DELIBERATELY NOT OPTIONAL. The contract this parameter carries is a
   *  VALUE-SPACE one -- "a string that is a slug", not "a string" -- and TypeScript cannot
   *  express it: `pickerOptions` returned `value: string` and `resolveTypeFilter` takes
   *  `raw: string`, so a seam trace of the two signatures lines up perfectly while every link
   *  the picker emits is refused at the far end. That is exactly how the defect shipped through
   *  a review that did check the seam. A default of identity would silently reproduce it for
   *  the next caller; a required parameter makes the compiler the thing that cannot forget.
   *
   *  Deriving it here instead -- `slugFor(label)` for both dimensions -- was considered and
   *  rejected: it is correct only because `slugFor` happens to be a no-op over carrier codes
   *  (all 1,658 match `[A-Z0-9]{2,3}`, `mapFilter.ts:121-125`), which makes this module's
   *  correctness rest on an invariant owned by a different file. */
  filterValueOf: (rawId: string, label: string) => string;
  /** The filter value currently selected, or null for the unfiltered view. Compared against
   *  `value`, so it is in the FILTER vocabulary -- the page reads it off the query string. */
  selected: string | null;
}): PickerOption[] {
  const { rows, resolved, dimKey, basePath, filterKey, filterValueOf, selected } = args;

  return rows
    .filter((row) => {
      // Dropped BEFORE any label or filter value is derived. `String(null)` is "null", which
      // would become a live href to a filter value naming nothing.
      const raw = row[dimKey];
      return raw !== null && raw !== undefined && String(raw).length > 0;
    })
    .map((row): PickerOption => {
      const rawId = String(row[dimKey]);
      const hit: Resolved | undefined = resolved.get(resolutionKey(dimKey, rawId));
      const label = displayValue(hit, rawId);
      const value = filterValueOf(rawId, label);
      if (value.length === 0) {
        // A caller bug, and loud for `seatsOf`'s reason directly below: an empty filter value
        // emits `?type=` -- a link that is live, looks deliberate, and names nothing.
        throw new Error(
          `pickerOptions: filterValueOf returned an empty filter value for ${dimKey}='${rawId}'`,
        );
      }
      return {
        value,
        label,
        title: hit?.name ?? null,
        seats: seatsOf(row),
        href: `${basePath}?${filterKey}=${encodeURIComponent(value)}`,
        selected: value === selected,
      };
    })
    .sort(bySeatsAbsentLast);
}

/** The row's seat sum, keeping SQL NULL as `null`.
 *
 * A MISSING COLUMN THROWS rather than reading as absence. `undefined` means the caller's pivot
 * never selected `seats` -- a wiring bug -- and coercing it to null would render every option on
 * the page as quarantined, which is a louder lie than the one this function exists to stop. SQL
 * NULL arrives as `null`, never `undefined` (verified against the live pivot: `/carrier/F4`'s
 * two quarantined types come back `seats: null`, `typeof "object"`). Both page pivots go through
 * `trailing12Query`, whose measures always include `seats` (`lib/entityFacts.ts`). */
function seatsOf(row: Record<string, unknown>): number | null {
  const raw = row.seats;
  if (raw === undefined) {
    throw new Error(
      "pickerOptions: rows carry no `seats` column -- the page's pivot must select the measure " +
        "the picker orders by. Reading a missing column as absence would mark every option " +
        "quarantined.",
    );
  }
  if (raw === null) return null;
  return Number(raw);
}

/**
 * Seats descending, ABSENT LAST, `value` ascending as a total tiebreak -- including among the
 * absent ones, so a page with two null-seat options renders them in the same order every load.
 *
 * Written out rather than left as `b.seats - a.seats`, which with a null yields `NaN`. A NaN
 * comparator does not merely sort wrongly: it is inconsistent, so the result depends on the
 * engine's sort implementation and input order, and this repo's whole byte-stability property
 * (`make verify`, the `/airport` golden) rests on renders being a function of the DATA.
 *
 * Absent LAST rather than first because the list is a ranking by seats and an unknowable total
 * cannot outrank a measured one -- the same reason `segmentMap.ts` sorts a type that flew
 * nothing last rather than lightest.
 */
function bySeatsAbsentLast(a: PickerOption, b: PickerOption): number {
  if (a.seats === null || b.seats === null) {
    if (a.seats !== b.seats) return a.seats === null ? 1 : -1;
  } else if (a.seats !== b.seats) {
    return b.seats - a.seats;
  }
  return a.value.localeCompare(b.value);
}
