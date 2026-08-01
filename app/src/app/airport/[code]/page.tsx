import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveAirportCode } from "./resolveAirport";
import { BASE_URL } from "@/lib/siteUrl";
import {
  AIRPORT_ENDPOINT_LIMIT,
  airportTotals,
  carrierRows,
  fetchAirportMix,
  fetchAirportTraffic,
} from "./endpoints";
import { dataAsOf, loadAllowlist } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import { TopBar } from "@/components/TopBar";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import { AIRCRAFT_MIX_LIMIT } from "@/lib/chart/aircraftMix";
import { encode } from "@/lib/pivot/urlstate";
import { formatSeats, formatCount, formatLoadFactor, formatGauge } from "@/lib/format";
import type { AirportRef } from "@/lib/resolve";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";

// Same reasoning as route/[pair]/page.tsx and explore/page.tsx: this page's content depends
// on live warehouse state (dataAsOf(), the pivots), so freezing it at build time would keep
// serving a stale DATA AS OF badge and stale totals to every visitor.
export const dynamic = "force-dynamic";

// data/raw/ holds the full 2015-2026 window (CLAUDE.md's Status section) -- the widest window
// any query against this database can have. Same constant, same value, as /route and /explore.
const EARLIEST_MONTH = "2015-01";

// Same reasoning, same pattern, as route/[pair]/page.tsx's identically-named wrapper: dedupes
// the slug resolution across `generateMetadata` and the default page export -- two separate
// calls per request in this Next version -- without touching `resolveAirportCode` itself,
// which `proxy.ts` also imports from a non-render context. Full rationale on the route page's
// own copy of this comment; not verifiable by this project's Vitest suite (disclosed in
// task-2-report.md).
const resolveAirportCodeForRequest = cache((slug: string) => resolveAirportCode(slug));

/** The trailing-12-month window the table always shows, computed from `asOf` exactly as
 * route/[pair]/page.tsx computes it (and as mart_route_health's own t12 window is): 11 months
 * back from asOf, inclusive of asOf, is 12 months. */
function trailing12From(asOf: string): string {
  const [y, m] = asOf.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 11, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const COLUMN_KINDS: [string, ColumnSpec["kind"], boolean][] = [
  ["op_airline_id", "identifier", false],
  ["seats", "seats", false],
  ["passengers", "seats", false],
  ["departures_performed", "count", false],
  ["load_factor", "loadFactor", true],
  ["avg_gauge", "gauge", true],
];

/** The carriers table's columns. Labels come from the catalog (`meta_pivot_dimensions` /
 * `meta_pivot_measures`), never from a hand-copied list here, so a relabelled measure moves
 * on this page too -- the same rule route/[pair]/page.tsx's `buildColumns` follows. The KINDS
 * are local because these rows are assembled in TypeScript rather than returned by a pivot
 * (see endpoints.ts): there is no `result.columns` to walk. */
function buildColumns(allowlist: Allowlist): ColumnSpec[] {
  return COLUMN_KINDS.map(([key, kind, derived]) => ({
    key,
    label: allowlist.meas.get(key)?.label ?? allowlist.dims.get(key)?.label ?? key,
    kind,
    derived,
    dimKey: allowlist.dims.get(key)?.joinDim ? key : undefined,
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

/** One HALF of this page's query, as an Explorer permalink.
 *
 * The Explorer cannot express the other half at the same time: `meta_pivot_dimensions` has
 * `origin_airport_id` and `dest_airport_id` as separate dimensions, render.ts AND-s filters
 * together, and the one composite dimension (`route`) filters whole route pairs. So this page
 * offers two links and says they are halves. Calling either one "the identical query" would
 * be false about the exact thing that makes an airport page different from a route page --
 * see endpoints.ts's header, and docs/architecture/pipeline.md § M4d. */
function halfQuery(
  dimension: "origin_airport_id" | "dest_airport_id",
  airportId: number,
  timeFrom: string,
  timeTo: string,
): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats", "passengers", "departures_performed", "load_factor", "avg_gauge"],
    timeFrom,
    timeTo,
    filters: [[dimension, [String(airportId)]]],
    sort: "seats",
    sortDesc: true,
    limit: 50,
    grouping: "operating",
  };
}

function exploreHref(query: PivotQuery): string {
  return `/explore?${encode(query)}`;
}

/** Zero rows in the trailing 12 months is data, not an error: the airport resolved, the query
 * is valid, and "nobody filed here last year" is the honest answer. Mirrors /route's and
 * /explore's empty states -- state the finding in words, offer the widened permalink, never
 * render a blank panel.
 *
 * Unlike /route, this page still has a chart above it: every airport that resolves is
 * fact-present by construction (lookup_airport_by_code.sql's filter), so there is always
 * history somewhere in the full window -- ISN filed 58 months and stopped in 2019-10. */
function AirportEmptyState({
  airport,
  timeFrom,
  timeTo,
}: {
  airport: AirportRef;
  timeFrom: string;
  timeTo: string;
}) {
  return (
    <div className="empty-state">
      <p>
        No filings at {airport.name} ({airport.code}) over {timeFrom} → {timeTo}.
      </p>
      <p>
        <a href={exploreHref(halfQuery("origin_airport_id", airport.id, EARLIEST_MONTH, timeTo))}>
          Try departures over {EARLIEST_MONTH} → {timeTo}
        </a>
        , the widest window this data covers — or the same for{" "}
        <a href={exploreHref(halfQuery("dest_airport_id", airport.id, EARLIEST_MONTH, timeTo))}>
          arrivals
        </a>
        .
      </p>
    </div>
  );
}

/** The whole render for a resolved airport, taking the row limit as an explicit input for the
 * same reason `RouteView` does: nothing in production data reaches either truncation branch
 * (measured per-side worst case 879 carrier-endpoint groups against a 5,000 limit, and 4,094
 * (month, type) cells against 10,000 -- both at ORD), so the disclosures would be untestable
 * without them. Split from the default export so a test can drive a real,
 * live-database render without going near Next's routing plumbing. */
export async function AirportView({
  airport,
  limit = AIRPORT_ENDPOINT_LIMIT,
  mixLimit = AIRCRAFT_MIX_LIMIT,
}: {
  airport: AirportRef;
  limit?: number;
  mixLimit?: number;
}) {
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();
  const trailing12 = trailing12From(asOf);

  // CONCURRENT: six pivots in one wave (three per union -- origin, dest, and their overlap --
  // at two grains). They share nothing, and connect() hands each its own DuckDBConnection off
  // the single memoized instance, so the serial form would pay for all six in turn.
  //
  // The chart takes the FULL window, not the table's trailing 12: a twelve-point stacked area
  // of an airport's fleet mix says almost nothing, and the whole point is the trend. The two
  // windows genuinely differ, which is why the `.window` line below names both.
  const [traffic, mix] = await Promise.all([
    fetchAirportTraffic(airport.id, trailing12, asOf, limit),
    fetchAirportMix(airport.id, EARLIEST_MONTH, asOf, mixLimit),
  ]);

  const rows = carrierRows(traffic.rows);
  const totals = airportTotals(traffic.rows, airport.id);
  const isEmpty = rows.length === 0;
  const hasMix = mix.rows.length > 0;

  // The range the chart can DRAW, which is not the range it was fetched over -- ISN's history
  // ends in 2019-10. Naming the requested window over a chart that stops five years earlier is
  // the same fabrication as interpolating across a gap (M4c). Months are zero-padded YYYY-MM,
  // so lexical min/max IS chronological.
  const drawnFrom = hasMix
    ? mix.rows.reduce((m, r) => (r.month < m ? r.month : m), mix.rows[0].month)
    : null;
  const drawnTo = hasMix
    ? mix.rows.reduce((m, r) => (r.month > m ? r.month : m), mix.rows[0].month)
    : null;
  const drawsFullWindow = drawnFrom === EARLIEST_MONTH && drawnTo === asOf;
  // ONE string, not adjacent JSX expressions: React's SSR emits `<!-- -->` between adjacent
  // text nodes, which `textContent` skips but a grep over the served bytes does not --
  // route/[pair]/page.tsx's own comment records that being found by app-smoke, not by a test.
  const chartWindow = `chart: ${drawsFullWindow ? "the full window · " : ""}${drawnFrom} → ${drawnTo}`;

  const columns = buildColumns(allowlist);
  const departures = halfQuery("origin_airport_id", airport.id, trailing12, asOf);
  const arrivals = halfQuery("dest_airport_id", airport.id, trailing12, asOf);

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="entity">
          <div className="code">{airport.code}</div>
          <div className="ename">{airport.name}</div>
        </div>
        <div className="stats">
          <Stat label="Seats" value={formatSeats(totals.seats)} />
          <Stat label="Passengers" value={formatSeats(totals.passengers)} />
          <Stat label="Load factor" value={formatLoadFactor(totals.loadFactor)} derived />
          <Stat label="Avg gauge" value={formatGauge(totals.avgGauge)} derived />
          <Stat label="Departures" value={formatCount(totals.departures)} />
          <Stat label="Carriers" value={formatCount(totals.carriers)} />
          <Stat label="Destinations" value={formatCount(totals.destinations)} />
          <Stat label="Quarantined" value={formatCount(totals.quarantinedRows)} />
        </div>
        <p className="window">
          Table: trailing 12 months · {trailing12} → {asOf}
          {hasMix ? (
            <>
              {" "}
              · {chartWindow}
            </>
          ) : null}
        </p>
        <div className="body">
          <div>
            {hasMix ? <AircraftMixChart rows={mix.rows} title={airport.code} /> : null}
            {/* The chart's own truncation, disclosed separately from the table's: the two are
                separate unions over separate pivots with separate limits, and either can be
                short while the other is whole. Saying "the totals above" here would be false --
                the stat strip is fed by the table's union, not by this one. */}
            {mix.truncated && (
              <p className="foot">
                The chart hit its {mixLimit}-row limit on at least one side, so some months or
                aircraft types are missing from it; the table and the totals above are unaffected.
              </p>
            )}
            {isEmpty ? (
              <AirportEmptyState airport={airport} timeFrom={trailing12} timeTo={asOf} />
            ) : (
              <DataTable columns={columns} rows={rows} resolved={traffic.resolved} />
            )}
            {traffic.truncated && (
              <p className="foot">
                Showing the top {limit} carrier–destination pairs by seats on each side; the
                totals above cover only those rows.
              </p>
            )}
            <p className="foot">
              Every figure on this page counts {airport.code} at <b>both</b> endpoints —
              departures and arrivals — with the {formatCount(totals.destinations)} destinations
              counted once each. {totals.quarantinedRows} quarantined row
              {totals.quarantinedRows === 1 ? "" : "s"} excluded from these totals, never
              clamped. <span className="deriv">Load factor</span> and{" "}
              <span className="deriv">avg gauge</span> are computed at query time from summed
              passengers, seats and performed departures — never averaged.
            </p>
            <p className="foot">
              The Explorer cannot express both endpoints in one query, so each half is its own
              permalink: <a href={exploreHref(departures)}>departures from {airport.code}</a> or{" "}
              <a href={exploreHref(arrivals)}>arrivals into {airport.code}</a> — every row above
              is one click from the raw rows that produced it.
            </p>
          </div>
          {/* The rail describes the encodings THIS page uses and no others. The fleet-shading
              group is asked for only when a chart is actually drawn. */}
          <LegendRail fleetMix={hasMix} />
        </div>
      </main>
    </div>
  );
}

/** The self-referential canonical `<link>`, re-resolved from the slug rather than built from
 * it verbatim -- `resolveAirportCode`'s "ok" branch has no `canonical` field of its own (an
 * airport code has one canonical FORM, unlike a route pair's two orderings -- resolveAirport.ts's
 * own header), so the canonical code is `airport.code` there and `resolved.canonical` on the
 * "redirect" branch. The bug this excludes: emitting `${BASE_URL}/airport/${slug}`, which would
 * make `/airport/sea` declare itself (lowercase) as canonical instead of `/airport/SEA`. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code: slug } = await params;
  const resolved = await resolveAirportCodeForRequest(slug);
  if (resolved.kind === "notFound") return {};
  const canonical = resolved.kind === "redirect" ? resolved.canonical : resolved.airport.code;
  return { alternates: { canonical: `${BASE_URL}/airport/${canonical}` } };
}

/** Thin wrapper: resolve the slug, handle the three-way result, hand the "ok" case to
 * `AirportView`. Same split, same reason, as `RoutePage`/`RouteView`. */
export default async function AirportPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code: slug } = await params;
  const resolved = await resolveAirportCodeForRequest(slug);

  if (resolved.kind === "redirect") {
    // 308, not 307: /airport/SEA IS the canonical URL for this airport, not a temporary
    // relocation. route/[pair]/page.tsx's comment records where that is pinned in Next's own
    // source; page.test.tsx pins the exact digest here too.
    permanentRedirect(`/airport/${resolved.canonical}`);
  }
  if (resolved.kind === "notFound") {
    notFound();
  }

  // Called directly rather than as <AirportView .../>: this codebase's tests render the result
  // of `await AirportPage(...)` through react-dom's ordinary client renderer, which cannot
  // await a nested async component reached via JSX. Equivalent under Next's real RSC renderer.
  return await AirportView({ airport: resolved.airport });
}
