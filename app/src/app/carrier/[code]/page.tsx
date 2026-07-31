import { notFound, permanentRedirect } from "next/navigation";
import { resolveCarrier } from "@/lib/carrier";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import { fetchAircraftMix } from "@/lib/chart/aircraftMix";
import { encode } from "@/lib/pivot/urlstate";
import { formatSeats, formatCount, formatLoadFactor, formatGauge } from "@/lib/format";
import type { CarrierRef } from "@/lib/resolve";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";

// Same reasoning, same constant, as route/[pair]/page.tsx and explore/page.tsx: this page's
// content depends on live warehouse state (dataAsOf(), the pivot result), so a statically
// cached /carrier/DL would keep serving a stale DATA AS OF badge and stale totals forever.
export const dynamic = "force-dynamic";

/** Measured: the busiest carrier operates 18 distinct aircraft types over a trailing 12
 * months and 23 all-time. 100 clears both by 4x. If a future refresh ever exceeds it the page
 * says so rather than under-reporting -- see `truncated` below. */
const CARRIER_TYPE_LIMIT = 100;

// data/raw/ holds the full 2015-2026 window (CLAUDE.md's Status section) -- the widest window
// any query against this database can have, matching the identically-named constants in
// explore/page.tsx and route/[pair]/page.tsx.
const EARLIEST_MONTH = "2015-01";

/** The trailing-12-month window this page always shows, computed from `asOf` the same way
 * mart_route_health's own t12 window is (sql/02_marts/200_mart_route_health.sql). */
function trailing12From(asOf: string): string {
  const [y, m] = asOf.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 11, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Ratios of sums, never averages of the rows above -- CLAUDE.md's hard rule. Measured for
 * Delta over 2025-05..2026-04: the correct load factor is 82.84% and the mean of the 17
 * per-type load factors is 83.34%; the correct gauge is 163.7 and the mean of the rows is
 * 194.8. Both wrong answers look entirely plausible on screen, which is why page.test.tsx
 * asserts the right figures AND the absence of these two. */
function carrierTotals(rows: Record<string, unknown>[]) {
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

// Quarantine bookkeeping columns ride along with every segment-grain result; the stat strip
// surfaces the count, but they are not pivot-vocabulary columns and must never become table
// columns. Same constant, same reason, as explore/page.tsx and route/[pair]/page.tsx.
const NON_DISPLAY_COLUMNS = new Set(["quarantined_rows", "quarantine_reasons"]);

const KIND: Record<string, ColumnSpec["kind"]> = {
  seats: "seats",
  passengers: "seats",
  load_factor: "loadFactor",
  avg_gauge: "gauge",
  departures_performed: "count",
};

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

function Wordmark() {
  return (
    <span className="mark">
      UP<span className="accent">GAUGE</span>
    </span>
  );
}

function TopBar({ asOf }: { asOf: string }) {
  return (
    <div className="top">
      <Wordmark />
      <span className="asof">DATA AS OF {asOf}</span>
    </div>
  );
}

function Stat({ label, value, derived }: { label: string; value: string; derived?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{derived ? <span className="deriv">{label}</span> : label}</div>
      <div className="v">{value}</div>
    </div>
  );
}

function exploreHref(query: PivotQuery, timeFrom?: string): string {
  return `/explore?${encode(timeFrom === undefined ? query : { ...query, timeFrom })}`;
}

/** OPERATING CARRIER IS THE GRAIN AND THE TRUTH (CLAUDE.md's hard rule), said on the page
 * whose entire subject is one carrier.
 *
 * `LegendRail` already carries a generic version of this on every data view. That is not
 * enough here, and the difference is the whole reason this exists: someone who knows the
 * network reads /carrier/DL's seat count as too LOW, because a large share of Delta-branded
 * flying is operated by Endeavor and files under 9E. A rail entry phrased in the abstract does
 * not connect that to the number they are looking at. This names the subject and states the
 * consequence -- the missing flying is counted, just under someone else's code.
 *
 * ONE template string, not adjacent JSX expressions. React's SSR emits `<!-- -->` between
 * adjacent text nodes, so writing this as `... what {name} ({code}) filed ...` puts comment
 * markers INSIDE the sentence in the served HTML: every unit test still passes (textContent
 * skips comment nodes) while a `grep` over the served bytes stops matching. That is the exact
 * "green tests, broken production" shape M4c hit on the window line, and app/smoke.sh needs
 * these two sentences greppable. */
function grainNote(carrier: CarrierRef): string {
  return (
    `Operated, not marketed. Every figure on this page is what ${carrier.name} ` +
    `(${carrier.code}) filed as the operating carrier of the metal. T-100 Segment has no ` +
    `marketing-carrier field, so a ${carrier.code}-branded flight operated by a regional ` +
    `partner is filed under that partner's own code and counted there, not here.`
  );
}

/** dim_carrier holds the CURRENT carrier code and name, never the point-in-time one
 * (CLAUDE.md), and this page must not present it as historical fact. Same single-template-
 * string discipline as grainNote above, for the same reason. */
function identityNote(carrier: CarrierRef): string {
  return (
    `${carrier.code} and “${carrier.name}” are this airline's current identity in BTS's ` +
    `Carrier Decode table, not the code it filed under in any given month. This dataset ` +
    `carries one identity per airline, so every month drawn above is labelled with today's ` +
    `code and name.`
  );
}

/** A carrier that resolved but filed nothing in the trailing 12 months. Not an error and not
 * an oddity: 45 of this database's 114 fact-present carriers last filed before the current
 * window (measured, 39%) -- Virgin America stopped in 2018-03 and is still a real carrier with
 * a real history, which the chart above this state is drawing. State the finding in words and
 * offer the widened permalink, never a blank panel. */
function CarrierEmptyState({ query, carrier }: { query: PivotQuery; carrier: CarrierRef }) {
  const wider = query.timeFrom > EARLIEST_MONTH ? exploreHref(query, EARLIEST_MONTH) : null;
  return (
    <div className="empty-state">
      <p>
        {`${carrier.name} (${carrier.code}) filed no segments over ${query.timeFrom} → ${query.timeTo}.`}
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

/** The "ok" branch's whole render, taking the resolved carrier and the type limit as explicit
 * inputs -- same split, same reason, as `RouteView` and `ExploreView`: nothing here touches
 * Next's routing plumbing, so a test can drive it with a real, live-database render, and
 * `limit` being a parameter is what makes the truncation disclosure reachable at all (the
 * busiest carrier operates 18 types, nowhere near CARRIER_TYPE_LIMIT). */
export async function CarrierView({
  carrier,
  filterValue,
  limit = CARRIER_TYPE_LIMIT,
}: {
  carrier: CarrierRef;
  filterValue: string;
  limit?: number;
}) {
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();
  const TRAILING_12_FROM = trailing12From(asOf);

  // FILTERED ON THE AIRLINE ID, never on the letter code (CLAUDE.md: key on AIRLINE_ID,
  // display carrier_code). `filterValue` is `String(airline_id)`; lib/carrier.ts owns that
  // conversion and lib/carrier.test.ts pins it.
  //
  // `grouping: "operating"` is not a default falling through -- it is this page's subject.
  // The mainline rollup would fold Endeavor into Delta and change what /carrier/DL means; the
  // caveat below says outright that this page does not do that.
  const query: PivotQuery = {
    grain: "segment",
    dimensions: ["aircraft_type"],
    measures: ["seats", "passengers", "departures_performed", "load_factor", "avg_gauge"],
    timeFrom: TRAILING_12_FROM,
    timeTo: asOf,
    filters: [["op_airline_id", [filterValue]]],
    sort: "seats",
    sortDesc: true,
    limit,
    grouping: "operating",
  };

  // CONCURRENT, not two sequential awaits -- the two pivots share nothing and `connect()`
  // hands each its own DuckDBConnection off the single memoized instance. Same measurement,
  // same reasoning, as route/[pair]/page.tsx (docs/architecture/hosting.md § What the proxy's
  // query actually costs).
  //
  // The mix takes the FULL window, not `query`'s trailing 12: a twelve-point stacked area of a
  // carrier's fleet says almost nothing, and the arrival of the A321 and the 737-9 across a
  // decade is the entire point of putting a chart on this page. The two windows are genuinely
  // different, which is why the `.window` line below names both.
  const [result, mix]: [PivotResult, Awaited<ReturnType<typeof fetchAircraftMix>>] =
    await Promise.all([
      runPivot(query),
      fetchAircraftMix([["op_airline_id", [filterValue]]], EARLIEST_MONTH, asOf),
    ]);

  const totals = carrierTotals(result.rows);
  const truncated = result.rows.length >= limit;
  const isEmpty = result.rows.length === 0;
  const hasMix = mix.length > 0;

  // The range the chart can DRAW, which is not the range it was fetched over. 45 of 114
  // fact-present carriers last filed before the trailing-12 window, so a chart whose x axis
  // ends years before `asOf` is routine here -- naming the requested window over it would be
  // the same fabrication as interpolating across a gap (M4c, Finding 1). Months are
  // zero-padded YYYY-MM, so lexical min/max IS chronological.
  const drawnFrom = hasMix ? mix.reduce((m, r) => (r.month < m ? r.month : m), mix[0].month) : null;
  const drawnTo = hasMix ? mix.reduce((m, r) => (r.month > m ? r.month : m), mix[0].month) : null;
  const drawsFullWindow = drawnFrom === EARLIEST_MONTH && drawnTo === asOf;
  // ONE string, not adjacent JSX expressions -- see grainNote's comment for what React's SSR
  // does between adjacent text nodes and why smoke.sh cares.
  const chartWindow = `chart: ${drawsFullWindow ? "the full window · " : ""}${drawnFrom} → ${drawnTo}`;

  const columns = buildColumns(allowlist, result.columns);

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="entity">
          <div className="code">{carrier.code}</div>
          <div className="ename">{carrier.name}</div>
        </div>
        <div className="stats">
          <Stat label="Seats" value={formatSeats(totals.seats)} />
          <Stat label="Passengers" value={formatSeats(totals.passengers)} />
          <Stat label="Load factor" value={formatLoadFactor(totals.loadFactor)} derived />
          <Stat label="Avg gauge" value={formatGauge(totals.avgGauge)} derived />
          <Stat label="Departures" value={formatCount(totals.departures)} />
          <Stat label="Aircraft types" value={formatCount(result.rows.length)} />
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
            {/* Above the table, mirroring /route and docs/design/mockups/entity-route.html.
                Drawn whenever there is anything to draw, INCLUDING when the trailing-12 table
                below is empty -- for 39% of this database's carriers the chart is the only
                panel on the page with anything in it, and the empty state under it is what
                says the flying stopped. */}
            {hasMix ? <AircraftMixChart rows={mix} title={carrier.code} /> : null}
            {isEmpty ? (
              <CarrierEmptyState query={query} carrier={carrier} />
            ) : (
              <DataTable columns={columns} rows={result.rows} resolved={result.resolved} />
            )}
            {truncated && (
              <p className="foot">
                Showing the top {limit} aircraft types by seats; the totals above cover only
                these rows.
              </p>
            )}
            {/* The two claims this page cannot omit, both CLAUDE.md hard rules, both stated
                about THIS carrier rather than in the abstract -- and rendered whether or not
                there is a table, because they qualify the subject, not the rows. */}
            <p className="foot">{grainNote(carrier)}</p>
            <p className="foot">{identityNote(carrier)}</p>
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
          {/* The rail describes the encodings THIS page uses and no others; the fleet-shading
              group is asked for only when a chart is actually drawn. */}
          <LegendRail fleetMix={hasMix} />
        </div>
      </main>
    </div>
  );
}

/** Thin wrapper: the ONLY job here is resolving the slug and handling the three-way
 * `CarrierResult` before handing the "ok" case to `CarrierView`. Same split as
 * route/[pair]/page.tsx's `RoutePage`/`RouteView`. */
export default async function CarrierPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code: slug } = await params;
  const resolved = await resolveCarrier(slug);

  if (resolved.kind === "redirect") {
    // 308, not 307: /carrier/DL IS the canonical URL for this carrier, not a temporary
    // relocation. `permanentRedirect` throws a digest of the literal form
    // `NEXT_REDIRECT;${type};${url};${statusCode};` (node_modules/next/dist/client/components/
    // redirect.js), which page.test.tsx pins exactly -- a regression to plain `redirect()`
    // would show up there as ';307;'.
    permanentRedirect(`/carrier/${resolved.canonical}`);
  }
  if (resolved.kind === "notFound") {
    // Throws `NEXT_HTTP_ERROR_FALLBACK;404` and terminates this segment's render, which
    // not-found.tsx then handles.
    notFound();
  }

  // Called directly rather than as `<CarrierView .../>`: this codebase's tests render the
  // result of `await CarrierPage(...)` through react-dom's ordinary client renderer, which --
  // unlike Next's RSC renderer -- cannot await a nested async component reached via JSX.
  // Equivalent under Next's real rendering either way. See route/[pair]/page.tsx's note.
  return await CarrierView({ carrier: resolved.carrier, filterValue: resolved.filterValue });
}
