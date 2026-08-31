import { headers } from "next/headers";
import { encode, UrlStateError } from "@/lib/pivot/urlstate";
import { decodeRequest } from "@/lib/pivot/bounds";
import { NON_DISPLAY_COLUMNS, PivotError } from "@/lib/pivot/types";
import { rawQueryFromHeaders } from "@/lib/rawQuery";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { formatCount } from "@/lib/format";
import { EARLIEST_MONTH } from "@/lib/entityFacts";
import { resolutionKey, displayValue, resolveFilterValues, type Resolved } from "@/lib/resolve";
import { routeHrefFromCodes } from "@/lib/entityLink";
import { ExplorerBuilder } from "@/components/builder/ExplorerBuilder";
import { exploreHref } from "@/lib/pivot/builder";
import { recoveryHref, recoveryQuery } from "@/lib/pivot/recovery";
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
 * 22,509 pairs and reusing the display order is wrong for every one of them. Shared with
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
 * itself can tell "unresolved" apart from "resolved".
 *
 * Also `null` when both halves resolve to the SAME code: `fct_route_month` really carries
 * same-airport rows (532 distinct pairs, real filed traffic -- ORD alone 73,082 seats over the
 * trailing 12 months, docs/data/invariants.md § Route identity), but `routePair.ts`'s
 * `resolveRoutePair` refuses "ORD to itself is not a route between two airports" as a named
 * 404. Without this guard the cell links straight into that 404 -- `sitemap_routes.sql`
 * already excludes these rows (`WHERE route_key_low <> route_key_high`); this is the same
 * exclusion at the link path. */
function routeHref(
  row: Record<string, unknown>,
  resolved: Map<string, Resolved>,
  columns: string[],
): string | null {
  const hits = columns.map((c) => resolved.get(resolutionKey(c, row[c])));
  if (hits.some((h) => h === undefined || h.code === null)) return null;
  const [a, b] = hits as Resolved[];
  if (a.code === b.code) return null;
  return routeHrefFromCodes(a.code as string, b.code as string);
}

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
 * query already starts at EARLIEST_MONTH -- there is no broader window left to offer.
 *
 * `EARLIEST_MONTH` is IMPORTED (lib/entityFacts.ts), not re-declared here. It is the widest time
 * window any query against this database can have, so it is what "offer the nearest broader
 * window" (docs/design/system.md, empty-result state) widens to -- and it is the same bound
 * `lib/year.ts` states at year grain, which is why it may only ever have one owner (#145).
 *
 * Routed through `exploreHref`, the same function the four entity pages' identical widened-window
 * link already centralised onto -- not a second hand-spelled `` `/explore?${encode(...)}` ``,
 * which is byte-identical today but pure drift risk: a future change to `exploreHref` (or to what
 * a valid `/explore` permalink requires) would update those four call sites and silently miss the
 * one still spelled out here. */
function widerWindowHref(query: PivotQuery): string | null {
  if (query.timeFrom <= EARLIEST_MONTH) return null;
  return exploreHref({ ...query, timeFrom: EARLIEST_MONTH });
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
    // `decodeRequest`, not `decode` (#52): the page-side half of the same admission policy
    // `proxy.ts` has already independently applied to decide this response is `no-store` -- not a
    // second definition of it, both read `lib/pivot/bounds.ts`, exactly as `/airport`'s
    // `InvalidYearView` and the proxy's `y` branch both read `lib/year.ts`. A `t` outside the
    // dataset window, a reversed one, an `n` over the ceiling or a redundantly-spelled `n`/`v`
    // therefore lands in the named error below with its own message, never a silent fallback to
    // a default view and never a full pivot render nobody can cache.
    query = decodeRequest(qs, allowlist);
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
              from <a href={recoveryHref(asOf)}>a known-valid query</a>.
            </p>
            {/* THE STATE A BUILDER IS WORTH THE MOST, and the one an "insert it above the
                results table" implementation skips without noticing: `decode()` threw, so there
                is no `query` to mutate and nothing to render a table from. Seeded from
                `recoveryQuery(asOf)` -- the same query the escape link above encodes, and the
                same one the other eight dead-end surfaces in this product offer -- so every chip
                here is a working way out of a permalink the reader cannot fix by hand, not just
                the single one that link offers. It takes THIS render's `asOf` -- the one handed
                to the builder below -- so the seeded window and the window every chip is computed
                against cannot disagree. They did while this was a frozen constant: the seed said
                2026-04 while `asOf` said 2026-05, so the builder's own "Trailing 12" chip was
                not marked current on the query it had just been seeded with (#145).

                `resolved` is empty and that is exact, not a shortcut: the recovery query carries
                no filters, so there is no id to resolve and no query to run for one. */}
            <ExplorerBuilder
              query={recoveryQuery(asOf)}
              allowlist={allowlist}
              asOf={asOf}
              resolved={new Map()}
            />
          </main>
        </div>
      );
    }
    throw e;
  }

  const permalink = encode(query);
  const isEmpty = result.rows.length === 0;

  // THE FILTER CHIPS' IDS ARE THIS PAGE'S JOB, not the component's. `runPivot` resolves only the
  // ids present in the rows it RETURNED, so a filter on a dimension this query does not GROUP by
  // -- `d=year_month&f=op_airline_id:19790`, or the either-endpoint filter every entity page's
  // "Open in the Explorer" link emits -- arrives with nothing resolved for it, and the chip reads
  // `Carrier = 19790`. `FilterChips` is synchronous by design and cannot reach a warehouse;
  // `resolveFilterValues` asks for exactly those ids and nothing else, running no query at all
  // when no filtered dimension joins a dim table.
  //
  // The pivot's own map goes in LAST so it wins where the two overlap: both are keyed by fact
  // column and agree on any shared id, but the pivot's map is derived from the rows actually on
  // the page, which is the stronger claim about what this render shows.
  //
  // AFTER `runPivot`, AND THAT ORDERING IS LOAD-BEARING -- this call sits outside the try/catch,
  // so anything it throws is an unhandled 500 under a Cache-Control the proxy has already
  // committed to. It cannot throw here because `renderPivot` has already run `checkFilterValue`
  // over every value, including each PART of a composite (render.ts:174, :204, :271) -- so an
  // integer-typed dimension's value is a canonical in-range whole number by the time it reaches a
  // resolver's bound parameter. Hoisting this above `runPivot` reopens that: `f=route:JFK-LAX`
  // clears `decode()`'s structural check and would reach `airport_id IN ('JFK','LAX')` as a raw
  // DuckDB conversion error rather than the named PivotError this page renders.
  const builderResolved = new Map([
    ...(await resolveFilterValues(query.filters, allowlist)),
    ...result.resolved,
  ]);

  // Gated on BOTH operands, and the two-case test beside it is what keeps it that way. Keyed on
  // the grouping alone this fires on every mainline view, which has no carrier filter to be
  // inconsistent with; keyed on the filter alone it fires on every carrier-filtered OPERATING
  // view, where the rollup it warns about is not happening. `cardSixthStat` shipped as the
  // one-operand form and is why CLAUDE.md carries the rule.
  const mainlineRollupFiltered =
    query.grouping === "mainline" && query.filters.some(([k]) => k === "op_airline_id");

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
        {/* BETWEEN THE STAT STRIP AND THE BODY, which puts it on the EMPTY state too -- the two
            share this one return, and the view that most needs its query adjusted must not be the
            one without the controls to adjust it. This is also what ends `/explore/filter/:dim`'s
            island: nothing linked to that route until `FilterChips`'s "add filter" half did, and
            neither `sitemap.ts` nor `proxy.ts`'s matcher counts as an inbound link (CLAUDE.md --
            `/watch` shipped with zero, one milestone after a review existed to catch exactly
            that). page.test.tsx asserts the anchor, and smoke.sh asserts it in the served bytes. */}
        <ExplorerBuilder
          query={query}
          allowlist={allowlist}
          asOf={asOf}
          resolved={builderResolved}
        />
        <div className="body">
          <div>
            {isEmpty ? (
              <EmptyState query={query} allowlist={allowlist} />
            ) : (
              // THE ONE SURFACE THAT DOES NOT SORT BELOW-FLOOR ROWS LAST, and the reason is
              // this page's contract rather than a preference. Everywhere else the row order is
              // the product's editorial choice over a ranked table, so the floor rule is part of
              // it (docs/design/system.md, "The data table"). Here the order is the QUERY'S:
              // this page renders the rows in the order the permalink encodes, and re-ordering
              // them afterwards would break the promise that it shows the query you wrote.
              // CLAUDE.md makes that load-bearing ("URL-encoded query state on every view.
              // Permalinks are the entire growth mechanic"), and this table has no rank column
              // for "excluded from ranking" to bite on.
              //
              // NOT "because the visitor stated a direction" -- `s` is optional. urlstate.ts
              // leaves `sort` null when it is absent and render.ts substitutes
              // `q.sort ?? q.measures[0]`, so a permalink without `s=` is ordered by a default
              // this product picked. The contract holds either way: the order is a property of
              // the query, addressable by whoever wrote it. `s=departures_performed` ascending
              // is only the case that makes it vivid -- someone explicitly asking to see the
              // sparsest rows first, whom the partition would answer by hiding them at the foot.
              //
              // Spelled at the CALL SITE, never as a default: `partition` defaults to true in
              // DataTable, so a sixth table surface inherits the rule and someone deleting this
              // line gets the rule back, not silence.
              <DataTable
                columns={columns}
                rows={displayRows}
                resolved={result.resolved}
                partition={false}
              />
            )}
            <p className="foot">
              {result.quarantinedRowsOnPage} quarantined row
              {result.quarantinedRowsOnPage === 1 ? "" : "s"} on this page excluded from
              these totals, never clamped. <span className="deriv">Load factor</span> and{" "}
              <span className="deriv">gauge</span> are computed at query time from summed
              passengers, seats and performed departures -- never averaged.
              {mainlineRollupFiltered ? (
                <>
                  {" "}
                  Grouped by <strong>mainline</strong> but filtered on the{" "}
                  <strong>operating</strong> carrier, so a rolled-up row can show more seats than
                  the filter selected.
                </>
              ) : null}
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
