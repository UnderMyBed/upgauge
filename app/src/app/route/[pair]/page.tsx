import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveRoutePair } from "@/lib/routePair";
import { BASE_URL } from "@/lib/siteUrl";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import { TopBar } from "@/components/TopBar";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import { fetchAircraftMix } from "@/lib/chart/aircraftMix";
import { encode } from "@/lib/pivot/urlstate";
import {
  EARLIEST_MONTH,
  ROUTE_CARRIER_LIMIT,
  routeEndpoints,
  routeTitle,
  sumTotals,
  trailing12Query,
} from "@/lib/entityFacts";
import { formatSeats, formatCount, formatLoadFactor, formatGauge } from "@/lib/format";
import type { AirportRef } from "@/lib/resolve";
import { AIRPORT_PREFIX } from "@/lib/airport";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";

// A permalink page whose content depends on live warehouse state (dataAsOf(), the pivot
// result) must not be frozen at build time -- same reasoning, same fix, as explore/page.tsx's
// export of this constant: a statically-cached /route/JFK-LAX would keep serving a stale
// DATA AS OF badge and stale totals to every visitor.
export const dynamic = "force-dynamic";

/** Memoizes the slug resolution FOR THE DURATION OF ONE REQUEST's render. Next invokes
 * `generateMetadata` and the default page export as two separate calls for the same request
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`'s
 * own "Memoizing data requests" section documents exactly this shape, with the identical
 * `cache(async (slug) => …)` pattern used both places), so without this the resolver -- a
 * DB-backed query -- ran twice on every successful render (fix round 1, Important 2).
 *
 * Wrapped HERE, at the page layer, rather than inside `routePair.ts`: `proxy.ts` imports
 * `resolveRoutePair` directly from a proxy context, which is not a React render, and React's
 * `cache()` only memoizes inside an ACTIVE Server Components render -- it reads
 * `ReactSharedInternals.A`, the current dispatcher (`react.react-server.development.js`);
 * outside a render (confirmed against that source, and against a bare Node call: `cache((x) =>
 * x)(1)` called twice runs the wrapped function twice) it degrades to calling straight
 * through -- never throws, never dedupes. Wrapping the shared module would silently change
 * proxy.ts's semantics for a concurrent, unrelated task's file; wrapping it here changes only
 * this page.
 *
 * NOT independently verifiable by this project's Vitest suite: the tests call
 * `generateMetadata()` and `RoutePage()` as ordinary function invocations with no shared
 * request-scoped React dispatcher (the same limitation `RoutePage`'s own header comment
 * already states for a different reason -- these tests render through react-dom's client
 * renderer, not Next's RSC renderer), so a call-count assertion here would be measuring the
 * test harness, not the dedup. Disclosed, not silently assumed, in task-2-report.md;
 * `make app-smoke` against a served build is what would measure it. */
const resolveRoutePairForRequest = cache((slug: string) => resolveRoutePair(slug));

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

  // The SAME query object this route's `opengraph-image` builds, from the same module -- the
  // card's stat row and this page's stat strip are one set of numbers or they are two that can
  // disagree (lib/entityFacts.ts).
  const query: PivotQuery = trailing12Query({
    dimensions: ["op_airline_id"],
    filters: [["route", [filterValue]]],
    asOf,
    limit,
  });

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

  const totals = sumTotals(result.rows);
  const truncated = result.rows.length >= limit;
  const isEmpty = result.rows.length === 0;
  const hasMix = mix.length > 0;
  // The range the chart can DRAW, which is not the range it was fetched over. The fetch asks
  // for EARLIEST_MONTH -> asOf; a subject that stopped filing in 2022 yields an x axis ending
  // in 2022, and 12,115 of 23,041 route pairs last filed before the current trailing-12 window,
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

  // canonical is ALPHABETICAL (routePair.ts); low/high are ordered by ID and can disagree with
  // it. `routeEndpoints` owns that pairing, and the card imports the same function -- see its
  // doc comment in lib/entityFacts.ts for the measurement and the fixture it needs.
  const [a, b] = routeEndpoints(low, high, canonical);

  // The subject line, shared by the entity header, the chart's own subtitle and the card's
  // title so the three can never name the pair differently.
  const title = routeTitle(canonical);

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="entity">
          <div className="code">{title}</div>
          <div className="ename">
            <a href={AIRPORT_PREFIX + encodeURIComponent(a.code)}>{a.name}</a> ↔{" "}
            <a href={AIRPORT_PREFIX + encodeURIComponent(b.code)}>{b.name}</a>
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
                corner case: 12,115 of the 23,041 route pairs in this database last filed
                before 2025-05 (measured), so for over half of them the chart is the only thing
                on the page with anything in it, and the empty state under it is what says the
                service has stopped. When there is nothing in the full window either (BNH-JFK),
                nothing is drawn and nothing is claimed: the empty state below already states
                that finding in words, and a second panel repeating it in the chart's own voice
                would be the card soup CLAUDE.md's density rule rules out. */}
            {hasMix ? <AircraftMixChart rows={mix} title={title} /> : null}
            {isEmpty ? (
              // `a`/`b` (alphabetical, same order as the header above), NOT `low`/`high`
              // (id order) -- Minor, final whole-branch review: for the 215 routes where the
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
  const resolved = await resolveRoutePairForRequest(slug);
  if (resolved.kind === "notFound") return {};
  const base = { alternates: { canonical: `${BASE_URL}/route/${resolved.canonical}` } };

  // `openGraph` only on "ok" -- the "redirect" outcome (routePair.ts) carries just the
  // alphabetical `canonical` string, and this page never actually serves that outcome's HTML
  // (it 308s before rendering), so there is nothing to build an honest per-pair description
  // from. `alternates.canonical` above is unchanged for either outcome.
  if (resolved.kind !== "ok") return base;

  // SAME string as this page's own `.entity .code` heading (RouteView, above) and the OG
  // image's own big title (opengraph-image.tsx's `title = routeTitle(resolved.canonical)`) --
  // reusing `routeTitle`, not inventing a second phrasing of the pair. Next mirrors
  // `openGraph.title`/`.description` to the Twitter card automatically.
  //
  // Fix round 1: unlike the other three pages this needs no NAME appended -- the pair IS the
  // name here, and `routeTitle` already reads as one. Order, confirmed: `resolved.canonical` is
  // ALWAYS the alphabetical pairing (routePair.ts: `[a.code, b.code].sort().join("-")`), which
  // is also the exact order this page's `.entity .code` AND `.entity .ename` render in --
  // `RouteView`'s `[a, b] = routeEndpoints(low, high, canonical)` re-pairs BOTH halves of the
  // heading to `canonical.split("-")`, not to `low`/`high`'s airport-ID order, so the heading
  // can never disagree with the URL it is the heading of. The 215-of-22,509 CLAUDE.md figure
  // (id order vs. alphabetical order disagreeing) describes a DIFFERENT rendering site --
  // composite route-CELL columns built straight from id-ordered `origin_airport_id`/
  // `dest_airport_id` (or `route_key_low`/`route_key_high`) in other pages' tables, e.g.
  // /carrier's "Top routes" `routeCode()` and /explore's identically-named local -- neither of
  // which goes through `routeEndpoints`. This page's own heading is not one of them.
  const title = routeTitle(resolved.canonical);
  return {
    ...base,
    openGraph: {
      title,
      // States what the view IS -- monthly, domestic-only T-100 filings -- and says so by
      // name rather than by omission, since a pasted link with no caveat reads as a claim of
      // completeness. No invented superlative, no fare or real-time claim (this dataset has
      // neither).
      description:
        `Monthly US DOT T-100 segment filings for ${title} — seats, load factor and fleet ` +
        `mix, trailing 12 months. Domestic flights only, not fares or real-time.`,
    },
  };
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
  const resolved = await resolveRoutePairForRequest(slug);

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
