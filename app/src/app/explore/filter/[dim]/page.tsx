import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { dataAsOf, loadAllowlist, runPivot } from "@/lib/db";
import { formatSeats } from "@/lib/format";
import type { Allowlist, DimensionEntry } from "@/lib/pivot/allowlist";
import {
  addFilter,
  exploreHref,
  filterableDimensions,
  removeFilterValue,
} from "@/lib/pivot/builder";
import { decodeRequest } from "@/lib/pivot/bounds";
import { normalizeQuery, PivotError, type PivotQuery } from "@/lib/pivot/types";
import { UrlStateError } from "@/lib/pivot/urlstate";
import { rawQueryFromHeaders } from "@/lib/rawQuery";
import { displayValue, resolutionKey, type Resolved } from "@/lib/resolve";

// Reads a request header and runs a live pivot, exactly as /explore does. Static rendering would
// freeze one window's value list into the build and serve it to every visitor.
export const dynamic = "force-dynamic";

/** Top values only. The list is an affordance, not a catalogue: `route` has tens of thousands of
 *  pairs and `endpoint_airport_id` several hundred airports per end (742 origins and 753
 *  destinations over 2025-05..2026-04 -- measured, and NOT the same set, which is why the
 *  either-end list below is a union of two rather than one of them). `MapPicker`'s `truncated`
 *  note is the precedent for saying so on the page rather than implying completeness. */
export const FILTER_VALUE_LIMIT = 100;

/** The fact columns a dimension occupies. `route` is the one that names two. */
function columnsOf(e: DimensionEntry): string[] {
  return e.columnExpr.split(",").map((c) => c.trim());
}

/** Can a one-dimension pivot GROUP BY this entry and hand back one row per value?
 *
 *  Two refusals, both from the catalog rather than from a name: a `filter_only` dimension is
 *  rejected by `renderPivot` outright (`cannot be grouped by`), and a multi-column dimension is
 *  only readable back into a filter value if it is `pair`-mode, which is the encoding
 *  `render.ts`'s composite branch expects (`<low>-<high>`). */
function isEnumerable(e: DimensionEntry): boolean {
  if (e.filterOnly) return false;
  const columns = columnsOf(e);
  return columns.length === 1 || (columns.length === 2 && e.filterMode === "pair");
}

export interface ValueSources {
  /** One pivot each. More than one only for a dimension that cannot be grouped by itself. */
  sources: DimensionEntry[];
  /** Fact columns of a filter-only dimension that no groupable dimension owns. Rendered as a
   *  refusal on the page: the list would silently be missing a whole end otherwise. */
  unlistable: string[];
}

/**
 * Which pivot(s) enumerate this dimension's values.
 *
 * For fourteen of the fifteen catalog dimensions the answer is "itself". `endpoint_airport_id` is
 * the exception and it is the interesting one: it means "this airport at EITHER end", so grouping
 * by it would put ORD->LAX in both the ORD and the LAX group and double-count -- which is exactly
 * why the catalog marks it `filter_only` and `renderPivot` refuses it as a grouping key.
 *
 * So its values come from the dimensions that own its two fact columns (`origin_airport_id` and
 * `dest_airport_id`), one pivot each, rendered as two ranked lists rather than summed into one.
 * SUMMING THEM WOULD BE WRONG, not merely approximate: a same-airport filing (ORD->ORD, 532
 * distinct pairs in this warehouse) appears in both and would be counted twice, which is the
 * inclusion-exclusion error `render.ts`'s `either` branch exists to avoid. Each figure shown is
 * one end's own total, stated as such; the filter each anchor writes still matches both ends.
 *
 * Derived from `column_expr`, never from a hardcoded pair of keys: a renamed fact column moves
 * both halves together, and `page.test.tsx` pins the mapping against the LIVE catalog so a
 * filter-only dimension nobody wired a source for is red rather than a silently shorter page.
 */
export function valueSources(entry: DimensionEntry, allowlist: Allowlist): ValueSources {
  if (!entry.filterOnly) {
    return isEnumerable(entry)
      ? { sources: [entry], unlistable: [] }
      : { sources: [], unlistable: [entry.columnExpr] };
  }
  const sources: DimensionEntry[] = [];
  const unlistable: string[] = [];
  for (const column of columnsOf(entry)) {
    const owner = [...allowlist.dims.values()].find(
      (d) => isEnumerable(d) && d.columnExpr.trim() === column,
    );
    if (owner === undefined) unlistable.push(column);
    else sources.push(owner);
  }
  return { sources, unlistable };
}

export interface ListValue {
  /** The `f` value: the BTS id, never the display code (CLAUDE.md -- `dim_carrier` carries the
   *  CURRENT code, so a code-valued filter changes meaning across a rebuild). */
  value: string;
  display: string;
}

/**
 * One row of a source pivot, as a filter value plus the string a reader sees.
 *
 * NULL IS ABSENCE. A dimension value that is NULL cannot be expressed as a filter at all --
 * `x IN (NULL)` matches nothing -- so the row is returned as `null` here and the page renders it
 * without a link rather than emitting `f=key:null`, which the server would reject on click. No
 * dimension in the current warehouse carries a NULL over the trailing 12 months (measured: zero
 * across `aircraft_type`, `origin_state`, `dest_state`, `op_airline_id`, `origin_city_market_id`,
 * `distance_group` and `aircraft_group`), which is a point-in-time fact and not an invariant --
 * hence a guard here and a direct unit test of this function rather than a fixture.
 */
export function readValue(
  source: DimensionEntry,
  row: Record<string, unknown>,
  resolved: Map<string, Resolved>,
): ListValue | null {
  const columns = columnsOf(source);
  if (columns.some((c) => row[c] === null || row[c] === undefined)) return null;
  const shown = columns.map((c) => displayValue(resolved.get(resolutionKey(c, row[c])), row[c]));
  if (columns.length === 1) return { value: String(row[columns[0]]), display: shown[0] };
  // A composite value is `<low>-<high>` and the display is the en-dashed pair, the same two
  // strings /explore's route cell renders. The columns already hold low/high, so no re-sort.
  return { value: `${row[columns[0]]}-${row[columns[1]]}`, display: shown.join("–") };
}

interface RenderedSource {
  key: string;
  /** Names the END this list covers, and only set when there is more than one. */
  label: string | null;
  values: (ListValue | null)[];
  /** NULL seats means every filed row in this group was quarantined: `seats` is NOT NULL at rest
   *  (measured: zero NULL over the trailing 12 months of `fct_segment_month`), so the only way
   *  `SUM(seats) FILTER (WHERE NOT is_quarantined)` returns NULL is an empty filter set. */
  seats: (number | null)[];
  truncated: boolean;
}

/**
 * `limit` is a parameter, not a bare reference to `FILTER_VALUE_LIMIT`, so a test can pin the
 * exactly-at-limit boundary against a limit the live warehouse actually reaches for some
 * dimension -- rather than asserting a count (100) no dimension may ever hit in this dataset.
 * Every real call site uses the default.
 */
export async function renderSource(
  query: PivotQuery,
  entry: DimensionEntry,
  source: DimensionEntry,
  label: string | null,
  limit: number = FILTER_VALUE_LIMIT,
): Promise<RenderedSource> {
  // NO NEW SQL: the value list IS a one-dimension pivot over the same window and the OTHER active
  // filters, so grain handling and quarantine exclusion come along without being restated. The
  // filter on the dimension being LISTED is dropped -- keeping it leaves a list of one value, the
  // one already chosen, which is not a list.
  //
  // `grouping: "operating"`, NEVER the query's own `g`. This list enumerates values you can put
  // in `f`, and `f` targets the RAW fact column: `sql/03_queries/pivot_mainline_join.sql`'s own
  // header documents that the {{FILTERS}} token always renders `op_airline_id IN (...)` against
  // `f.op_airline_id` while `g=ml` rewrites only the SELECT/GROUP BY to
  // `coalesce(m.parent_airline_id, f.op_airline_id)`. Spreading `...query` therefore RANKED and
  // LABELLED the list by the rollup while every link it emitted filtered the raw column, so the
  // page stated a figure its own link could not reproduce. Measured on the live warehouse at
  // t=2025-05:2026-04, `g=ml`: the AS row displayed 62,663,219 seats and its link returned
  // 46,551,806 -- HA (8,861,773) and QX/Horizon (7,249,640) folded into the number and silently
  // dropped by the link, a 16,111,413-seat gap, 25.7% wrong, under HTML_CACHE. NOT VX: Virgin
  // America last filed 2018-03, so it is in `map_mainline_group` under AS but contributes ZERO
  // seats to this window and cannot be in the gap -- a wrongly-named pair here would send the
  // next reader looking for a carrier that is not there. Enumerating on the operating carrier
  // lists AS, HA and QX separately, which
  // is right: each is a value the filter can actually select. The `g=ml` note in the render below
  // says so on the page rather than leaving the reader to notice.
  // Fetch ONE ROW PAST the limit: `result.rows.length === limit` cannot tell "the largest `limit`
  // by seats, not every value" apart from "every value, and there happen to be exactly `limit` of
  // them" -- a dimension with exactly `limit` distinct values would state the former and it would
  // be false. Asking for `limit + 1` and slicing the extra row off before rendering makes
  // `truncated` answer the question it claims to: did a row exist beyond what's shown.
  const listQuery = normalizeQuery({
    ...query,
    grouping: "operating",
    dimensions: [source.key],
    measures: ["seats"],
    sort: "seats",
    sortDesc: true,
    limit: limit + 1,
    filters: query.filters.filter(([k]) => k !== entry.key),
  });
  const result = await runPivot(listQuery);
  const truncated = result.rows.length > limit;
  const rows = truncated ? result.rows.slice(0, limit) : result.rows;
  return {
    key: source.key,
    label,
    values: rows.map((row) => readValue(source, row, result.resolved)),
    seats: rows.map((row) => row.seats as number | null),
    truncated,
  };
}

/** The permalink is unreadable, so there is no window and no filter set to scope a list to.
 *  Same shape and same refusal as `ExploreView`'s: nothing is guessed, the offending message is
 *  shown, and the recovery link is a permalink known to be valid. */
function UnreadableQuery({ asOf, message }: { asOf: string; message: string }) {
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>This permalink can&rsquo;t be read</h1>
        <p role="alert">{message}</p>
        <p>
          A value list is scoped to the query that opened it, so there is nothing to list until
          this permalink parses. Fix the offending key and reload, or start from{" "}
          <a href="/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op">
            a known-valid query
          </a>
          .
        </p>
      </main>
    </div>
  );
}

/** The page's whole render, taking the RAW query string as its only request input -- split out
 *  from the default export for `ExploreView`'s two reasons: nothing here can reach `searchParams`
 *  (whose decoded values cannot reconstruct this format's filter values), and the tests cross the
 *  real permalink boundary with a real raw string instead of mocking `headers()`. */
export async function FilterListView({ rawQuery, dim }: { rawQuery: string; dim: string }) {
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();

  let query: PivotQuery;
  try {
    query = decodeRequest(rawQuery, allowlist);
  } catch (e) {
    if (e instanceof UrlStateError || e instanceof PivotError) {
      return <UnreadableQuery asOf={asOf} message={e.message} />;
    }
    throw e;
  }

  // Two different findings, kept apart and worded apart by `not-found.tsx`: a slug that names no
  // dimension at all, and a real dimension this grain does not carry. Collapsing them is the
  // silent-pick failure `/carrier/PA`'s split exists to refuse.
  const entry = filterableDimensions(allowlist, query.grain).find((e) => e.key === dim);
  if (entry === undefined) notFound();

  // The values of THIS dimension already in `f`. Read off `query`, not off `listQuery` (which
  // drops exactly this filter so the list is not scoped to its own answer).
  const applied = new Set(query.filters.find(([k]) => k === entry.key)?.[1] ?? []);
  const { sources, unlistable } = valueSources(entry, allowlist);
  const rendered = await Promise.all(
    sources.map((source) =>
      renderSource(query, entry, source, sources.length > 1 ? source.label : null),
    ),
  );

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <nav className="map-picker" aria-label={`${entry.label} values`}>
          <p className="mp-legend">Filter by {entry.label}</p>
          {unlistable.length > 0 ? (
            <div className="mp-refusal">
              <p>
                No groupable dimension owns{" "}
                {unlistable.length === 1 ? "this fact column" : "these fact columns"} of{" "}
                {entry.label}, so the values filed there are missing from this page. Filter on
                them by hand with <code>f={entry.key}:&lt;id&gt;</code>.
              </p>
              <ul>
                {unlistable.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {rendered.map((source) => (
            <div key={source.key}>
              {source.label === null ? null : <p className="mp-legend">{source.label}</p>}
              <ul className="mp-list">
                {source.values.map((value, i) =>
                  value === null ? (
                    // A row with no dimension value has no value to key on; its position in
                    // the ranked result is the only identity it has.
                    <li key={`absent-${source.key}-${i}`}>
                      <span className="mp-absent">no value filed</span>
                      <span className="mp-seats">{formatSeats(source.seats[i])}</span>
                    </li>
                  ) : (
                    <li key={`${source.key}-${value.value}`}>
                      {/* A value ALREADY in `f` is marked and REMOVES itself, rather than being
                          offered as an add that `addFilter` would refuse -- a link that does
                          nothing is the dead link `Chips.tsx` refuses to emit. `✕` and
                          `aria-current` together, because colour is never the sole channel. */}
                      <a
                        href={
                          applied.has(value.value)
                            ? exploreHref(removeFilterValue(query, entry.key, value.value))
                            : exploreHref(addFilter(query, entry.key, value.value, allowlist))
                        }
                        aria-current={applied.has(value.value) ? "page" : undefined}
                      >
                        {applied.has(value.value) ? `${value.display} ✕` : value.display}
                        {source.seats[i] === null ? (
                          <span className="mp-seats mp-absent">quarantined</span>
                        ) : (
                          <span className="mp-seats">{formatSeats(source.seats[i])}</span>
                        )}
                      </a>
                    </li>
                  ),
                )}
              </ul>
              {source.truncated ? (
                <p className="mp-note">
                  The largest {FILTER_VALUE_LIMIT} by seats in this window, not every value.
                </p>
              ) : null}
            </div>
          ))}
          {/* GATED ON BOTH OPERANDS. `g=ml` rewrites the SELECT/GROUP BY of the CARRIER column
              and nothing else, so this sentence is only about a list that carries carriers.
              Keyed on the grouping alone it printed "Listed by operating carrier as filed" on
              `/explore/filter/aircraft_type?...&g=ml` -- a list of airframes, whose figures are
              byte-identical under `g=ml` and `g=op` because no carrier column is grouped in it.
              Same rule, same reason, as `cardSixthStat` in CLAUDE.md. Read off the RENDERED
              sources rather than the slug: `endpoint_airport_id` is enumerated through the two
              airport dimensions, so the slug alone cannot tell you what the list holds. */}
          {query.grouping === "mainline" && rendered.some((r) => r.key === "op_airline_id") ? (
            <p className="mp-note">
              Listed by operating carrier as filed. A filter matches the carrier that operated the
              metal, so a rolled-up group is not one of the values you can pick here.
            </p>
          ) : null}
          {rendered.length > 1 ? (
            <p className="mp-note">
              {entry.label} matches either end of a segment, which no single grouping enumerates.
              Each list ranks one end by its own seats; a value filed at both ends appears in both,
              and the filter you get matches both.
            </p>
          ) : null}
          <p className="foot">
            <a href={exploreHref(query)}>Back to the query</a>
          </p>
        </nav>
      </main>
    </div>
  );
}

/** Thin wrapper: the ONLY job here is getting the raw query string and the slug. It deliberately
 *  does not accept `searchParams` -- Next has already percent-decoded those by the time a page
 *  sees them, and this format's filter values can contain the delimiters decoding makes
 *  ambiguous (lib/rawQuery.ts). `proxy.ts` supplies the raw string via a request header, so
 *  `/explore/filter/:dim` must be in its matcher or this throws. */
export default async function FilterListPage({ params }: { params: Promise<{ dim: string }> }) {
  const { dim } = await params;
  const requestHeaders = await headers();
  return <FilterListView rawQuery={rawQueryFromHeaders(requestHeaders)} dim={dim} />;
}
