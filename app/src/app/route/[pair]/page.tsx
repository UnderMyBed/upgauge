import { notFound, permanentRedirect } from "next/navigation";
import { resolveRoutePair } from "@/lib/routePair";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
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
    // permanentRedirect.md), not redirect()'s default 307.
    permanentRedirect(`/route/${resolved.canonical}`);
  }
  if (resolved.kind === "notFound") {
    // notFound() throws NEXT_HTTP_ERROR_FALLBACK;404 and terminates rendering of this segment
    // (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md) --
    // there is no app/not-found.tsx yet, so Next's own default 404 UI renders; that default
    // still returns the documented 404 status, which is the contract this page owes.
    notFound();
  }

  const { low, high, canonical, filterValue } = resolved;

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
    limit: ROUTE_CARRIER_LIMIT,
    grouping: "operating",
  };

  const result: PivotResult = await runPivot(query);
  const totals = routeTotals(result.rows);
  const truncated = result.rows.length >= ROUTE_CARRIER_LIMIT;
  const isEmpty = result.rows.length === 0;

  const columns = buildColumns(allowlist, result.columns);

  // canonical is ALPHABETICAL (routePair.ts); low/high are ordered by ID and can disagree
  // with it (154 of 22,950 routes do). Pairing each half of `canonical` back to its airport
  // by CODE, rather than assuming canonical.split("-") lines up with [low, high], keeps the
  // displayed name attached to the code it is actually under even when the two orderings
  // differ.
  const [codeA, codeB] = canonical.split("-");
  const airports = [low, high];
  const a = airports.find((x) => x.code === codeA) ?? low;
  const b = airports.find((x) => x.code === codeB) ?? high;

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="entity">
          <div className="code">{canonical.replace("-", "–")}</div>
          <div className="ename">
            {a.name} ↔ {b.name}
          </div>
        </div>
        <div className="stats">
          <Stat label="Seats" value={formatSeats(totals.seats)} />
          <Stat label="Load factor" value={formatLoadFactor(totals.loadFactor)} derived />
          <Stat label="Avg gauge" value={formatGauge(totals.avgGauge)} derived />
          <Stat label="Departures" value={formatCount(totals.departures)} />
          <Stat label="Carriers" value={formatCount(result.rows.length)} />
          <Stat label="Quarantined" value={formatCount(result.quarantinedRowsOnPage)} />
        </div>
        <p className="window">
          Trailing 12 months · {query.timeFrom} → {query.timeTo}
        </p>
        <div className="body">
          <div>
            {isEmpty ? (
              <RouteEmptyState query={query} low={low} high={high} />
            ) : (
              <DataTable columns={columns} rows={result.rows} resolved={result.resolved} />
            )}
            {truncated && (
              <p className="foot">
                Showing the top {ROUTE_CARRIER_LIMIT} carriers by seats; the totals above cover
                only these rows.
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
          <LegendRail />
        </div>
      </main>
    </div>
  );
}
