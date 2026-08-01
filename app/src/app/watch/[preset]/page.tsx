import { notFound } from "next/navigation";
import { dataAsOf, loadAllowlist } from "@/lib/db";
import {
  presetBySlug,
  runPreset,
  rawRowsPermalink,
  routeCellHref,
  type Preset,
  type WatchRow,
} from "@/lib/watch";
import { resolveRows, resolutionKey, displayValue, type Resolved } from "@/lib/resolve";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import { TopBar } from "@/components/TopBar";
import type { Allowlist } from "@/lib/pivot/allowlist";

// Same reasoning, same constant, as every other DB-touching page (carrier/[code]/page.tsx,
// route/[pair]/page.tsx, explore/page.tsx): this page's content is live warehouse state --
// mart_route_health, rebuilt monthly -- so a statically cached /watch/gauge would keep serving
// a stale leaderboard and a stale DATA AS OF badge forever.
export const dynamic = "force-dynamic";

/** The trailing-12-month window every preset ranks over, computed from `asOf` the same way
 * mart_route_health's own t12 window is (sql/02_marts/200_mart_route_health.sql), and the same
 * derivation carrier/[code]/page.tsx and route/[pair]/page.tsx each carry their own copy of. */
function trailing12From(asOf: string): string {
  const [y, m] = asOf.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 11, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Rows per direction. Every preset's SQL already floors and filters heavily (a gauge floor, a
 * departures floor, a NULL-score exclusion) before this file ever sees a row, so 25 is a
 * "top of" limit in the same spirit as topn.ts's TOPN_LIMIT, not a truncation boundary -- no
 * disclosure paragraph, matching that precedent. */
const ROWS_PER_TABLE = 25;

/** health_score's own renderer -- pulled out of the column-formatting pipeline entirely and
 * unit-tested directly (page.test.tsx's `describe("formatHealthScore", ...)`).
 *
 * DataTable's generic ColumnSpec `kind`s (`"seats" | "loadFactor" | "gauge" | "count"`) all
 * render a NULL measure as an em-dash (lib/format.ts) -- correct for an ordinary absent
 * measure, and exactly the wrong rendering here. docs/product/features.md's standing UI
 * requirement is that a NULL health_score must never read as unhealthy: all 813 NULL routes
 * (2015-2026 window) are NULL for a data-availability reason -- 688 no prior window, 180 no
 * filed schedule, overlap 55 -- not a low-score reason, and an em-dash in a column this preset
 * sorts ascending reads as the worst row on the page.
 *
 * In production no row this function sees is ever NULL: watch_death_watch.sql (the only preset
 * that surfaces health_score as its sort key) filters `WHERE health_score IS NOT NULL` before a
 * row reaches runPreset() at all -- see task-6-brief.md's own resolution of this exact
 * ambiguity. The NULL branch stays because Gauge Watch, Empty Planes and Route Birth Tracker
 * also render this column (docs/design/system.md: "every row carries the component values, not
 * just the composite score") and rank on axes OTHER than health_score, so a route with a NULL
 * score can still appear as a ROW on those three tables. */
export function formatHealthScore(score: unknown): string {
  if (score === null || score === undefined) return "insufficient data";
  const n = Number(score);
  return Number.isNaN(n) ? "insufficient data" : n.toFixed(2);
}

/** The route dimension's two underlying columns, read from the catalog rather than hardcoded --
 * same derivation, same reason, as carrier/[code]/page.tsx's identically-named function: a
 * renamed fact column breaks loudly at the catalog instead of silently here. mart_route_health
 * names its own two columns identically (`route_key_low`, `route_key_high`), which is what
 * makes reusing `resolveRows` -- built for pivot output, not this mart -- possible at all. */
function routeDimColumns(allowlist: Allowlist): string[] {
  return (
    allowlist.dims
      .get("route")
      ?.columnExpr.split(",")
      .map((c) => c.trim()) ?? []
  );
}

/** Same three functions as carrier/[code]/page.tsx's routeCodes/routeCode/routeLinkHref,
 * duplicated rather than shared for the same reason that page's own copy gives (each page's
 * `buildColumns`-shaped assembly is already its own local copy of this shape) -- adapted here
 * to call `routeCellHref` (watch.ts), the canonical, code-alphabetical /route/ URL builder
 * watch.test.ts already pins against the USA/LAL fixture, rather than re-deriving the ordering
 * rule a third time. */
function routeCodes(row: WatchRow, resolved: Map<string, Resolved>, columns: string[]): string[] {
  return columns.map((c) => displayValue(resolved.get(resolutionKey(c, row[c])), row[c]));
}

function routeCode(row: WatchRow, resolved: Map<string, Resolved>, columns: string[]): string {
  return routeCodes(row, resolved, columns).join("–");
}

function routeLinkHref(
  row: WatchRow,
  resolved: Map<string, Resolved>,
  columns: string[],
): string | null {
  const hits = columns.map((c) => resolved.get(resolutionKey(c, row[c])));
  if (hits.some((h) => h === undefined || h.code === null)) return null;
  const [a, b] = hits as Resolved[];
  if (a.code === b.code) return null;
  return routeCellHref(a.code as string, b.code as string);
}

/** Label, kind and derived-ness for every mart_route_health column this page surfaces, in
 * display order. One shared table rather than four per-preset copies: every preset SELECTs the
 * identical column list (watch_gauge.sql, watch_empty_planes.sql, watch_new_routes.sql,
 * watch_death_watch.sql all carry the same SELECT), so there is nothing preset-specific to
 * parameterize here. */
const MEASURE_COLUMNS: ReadonlyArray<{
  key: string;
  label: string;
  kind: ColumnSpec["kind"];
  derived: boolean;
}> = [
  { key: "lf_t12", label: "Load factor, t12", kind: "loadFactor", derived: true },
  { key: "lf_delta", label: "Δ Load factor", kind: "loadFactor", derived: true },
  { key: "gauge_t12", label: "Gauge, t12", kind: "gauge", derived: true },
  { key: "gauge_delta", label: "Δ Gauge", kind: "gauge", derived: true },
  { key: "capacity_delta", label: "Δ Capacity", kind: "loadFactor", derived: true },
  { key: "frequency_delta", label: "Δ Frequency", kind: "loadFactor", derived: true },
  { key: "completion_factor", label: "Completion factor", kind: "loadFactor", derived: true },
  { key: "t12_seats", label: "Seats, trailing 12mo", kind: "seats", derived: false },
  {
    key: "t12_departures_performed",
    label: "Departures, trailing 12mo",
    kind: "count",
    derived: false,
  },
  { key: "t12_quarantined_rows", label: "Quarantined rows", kind: "count", derived: false },
];

/** Columns for one preset's table: the composite route cell, the carrier, the score (labeled
 * plainly as a heuristic -- system.md), every component (system.md: "the components are the
 * insight, the score is a sort key"), and a per-row link to the raw rows behind it (CLAUDE.md:
 * "every insight row is one click from the raw rows that produced it"). */
function buildColumns(
  resolved: Map<string, Resolved>,
  routeCols: string[],
  timeFrom: string,
  timeTo: string,
): ColumnSpec[] {
  return [
    {
      key: "__route",
      label: "Route",
      kind: "identifier",
      href: (row) => routeLinkHref(row as unknown as WatchRow, resolved, routeCols),
    },
    { key: "op_airline_id", label: "Carrier", kind: "identifier", dimKey: "op_airline_id" },
    { key: "__health_score", label: "Health score (heuristic)", kind: "identifier", derived: true },
    ...MEASURE_COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.kind, derived: c.derived })),
    {
      key: "__explore",
      label: "Raw rows",
      kind: "identifier",
      href: (row) => rawRowsPermalink(row as unknown as WatchRow, timeFrom, timeTo),
    },
  ];
}

/** `rows` transformed into what DataTable actually renders: the composite route string, the
 * pre-formatted score, and a static link label -- plus two field ALIASES, `avg_gauge` and
 * `quarantined_rows`, which are DataTable's own fixed, hardcoded field reads (its gauge rail and
 * its reason-code gutter are not driven by ColumnSpec at all -- see DataTable.tsx). Both are the
 * SAME measure DataTable expects, summed/averaged over the trailing 12 months here instead of
 * one: `gauge_t12` IS seats-per-departure, so the rail draws a real, meaningful tick instead of
 * rendering empty on every row; `t12_quarantined_rows` IS a count of quarantined underlying
 * segment-month rows, so the `Q` gutter mark -- which DataTable already shows only when
 * non-zero -- is how this page surfaces it, rather than a bespoke mechanism duplicating logic
 * DataTable.test.tsx already covers. `load_factor` and `departures_performed` are deliberately
 * NOT aliased: DataTable's `n` (below-floor) mark is calibrated to a MONTHLY 30-departure floor
 * (docs/design/system.md's legend text, "min 30 departures/mo"), and `t12_departures_performed`
 * is a twelve-month sum -- aliasing it would either never fire (every mart row already clears
 * 30 by construction) or, worse, silently change meaning if that floor is ever edited. */
function displayRows(
  rows: WatchRow[],
  resolved: Map<string, Resolved>,
  routeCols: string[],
): Record<string, unknown>[] {
  return rows.map((r) => ({
    ...r,
    __route: routeCode(r, resolved, routeCols),
    __health_score: formatHealthScore(r.health_score),
    __explore: "Explorer",
    avg_gauge: r.gauge_t12,
    quarantined_rows: r.t12_quarantined_rows,
  }));
}

/** Same-airport mart rows (`route_key_low = route_key_high`) are real filed traffic between an
 * airport and itself -- not a data error -- but `/route/`'s own resolver refuses to name one a
 * "route" (routePair.ts), and every watch_*.sql file already excludes them
 * (`WHERE route_key_low <> route_key_high`). Stated once, identically, on all four presets --
 * measured: 71 of the 8,080 rows mart_route_health carries over the current window. */
function SameAirportNote() {
  return (
    <p className="foot">
      Same-airport rows (route_key_low = route_key_high -- 71 of 8,080 mart_route_health rows)
      are excluded from every preset here: a route is between two different airports.
    </p>
  );
}

/** Empty Planes and Death Watch both filter `gauge_t12 &gt;= 50` -- the CRJ-200's seat count, a
 * real airframe boundary, not a round number (watch_empty_planes.sql, watch_death_watch.sql).
 * Stated in words rather than left implicit: without it, both leaderboards are dominated by
 * bush and sightseeing operators whose absolute swings are trivial. */
function GaugeFloorNote() {
  return (
    <p className="foot">
      Routes below 50 seats of trailing-12 gauge are excluded from this leaderboard: without the
      floor, tiny bush and sightseeing operators dominate with trivial absolute swings rather
      than a genuinely underperforming mainline route (gauge_t12 &gt;= 50, the CRJ-200&rsquo;s
      seat count).
    </p>
  );
}

/** docs/product/features.md's three-reason NULL contract, restated on the one preset that ranks
 * BY health_score: a route this database cannot score (no prior-year window to diff against, no
 * filed schedule to complete, or both) is left off Death Watch entirely rather than rendered
 * last under an em-dash, which the standing UI requirement forbids reading as "unhealthy". */
function DeathWatchScopeNote() {
  return (
    <p className="foot">
      813 of 8,080 routes have no health score at all -- no prior-year window, no filed schedule,
      or both -- and are excluded from this leaderboard entirely, never silently ranked worst.
    </p>
  );
}

interface DirectionResult {
  heading: string;
  rows: WatchRow[];
  resolved: Map<string, Resolved>;
}

function DirectionTable({
  heading,
  result,
  routeCols,
  timeFrom,
  timeTo,
}: {
  heading: string;
  result: DirectionResult;
  routeCols: string[];
  timeFrom: string;
  timeTo: string;
}) {
  if (result.rows.length === 0) {
    return (
      <section>
        <h2>{heading}</h2>
        <p className="empty-state">No routes currently meet this preset&rsquo;s criteria.</p>
      </section>
    );
  }
  const columns = buildColumns(result.resolved, routeCols, timeFrom, timeTo);
  const rows = displayRows(result.rows, result.resolved, routeCols);
  return (
    <section>
      <h2>{heading}</h2>
      <DataTable columns={columns} rows={rows} resolved={result.resolved} rank />
    </section>
  );
}

/** The "ok" branch's whole render, taking the resolved preset as its only input -- same split,
 * same reason, as CarrierView/RouteView: nothing here touches Next's routing plumbing, so a
 * test can drive it with a real, live-database render. */
export async function WatchPresetView({ preset }: { preset: Preset }) {
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();
  const timeFrom = trailing12From(asOf);
  const routeCols = routeDimColumns(allowlist);

  // CONCURRENT, not sequential -- same reasoning as carrier/[code]/page.tsx's Promise.all over
  // its four pivots: each direction's runPreset() and resolveRows() share nothing.
  const directions: DirectionResult[] = await Promise.all(
    preset.directions.map(async (d) => {
      const rows = await runPreset(preset, d.direction, ROWS_PER_TABLE);
      const resolved = await resolveRows(rows as unknown as Record<string, unknown>[], allowlist);
      return { heading: d.heading, rows, resolved };
    }),
  );

  const showGaugeFloor = preset.slug === "empty-planes" || preset.slug === "death-watch";

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <h1>{preset.title}</h1>
        <div className="body">
          <div>
            <p className="frame">{preset.frame}</p>
            <SameAirportNote />
            {showGaugeFloor ? <GaugeFloorNote /> : null}
            {preset.slug === "death-watch" ? <DeathWatchScopeNote /> : null}
            {directions.map((d) => (
              <DirectionTable
                key={d.heading}
                heading={d.heading}
                result={d}
                routeCols={routeCols}
                timeFrom={timeFrom}
                timeTo={asOf}
              />
            ))}
          </div>
          <LegendRail />
        </div>
      </main>
    </div>
  );
}

/** Thin wrapper: the ONLY job here is resolving the slug and handing the "ok" case to
 * WatchPresetView -- same split as carrier/[code]/page.tsx's CarrierPage/CarrierView.
 * `presetBySlug` returns `null` for an unknown slug, never a default preset (watch.ts's own
 * docstring), so the only outcome besides "ok" is a 404 -- there is no redirect case, unlike
 * /carrier and /route, because a preset slug has no alternate casing or historical alias to
 * canonicalize. */
export default async function WatchPresetPage({
  params,
}: {
  params: Promise<{ preset: string }>;
}) {
  const { preset: slug } = await params;
  const preset = presetBySlug(slug);
  if (preset === null) {
    notFound();
  }
  return await WatchPresetView({ preset });
}
