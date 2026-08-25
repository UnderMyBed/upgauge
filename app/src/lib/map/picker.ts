import type { PivotResult } from "@/lib/db";
import { displayValue, resolutionKey, type Resolved } from "@/lib/resolve";

/** One filter link under a point-to-point map. `value` is what goes in the query string;
 * `label` is what the reader sees; `title` is the long form behind it. */
export interface PickerOption {
  /** The filter value, e.g. "673" or "19393". Goes in the query string verbatim (encoded). */
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
  seats: number;
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
 * the pivot's `ORDER BY seats DESC` carries no tiebreak column, so tied rows are SQL-unspecified
 * and two loads of one page could otherwise disagree about the order of its own picker.
 *
 * Values stay STRINGS. `AIRCRAFT_TYPE` 079 becomes 79 if int-parsed and the join breaks
 * silently (CLAUDE.md, Data gotchas).
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
  /** The raw value currently selected, or null for the unfiltered view. */
  selected: string | null;
}): PickerOption[] {
  const { rows, resolved, dimKey, basePath, filterKey, selected } = args;

  return rows
    .map((row): PickerOption => {
      const raw = row[dimKey];
      // Never `String(null)` -- "null" would become a live href to a filter value that names
      // nothing. An absent dimension value drops out below instead.
      const value = raw === null || raw === undefined ? "" : String(raw);
      const hit: Resolved | undefined = resolved.get(resolutionKey(dimKey, value));
      return {
        value,
        label: displayValue(hit, value),
        title: hit?.name ?? null,
        seats: Number(row.seats ?? 0),
        href: `${basePath}?${filterKey}=${encodeURIComponent(value)}`,
        selected: value === selected,
      };
    })
    .filter((o) => o.value.length > 0)
    .sort((a, b) => b.seats - a.seats || a.value.localeCompare(b.value));
}
