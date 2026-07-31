import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveRoutePair } from "@/lib/routePair";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import { TopBar } from "@/components/TopBar";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import { fetchAircraftMix } from "@/lib/chart/aircraftMix";
import { encode } from "@/lib/pivot/urlstate";
import { formatSeats, formatCount, formatLoadFactor, formatGauge } from "@/lib/format";
import type { AirportRef } from "@/lib/resolve";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";

// A permalink page whose content depends on live warehouse state (dataAsOf(), the pivot
// result) must not be frozen at build time -- same reasoning, same fix, as explore/page.tsx's
// export of this constant: a statically-cached /route/JFK-LAX would keep serving a stale
// DATA AS OF badge and stale totals to every visitor.
export const dynamic = "force-dynamic";

/** Measured: the busiest route carries 16 distinct operating carriers over a trailing 12
 * months, 99th percentile 8. 50 leaves generous headroom so the totals below always cover
 * every carrier. If a future refresh exceeds it the page says so rather than under-reporting
 * -- see `truncated` below. */
const ROUTE_CARRIER_LIMIT = 50;

// data/raw/ holds the full 2015-2026 window (CLAUDE.md's Status section) -- the widest window
// any query against this database can have, matching explore/page.tsx's own constant of the
// same name and value.
const EARLIEST_MONTH = "2015-01";

// docs/architecture/hosting.md: "Host at upgauge.shipman.dev". `alternates.canonical` needs a
// fully-qualified URL (Next's Metadata API would otherwise fall back to a local
// http://localhost origin -- node_modules/next/dist/lib/metadata/resolvers/resolve-url.js's
// createLocalMetadataBase()), so this is written out rather than left as a relative path.
const SITE_URL = "https://upgauge.shipman.dev";

/** The trailing-12-month window this page always shows, computed from `asOf` the same way
 * mart_route_health's own t12 window is (sql/02_marts/200_mart_route_health.sql:
 * `end_m - INTERVAL 11 MONTH`) -- 11 months back from asOf, inclusive of asOf, is 12 months. */
function trailing12From(asOf: string): string {
  const [y, m] = asOf.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 11, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Ratios of sums, never averages of the rows above. CLAUDE.md's rule: compute derived
 * measures from summed numerator and denominator. Averaging the per-carrier load factors in
 * the table would be the classic T-100 error this project exists not to make. */
function routeTotals(rows: Record<string, unknown>[]) {
  const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const seats = sum("seats");
  const passengers = sum("passengers");
  const departures = sum("departures_performed");
  return {
    seats,
    passengers,
    departures,
    loadFactor: seats === 0 ? null : passengers / seats,
    avgGauge: departures === 0 ? null : seats / departures,
  };
}

// fct_segment_month exposes quarantine bookkeeping columns alongside every measure a query
// asked for (same as explore/page.tsx's identical constant) -- the stat strip surfaces the
// count, but they are not pivot-vocabulary columns and must never appear as a table column.
const NON_DISPLAY_COLUMNS = new Set(["quarantined_rows", "quarantine_reasons"]);

const KIND: Record<string, ColumnSpec["kind"]> = {
  seats: "seats",
  passengers: "seats",
  load_factor: "loadFactor",
  avg_gauge: "gauge",
  departures_performed: "count",
};

/** Same fallback as explore/page.tsx's identically-named function: a measure the KIND
 * override map does not name still needs a numeric kind, derived from the catalog's own
 * is_additive flag rather than a second hand-copied list. */
function defaultKind(allowlist: Allowlist, key: string): ColumnSpec["kind"] {
  const measure = allowlist.meas.get(key);
  if (measure === undefined) return "identifier";
  return measure.isAdditive ? "count" : "gauge";
}

function buildColumns(allowlist: Allowlist, resultColumns: string[]): ColumnSpec[] {
  return resultColumns
    .filter((c) => !NON_DISPLAY_COLUMNS.has(c))
    .map((c) => ({
      key: c,
      label: allowlist.meas.get(c)?.label ?? allowlist.dims.get(c)?.label ?? c,
      kind: KIND[c] ?? defaultKind(allowlist, c),
      derived: allowlist.meas.get(c)?.isAdditive === false,
      dimKey: allowlist.dims.get(c)?.joinDim ? c : undefined,
    }));
}

function Stat({ label, value, derived }: { label: string; value: string; derived?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{derived ? <span className="deriv">{label}</span> : label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

/** The permalink for the identical query (same dimension, same measures, same route filter)
 * against the Explorer, widened to `EARLIEST_MONTH` when asked -- shared by the Explorer link
 * and the empty-state's widened-window offer, so both always agree on what "the same query"
 * means. Mirrors explore/page.tsx's own `widerWindowHref`. */
function exploreHref(query: PivotQuery, timeFrom?: string): string {
  return `/explore?${encode(timeFrom === undefined ? query : { ...query, timeFrom })}`;
}

/** "No scheduled service" is data, not an error (CLAUDE.md's BNH-JFK-style gotchas) -- both
 * airport codes resolved, the query is valid, and zero rows is the honest answer. Mirrors
 * explore/page.tsx's EmptyState: state the finding in words, offer the widened-to-2015
 * permalink, never render a blank panel. */
function RouteEmptyState({
  query,
  low,
  high,
}: {
  query: PivotQuery;
  low: AirportRef;
  high: AirportRef;
}) {
  const wider = query.timeFrom > EARLIEST_MONTH ? exploreHref(query, EARLIEST_MONTH) : null;
  return (
    <div className="empty-state">
      <p>
        No scheduled service between {low.name} ({low.code}) and {high.name} ({high.code}) over{" "}
        {query.timeFrom} → {query.timeTo}.
      </p>
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

/** The "ok" branch's whole render, taking the resolved pair AND the carrier limit as explicit
 * inputs -- same split, same reason, as explore/page.tsx's `ExploreView` (exported) vs
 * `ExplorePage` (thin default-export wrapper): nothing here reaches Next's routing plumbing
 * directly, so a test can drive it with a real, live-database render instead of a mocked one
 * (this codebase has no mocks -- lib/resolve.ts's own header comment). `limit` defaulting to
 * `ROUTE_CARRIER_LIMIT` is what makes the truncation disclosure testable at all: JFK-LAX has 5
 * operating carriers in the real trailing-12-month window (measured), nowhere near 50, so
 * nothing in production data reaches that branch without the ability to lower the limit for a
 * test -- fix round 1, Finding 2. */
export async function RouteView({
  low,
  high,
  canonical,
  filterValue,
  limit = ROUTE_CARRIER_LIMIT,
}: {
  low: AirportRef;
  high: AirportRef;
  canonical: string;
  filterValue: string;
  limit?: number;
}) {
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();
  const TRAILING_12_FROM = trailing12From(asOf);

  const query: PivotQuery = {
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats", "passengers", "departures_performed", "load_factor", "avg_gauge"],
    timeFrom: TRAILING_12_FROM,
    timeTo: asOf,
    filters: [["route", [filterValue]]],
    sort: "seats",
    sortDesc: true,
    limit,
    grouping: "operating",
  };

  // CONCURRENT, not two sequential awaits. These two pivots share nothing -- different
  // windows, different dimensions, and `connect()` hands each one its own DuckDBConnection
  // off the single memoized instance -- so the serial form was paying for both in turn for no
  // reason. The mix pivot is the dominant query on this page (996 rows for JFK-LAX against
  // the carriers pivot's 5), which is exactly the case where the ordering shows: measured
  // in-process against the built database, JFK-LAX, warm, median of 8 -- carriers 10.9 ms,
  // mix 20.0 ms, the two SERIAL 30.1 ms, the two CONCURRENT 20.2 ms. The pair now costs what
  // its slower half costs. Full method and the rest of the table:
  // docs/architecture/hosting.md § What the proxy's query actually costs.
  //
  // The mix takes the FULL window, not `query`'s trailing 12. A trend is the whole point of
  // the chart, and a twelve-point stacked area of a route's fleet mix says almost nothing --
  // the A321's rise on JFK-LAX takes eight years to read. The two windows are therefore
  // genuinely different, which is why the `.window` line below has to name both: a page that
  // showed 2015-2026 under a line reading "trailing 12 months" would be claiming a window it
  // is not drawing.
  const [result, mix]: [PivotResult, Awaited<ReturnType<typeof fetchAircraftMix>>] =
    await Promise.all([
      runPivot(query),
      fetchAircraftMix([["route", [filterValue]]], EARLIEST_MONTH, asOf),
    ]);

  const totals = routeTotals(result.rows);
  const truncated = result.rows.length >= limit;
  const isEmpty = result.rows.length === 0;
  const hasMix = mix.length > 0;
  // The range the chart can DRAW, which is not the range it was fetched over. The fetch asks
  // for EARLIEST_MONTH -> asOf; a subject that stopped filing in 2022 yields an x axis ending
  // in 2022, and 12,062 of 22,950 route pairs last filed before the current trailing-12 window,
  // so this is over half of them rather than a corner case. Naming the requested window in the
  // line below put "2015-01 → 2026-04" over a chart stopping in 2022 -- the same fabrication as
  // interpolating across a gap, and the exact inverse of what the comment above warns about.
  // Months are zero-padded YYYY-MM, so lexical min/max IS chronological.
  const drawnFrom = hasMix ? mix.reduce((m, r) => (r.month < m ? r.month : m), mix[0].month) : null;
  const drawnTo = hasMix ? mix.reduce((m, r) => (r.month > m ? r.month : m), mix[0].month) : null;
  const drawsFullWindow = drawnFrom === EARLIEST_MONTH && drawnTo === asOf;
  // ONE string, not adjacent JSX expressions. React's SSR emits `<!-- -->` between adjacent
  // text nodes so it can find the boundaries again when hydrating, so writing this as
  // `chart: {a} → {b}` puts comment markers INSIDE the phrase in the served HTML. `textContent`
  // skips comment nodes, so every unit test still passes while `smoke.sh`'s grep over the raw
  // bytes stops matching -- the "green tests, broken production" shape this project has hit
  // repeatedly. Caught here by app-smoke, which is exactly what it is for.
  const chartWindow = `chart: ${drawsFullWindow ? "the full window · " : ""}${drawnFrom} → ${drawnTo}`;

  const columns = buildColumns(allowlist, result.columns);

  // canonical is ALPHABETICAL (routePair.ts); low/high are ordered by ID and can disagree
  // with it (154 of 22,420 routes do -- 0.69%, excluding the 530 same-airport "routes" that
  // are not routes). Pairing each half of `canonical` back to its airport
  // by CODE, rather than assuming canonical.split("-") lines up with [low, high], keeps the
  // displayed name attached to the code it is actually under even when the two orderings
  // differ.
  const [codeA, codeB] = canonical.split("-");
  const airports = [low, high];
  const a = airports.find((x) => x.code === codeA) ?? low;
  const b = airports.find((x) => x.code === codeB) ?? high;

  // The subject line, shared by the entity header and the chart's own subtitle so the two can
  // never name the pair differently. En dash, matching the header the chart sits under.
  const title = canonical.replace("-", "–");

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="entity">
          <div className="code">{title}</div>
          <div className="ename">
            {a.name} ↔ {b.name}
          </div>
        </div>
        <div className="stats">
          <Stat label="Seats" value={formatSeats(totals.seats)} />
          <Stat label="Passengers" value={formatSeats(totals.passengers)} />
          <Stat label="Load factor" value={formatLoadFactor(totals.loadFactor)} derived />
          <Stat label="Avg gauge" value={formatGauge(totals.avgGauge)} derived />
          <Stat label="Departures" value={formatCount(totals.departures)} />
          <Stat label="Carriers" value={formatCount(result.rows.length)} />
          <Stat label="Quarantined" value={formatCount(result.quarantinedRowsOnPage)} />
        </div>
        <p className="window">
          Table: trailing 12 months · {query.timeFrom} → {query.timeTo}
          {hasMix ? (
            <>
              {" "}
              · {chartWindow}
            </>
          ) : null}
        </p>
        <div className="body">
          <div>
            {/* Above the table, in the content column, mirroring
                docs/design/mockups/entity-route.html. Rendered whenever there is anything to
                draw -- INCLUDING when the trailing-12 table below is empty, which is not a
                corner case: 12,062 of the 22,950 route pairs in this database last filed
                before 2025-05 (measured), so for over half of them the chart is the only thing
                on the page with anything in it, and the empty state under it is what says the
                service has stopped. When there is nothing in the full window either (BNH-JFK),
                nothing is drawn and nothing is claimed: the empty state below already states
                that finding in words, and a second panel repeating it in the chart's own voice
                would be the card soup CLAUDE.md's density rule rules out. */}
            {hasMix ? <AircraftMixChart rows={mix} title={title} /> : null}
            {isEmpty ? (
              // `a`/`b` (alphabetical, same order as the header above), NOT `low`/`high`
              // (id order) -- Minor, final whole-branch review: for the 154 routes where the
              // two orderings disagree (BNH-JFK is one: id order is JFK,BNH but the header
              // reads "BNH–JFK"), passing low/high here made the empty-state prose name the
              // airports in the OPPOSITE order from the header immediately above it.
              <RouteEmptyState query={query} low={a} high={b} />
            ) : (
              <DataTable columns={columns} rows={result.rows} resolved={result.resolved} />
            )}
            {truncated && (
              <p className="foot">
                Showing the top {limit} carriers by seats; the totals above cover only these
                rows.
              </p>
            )}
            <p className="foot">
              {result.quarantinedRowsOnPage} quarantined row
              {result.quarantinedRowsOnPage === 1 ? "" : "s"} excluded from these totals, never
              clamped. <span className="deriv">Load factor</span> and{" "}
              <span className="deriv">avg gauge</span> are computed at query time from summed
              passengers, seats and performed departures -- never averaged.
            </p>
            <p className="foot">
              <a href={exploreHref(query)}>Open in the Explorer</a> for the identical query --
              every row above is one click from the raw rows that produced it.
            </p>
          </div>
          {/* The rail describes the encodings THIS page uses and no others -- the same reason
              LegendRail's own header gives for leaving the mockup's map group out of /explore.
              The fleet-shading group is asked for only when a chart is actually drawn. */}
          <LegendRail fleetMix={hasMix} />
        </div>
      </main>
    </div>
  );
}

/** The self-referential canonical `<link>`, resolved the SAME way the page itself resolves the
 * slug -- never the requested spelling. `resolveRoutePair` already computes the
 * code-alphabetical canonical for both its "ok" and "redirect" outcomes (routePair.ts's own
 * `canonical` field), so `/route/lax-jfk` declares `/route/JFK-LAX` as canonical even though
 * this exact render never ships for that URL -- it 308s first, and a crawler that indexed the
 * redirect's target sees the same tag confirming it. The bug this exists to exclude: building
 * the tag from `slug` (the REQUESTED spelling) instead of re-resolving it, which would have
 * `/route/lax-jfk` declare itself as its own canonical. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ pair: string }>;
}): Promise<Metadata> {
  const { pair: slug } = await params;
  const resolved = await resolveRoutePair(slug);
  if (resolved.kind === "notFound") return {};
  return { alternates: { canonical: `${SITE_URL}/route/${resolved.canonical}` } };
}

/** Thin wrapper: the ONLY job here is resolving the slug and handling the three-way
 * `RoutePairResult` (routePair.ts, Task 5) before handing the "ok" case to `RouteView`. Split
 * out so `RouteView` above never has to know about `params`, matching explore/page.tsx's
 * `ExplorePage`/`ExploreView` split. */
export default async function RoutePage({
  params,
}: {
  params: Promise<{ pair: string }>;
}) {
  const { pair: slug } = await params;
  const resolved = await resolveRoutePair(slug);

  if (resolved.kind === "redirect") {
    // permanentRedirect -> 308: this IS the canonical URL for this route pair (routePair.ts's
    // alphabetical-vs-id-order header comment), not a temporary relocation, so the correct
    // signal is 308 (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
    // permanentRedirect.md), not redirect()'s default 307. Confirmed against the actual
    // thrown error, not just the docs' prose: node_modules/next/dist/client/components/
    // redirect.js's `permanentRedirect()` throws `getRedirectError(url, type,
    // RedirectStatusCode.PermanentRedirect)`, whose `.digest` is the literal string
    // `NEXT_REDIRECT;${type};${url};${statusCode};` -- `statusCode` is `308` here and would
    // be `307` (RedirectStatusCode.TemporaryRedirect, redirect.js's default) if this ever
    // regressed to plain `redirect()`. page.test.tsx pins that exact digest.
    permanentRedirect(`/route/${resolved.canonical}`);
  }
  if (resolved.kind === "notFound") {
    // notFound() throws NEXT_HTTP_ERROR_FALLBACK;404 and terminates rendering of this segment
    // (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md) --
    // there is no app/not-found.tsx yet, so Next's own default 404 UI renders; that default
    // still returns the documented 404 status, which is the contract this page owes.
    // Confirmed against the source, not just the docs: node_modules/next/dist/client/
    // components/not-found.js throws an Error whose `.digest` is the literal string
    // `NEXT_HTTP_ERROR_FALLBACK;404` (http-access-fallback.js's `HTTP_ERROR_FALLBACK_ERROR_CODE`
    // + the fixed 404 status) -- page.test.tsx pins that exact digest too.
    notFound();
  }

  // Called directly rather than written as `<RouteView .../>`: RouteView is an async
  // function, and this codebase's tests render the result of `await RoutePage(...)` through
  // react-dom's ordinary client renderer (testing-library/react), which -- unlike Next's own
  // RSC renderer -- cannot await a nested async component reached via JSX. Calling it
  // directly returns its already-resolved element tree, exactly as if this function had
  // inlined RouteView's body itself. Equivalent under Next's real RSC rendering either way.
  return await RouteView({
    low: resolved.low,
    high: resolved.high,
    canonical: resolved.canonical,
    filterValue: resolved.filterValue,
  });
}
