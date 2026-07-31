import { headers } from "next/headers";
import { decode, encode, UrlStateError } from "@/lib/pivot/urlstate";
import { PivotError } from "@/lib/pivot/types";
import { rawQueryFromHeaders } from "@/lib/rawQuery";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { formatCount } from "@/lib/format";
import { resolutionKey, displayValue, type Resolved } from "@/lib/resolve";
import { routeHrefFromCodes } from "@/lib/entityLink";
import { LegendRail } from "@/components/LegendRail";
import { TopBar } from "@/components/TopBar";
import type { PivotQuery } from "@/lib/pivot/types";
import type { Allowlist } from "@/lib/pivot/allowlist";

// searchParams is a request-time API (Next 16, App Router): reading it already opts this
// page into dynamic rendering. The explicit export documents that intent rather than
// relying on it being implicit -- a permalink page that got statically cached at build time
// would silently serve one frozen query to every visitor.
export const dynamic = "force-dynamic";

const KIND: Record<string, ColumnSpec["kind"]> = {
  seats: "seats",
  passengers: "seats",
  freight: "seats",
  mail: "seats",
  asm: "seats",
  rpm: "seats",
  load_factor: "loadFactor",
  completion_factor: "loadFactor",
  avg_gauge: "gauge",
  departures_performed: "count",
  departures_scheduled: "count",
  air_time: "count",
};

// fct_{segment,route}_month expose quarantine bookkeeping columns alongside every dimension
// and measure a query asked for (sql/03_queries/pivot_segment.sql, pivot_route.sql) -- the
// gutter/foot text surfaces them, but they are not columns of the pivot vocabulary and must
// never appear as a DataTable column.
const NON_DISPLAY_COLUMNS = new Set(["quarantined_rows", "quarantine_reasons"]);

/** The route dimension's column_expr names two columns; the reader wants one cell. Both
 * resolve through dim_airport, so this renders the pair as `PDX–SEA` -- the form
 * features.md's /route/PDX-AUS and the mockups both use. Value selection per key goes through
 * `displayValue()` (lib/resolve.ts), the same function DataTable's DimensionCell uses --
 * fix round 1, Finding 1: an earlier version of this function re-derived the three-way
 * contract inline as `?.code ?? String(row[c] ?? "—")`, which collapsed "unresolved" and
 * "resolved with a null code" into the same raw-id fallback. That could not misfire today
 * (dim_airport.code has 0 nulls across all 20,267 rows, and route only resolves through
 * dim_airport), but it was an unenforced point-in-time fact, not an invariant.
 *
 * Derived from the live catalog's own `column_expr`, not hand-copied -- resolve.ts's
 * `columnsFor()` derives the identical value the identical way. A hardcoded `["route_key_low",
 * "route_key_high"]` here would silently stop matching a renamed fact column: `hasRoute` would
 * go false with no test going red, and /explore would revert to two bare airport-id columns.
 * page.test.tsx pins the catalog's `column_expr` for `route` against this exact shape, so a
 * change here is caught at the catalog, not discovered by a blank route column in production. */
function routeColumns(allowlist: Allowlist): string[] {
  return allowlist.dims.get("route")?.columnExpr.split(",").map((c) => c.trim()) ?? [];
}

/** The two resolved codes for a route row, in the order the columns hold them (airport-id
 * order). The DISPLAY joins these with an en dash; the HREF must re-sort them alphabetically
 * by code -- routeHrefFromCodes owns that, because the two orderings disagree for 154 of
 * 22,420 pairs and reusing the display order is wrong for every one of them. Shared with
 * `routeHref` below so the display string and the link read the same two `displayValue()`
 * calls rather than two independently maintained copies. */
function routeCodes(
  row: Record<string, unknown>,
  resolved: Map<string, Resolved>,
  columns: string[],
): string[] {
  return columns.map((c) => displayValue(resolved.get(resolutionKey(c, row[c])), row[c]));
}

function routeCode(
  row: Record<string, unknown>,
  resolved: Map<string, Resolved>,
  columns: string[],
): string {
  return routeCodes(row, resolved, columns).join("–");
}

/** The `/route/<pair>` href for a route row, or `null` when either half didn't resolve to a
 * real code -- a row where one half rendered a bare id (unresolved, or resolved with no code)
 * has no URL to build, exactly `DimensionCell`'s own rule for a single dimension. Reads the
 * two `Resolved` hits directly rather than `routeCodes`'s display strings: a bare-id fallback
 * string is indistinguishable from a real code once stringified, so only the `Resolved` value
 * itself can tell "unresolved" apart from "resolved". */
function routeHref(
  row: Record<string, unknown>,
  resolved: Map<string, Resolved>,
  columns: string[],
): string | null {
  const hits = columns.map((c) => resolved.get(resolutionKey(c, row[c])));
  if (hits.some((h) => h === undefined || h.code === null)) return null;
  const [a, b] = hits as Resolved[];
  return routeHrefFromCodes(a.code as string, b.code as string);
}

// data/raw/ holds the full 2015-2026 window (CLAUDE.md's Status section) -- this is the
// widest time window any query against this database can have, so it is what "offer the
// nearest broader window" (docs/design/system.md, empty-result state) widens to.
const EARLIEST_MONTH = "2015-01";

/** A measure the KIND override map does not name still has to render as a numeric. Additive
 * measures are whole counts; non-additive ones are the computed ratios, which `gauge` and
 * `loadFactor` both format to fixed decimals -- `gauge` is the safe general choice since it
 * does not assume a 0-1 range the way a percentage would. */
function defaultKind(allowlist: Allowlist, key: string): ColumnSpec["kind"] {
  const measure = allowlist.meas.get(key);
  if (measure === undefined) return "identifier";
  return measure.isAdditive ? "count" : "gauge";
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "State the query in words" (docs/design/system.md, empty-result state): every dimension,
 * the time window, and every filter, using the catalog's own labels so this can never name
 * a dimension differently than the table header above it would have. */
function describeQuery(query: PivotQuery, allowlist: Allowlist): string {
  const dimLabels = query.dimensions
    .map((d) => allowlist.dims.get(d)?.label ?? d)
    .join(", ");
  const filterText = query.filters.length
    ? `, filtered to ${query.filters
        .map(([k, vals]) => `${allowlist.dims.get(k)?.label ?? k}: ${vals.join(", ")}`)
        .join("; ")}`
    : "";
  return `${capitalize(query.grain)} data grouped by ${dimLabels}, ${query.timeFrom} → ${query.timeTo}${filterText}`;
}

/** The permalink for the same query widened to the full 2015-2026 window, or null when the
 * query already starts at EARLIEST_MONTH -- there is no broader window left to offer. */
function widerWindowHref(query: PivotQuery): string | null {
  if (query.timeFrom <= EARLIEST_MONTH) return null;
  return `/explore?${encode({ ...query, timeFrom: EARLIEST_MONTH })}`;
}

function Stat({ label, value, derived }: { label: string; value: string; derived?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{derived ? <span className="deriv">{label}</span> : label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

/** Valid query, zero matching rows -- a normal state in T-100, not an error
 * (docs/design/system.md, "Empty (valid query, no rows)"). The header, stat strip and
 * legend rail stay exactly as they are for a populated result; only the table area is
 * replaced, and never with a blank panel. */
function EmptyState({ query, allowlist }: { query: PivotQuery; allowlist: Allowlist }) {
  const wider = widerWindowHref(query);
  return (
    <div className="empty-state">
      <p>No rows match {describeQuery(query, allowlist)}.</p>
      {wider ? (
        <p>
          <a href={wider}>
            Try the same query over {EARLIEST_MONTH} → {query.timeTo}
          </a>
          , the widest window this data covers.
        </p>
      ) : (
        <p>This is already the widest window this data covers.</p>
      )}
    </div>
  );
}

/** The page's whole render, taking the RAW query string as its only input. Split out from the
 * default export so that (a) nothing here can reach `searchParams`, whose decoded values
 * cannot reconstruct this format's filter values, and (b) the tests exercise the real
 * permalink boundary with a real raw string instead of mocking `headers()`. */
export async function ExploreView({ rawQuery }: { rawQuery: string }) {
  const qs = rawQuery;
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();

  // decode() AND runPivot() are both guarded: decode() validates the URL against the
  // allowlist and documents UrlStateError as the exception it raises, but runPivot() calls
  // renderPivot() again internally (db.ts) to build the executable SQL, and a value that
  // passes decode()'s structural check can still fail there -- e.g. a composite filter value
  // shaped like an id pair but not actually numeric, `f=route:JFK-LAX`, which decode() lets
  // through (Important 4, final whole-branch review: PivotError did not extend UrlStateError,
  // and this try used to end right after decode(), so a PivotError thrown from inside
  // runPivot() escaped as an unhandled 500 -- verified against a running build before this
  // fix). A permalink that quietly rendered a different query than it encodes would be worse
  // than one that errors -- the screenshot would still look authoritative -- so an invalid
  // key or value here always renders a named error, never a fallback to a default view.
  let query: PivotQuery;
  let result: PivotResult;
  try {
    query = decode(qs, allowlist);
    result = await runPivot(query);
  } catch (e) {
    if (e instanceof UrlStateError || e instanceof PivotError) {
      return (
        <div className="wrap">
          <TopBar asOf={asOf} />
          <main className="error-page">
            <h1>This permalink can&rsquo;t be read</h1>
            <p role="alert">{e.message}</p>
            <p>
              Nothing was guessed from it. Fix the offending key above and reload, or start
              from{" "}
              <a href="/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op">
                a known-valid query
              </a>
              .
            </p>
          </main>
        </div>
      );
    }
    throw e;
  }

  const permalink = encode(query);
  const isEmpty = result.rows.length === 0;

  // `route`'s catalog entry names two columns (route_key_low, route_key_high) that both
  // resolve through dim_airport -- collapse them into one synthetic `__route` column so the
  // reader sees one `PDX–SEA` cell instead of two bare airport ids side by side.
  const routeCols = routeColumns(allowlist);
  const hasRoute = routeCols.length > 0 && routeCols.every((c) => result.columns.includes(c));
  const displayColumns = result.columns.filter(
    (c) => !NON_DISPLAY_COLUMNS.has(c) && !(hasRoute && routeCols.includes(c)),
  );

  const columns: ColumnSpec[] = [
    ...(hasRoute
      ? [
          {
            key: "__route",
            label: allowlist.dims.get("route")?.label ?? "Route",
            kind: "identifier" as const,
            // Typed accessor, not a naming convention on row data: __route spans two
            // columns that both resolve through dim_airport, so it's never a DimensionCell
            // (entityHref can't express a composite id) -- this is the one place that knows
            // both halves resolved, so it hands DataTable a per-row function instead of a
            // magic-string row field.
            href: (row: Record<string, unknown>) => routeHref(row, result.resolved, routeCols),
          },
        ]
      : []),
    ...displayColumns.map((c) => ({
      key: c,
      label: allowlist.meas.get(c)?.label ?? allowlist.dims.get(c)?.label ?? c,
      // KIND is an OVERRIDE map, not the source of truth. Anything the catalog knows is a
      // measure gets a numeric kind by default -- additive counts render as counts, derived
      // ratios as gauges -- so a measure added to meta_pivot_measures can never silently
      // fall through to "identifier" and render left-aligned, non-monospaced and unformatted,
      // which would break CLAUDE.md's "all numerics mono, tabular, right-aligned, fixed
      // decimals" rule without any test noticing. Only true dimensions reach "identifier".
      kind: KIND[c] ?? defaultKind(allowlist, c),
      // Derived from the catalog's own is_additive flag, not a second hand-copied list of
      // measure keys -- a measure added to meta_pivot_measures picks up its dotted
      // "computed" underline automatically instead of silently missing it until someone
      // remembers to update a parallel constant here too. Dimensions have no isAdditive
      // entry at all (allowlist.meas.get() on a dimension key returns undefined), so they
      // fall through to `false` rather than colliding with `undefined !== false`.
      derived: allowlist.meas.get(c)?.isAdditive === false,
      // Present only for columns the catalog identifies as a joinable dimension -- this is
      // what tells DataTable's DimensionCell to resolve a code/name instead of rendering the
      // raw id. Measures and non-joining dimensions (already-readable strings) get undefined.
      dimKey: allowlist.dims.get(c)?.joinDim ? c : undefined,
    })),
  ];

  const displayRows = hasRoute
    ? result.rows.map((r) => ({ ...r, __route: routeCode(r, result.resolved, routeCols) }))
    : result.rows;

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="stats">
          <Stat label="Grain" value={capitalize(query.grain)} />
          <Stat label="Grouping" value={capitalize(query.grouping)} />
          <Stat label="Window" value={`${query.timeFrom} → ${query.timeTo}`} />
          <Stat label="Rows" value={formatCount(result.rows.length)} />
          <Stat label="Quarantined" value={formatCount(result.quarantinedRowsOnPage)} />
        </div>
        <div className="body">
          <div>
            {isEmpty ? (
              <EmptyState query={query} allowlist={allowlist} />
            ) : (
              <DataTable columns={columns} rows={displayRows} resolved={result.resolved} />
            )}
            <p className="foot">
              {result.quarantinedRowsOnPage} quarantined row
              {result.quarantinedRowsOnPage === 1 ? "" : "s"} on this page excluded from
              these totals, never clamped. <span className="deriv">Load factor</span> and{" "}
              <span className="deriv">gauge</span> are computed at query time from summed
              passengers, seats and performed departures -- never averaged.
            </p>
            <div className="permalink">
              <span className="label">Permalink</span>
              <code>/explore?{permalink}</code>
            </div>
          </div>
          <LegendRail />
        </div>
      </main>
    </div>
  );
}

/** Thin wrapper: the ONLY job here is getting the raw query string. It deliberately does not
 * accept `searchParams` -- Next has already percent-decoded those by the time a page sees
 * them, and this format's filter values can contain the delimiters that decoding makes
 * ambiguous (lib/rawQuery.ts). proxy.ts supplies the raw string via a request header. */
export default async function ExplorePage() {
  const requestHeaders = await headers();
  return <ExploreView rawQuery={rawQueryFromHeaders(requestHeaders)} />;
}
