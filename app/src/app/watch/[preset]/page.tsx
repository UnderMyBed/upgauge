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
import { monthsBack, trailing12From } from "@/lib/entityFacts";

// Same reasoning, same constant, as every other DB-touching page (carrier/[code]/page.tsx,
// route/[pair]/page.tsx, explore/page.tsx): this page's content is live warehouse state --
// mart_route_health, rebuilt monthly -- so a statically cached /watch/gauge would keep serving
// a stale leaderboard and a stale DATA AS OF badge forever.
export const dynamic = "force-dynamic";

/** The PRIOR 12-month window mart_route_health diffs against: `asOf-23 .. asOf-12`, exactly the
 * `p12_start_month`/`p12_end_month` sql/02_marts/200_mart_route_health.sql derives. Computed
 * from `asOf` rather than written out, so ReEntryNote below cannot state a window the mart has
 * moved past after a monthly rebuild.
 *
 * `monthsBack`, from lib/entityFacts -- these two numbers are OFFSETS from asOf, not window
 * lengths, and this file used to carry a private `monthsBefore` that spelled an offset the same
 * way components/builder/WindowControl.tsx spelled a length (#155). */
function prior12Window(asOf: string): { from: string; to: string } {
  return { from: monthsBack(asOf, 23), to: monthsBack(asOf, 12) };
}

/** Rows per direction. Every preset's SQL already filters heavily before this file ever sees a
 * row -- the departure floor is mart_route_health's own admission gate rather than any preset's
 * WHERE clause (#148), and on top of that Empty Planes and Death Watch floor on gauge, Death
 * Watch excludes NULL scores, and Route Birth Tracker takes only empty prior windows -- so 25 is a
 * "top of" limit in the same spirit as topn.ts's TOPN_LIMIT, not a truncation boundary -- no
 * disclosure paragraph, matching that precedent. */
const ROWS_PER_TABLE = 25;

/** health_score's own renderer -- pulled out of the column-formatting pipeline entirely and
 * unit-tested directly (page.test.tsx's `describe("formatHealthScore", ...)`).
 *
 * DataTable's generic ColumnSpec `kind`s (`"seats" | "loadFactor" | "gauge" | "count"`) all
 * render a NULL measure as an em-dash (lib/format.ts) -- correct for an ordinary absent
 * measure, and exactly the wrong rendering here. docs/product/features.md's standing UI
 * requirement is that a NULL health_score must never read as unhealthy: all 373 NULL
 * carrier-route pairs (2015-2026 window) are NULL for a data-availability reason -- 297 no prior
 * window, 89 no filed schedule, overlap 13 -- not a low-score reason, and an em-dash in a column this preset
 * sorts ascending reads as the worst row on the page.
 *
 * **The NULL branch is not a defensive edge case -- it is the common case on three of the four
 * presets**, measured against the real warehouse (current window):
 *
 *   - Route Birth Tracker: 297 of 297 rows (100%) -- EVERY row `p12_months_present = 0`
 *     selects has a NULL score, by construction: there is no prior window to diff against, so
 *     "insufficient data" is not one branch among several here, it is the entire page.
 *   - Gauge Watch: 76 of 5,308 rows.
 *   - Empty Planes: 270 of 5,205 rows.
 *   - Route Death Watch is the ONE preset where this function's NULL branch is provably
 *     unreachable in production: `watch_death_watch.sql` filters `WHERE health_score IS NOT
 *     NULL` before a row ever reaches `runPreset()` (see task-6-brief.md's own resolution of
 *     that page's specific ambiguity) -- it is the exception, not the pattern the other three
 *     follow. */
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
    // `kind: "identifier"` on a NUMERIC column is a DELIBERATE, disclosed deviation from
    // CLAUDE.md's "all numerics monospaced, tabular-figure, right-aligned, fixed decimals" --
    // flagged as undeclared by the final whole-branch review and declared here rather than
    // silently changed. `__health_score` is not a number: it is `formatHealthScore`'s output,
    // which is either a two-decimal score or the literal string "insufficient data", and on
    // Route Birth Tracker it is that string on 100% of rows (297 of 297 -- see
    // formatHealthScore's own docstring). DataTable's `kind` is per COLUMN, not per cell, so
    // the alternatives are (a) right-align a column whose every cell on one preset is a
    // sentence, or (b) teach DataTable a per-cell kind for one column on one page. Neither is
    // worth it: `td.id` still renders mono (globals.css), so the score keeps its monospace and
    // loses only the right edge and the tabular-figure lining. If this column ever becomes
    // numeric-only, it should become `kind: "count"`-styled and this comment should go.
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
 * DataTable.test.tsx already covers.
 *
 * `departures_performed` and `active_months` ARE ALIASED, and since #148 that is what makes the
 * floor mark on these rows a COMPUTATION rather than an abstention. The floor is 30 departures
 * per month FLOWN (`lib/floor.ts`; docs/design/system.md), so DataTable needs two fields: a
 * departure count AND the number of months that produced it. Every other table gets both from
 * the pivot, which emits `active_months` beside every result; these rows come from
 * `mart_route_health`, which now carries `t12_months_flown` -- the same count, defined
 * identically (sql/02_marts/200_mart_route_health.sql).
 *
 * NO ROW HERE CAN BE BELOW THE FLOOR, and that is a property of the mart, not of this mapping:
 * its `derived` CTE admits only pairs with `t12_departures_performed >= 30 * t12_months_flown`,
 * so the division DataTable performs is guaranteed to land on or above 30. Before #148 the same
 * "nothing is marked" outcome came from `belowFloor` abstaining on an absent month count, which
 * meant `page.test.tsx`'s pin on it could not fail for the reason it claimed. It is now real:
 * reverting the mart's gate to `t12_departures_performed >= 30` puts 2,454 sub-floor pairs back
 * into the table and reddens that test on Gauge Watch, Empty Planes and Death Watch -- measured,
 * not predicted, and Route Birth Tracker stays green because it ranks by seats.
 *
 * `t12_months_present` is still NOT the field to use: it counts months FILED, while the floor's
 * denominator is months FLOWN. Using it would put a second, subtly different definition of
 * "active months" in the tree -- the defect #134 exists to close, reintroduced by its own fix. */
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
    departures_performed: r.t12_departures_performed,
    active_months: r.t12_months_flown,
  }));
}

/** Same-airport mart rows (`route_key_low = route_key_high`) are real filed traffic between an
 * airport and itself -- not a data error -- but `/route/`'s own resolver refuses to name one a
 * "route" (routePair.ts), and every watch_*.sql file already excludes them
 * (`WHERE route_key_low <> route_key_high`). Stated once, identically, on all four presets --
 * measured: 6 of the 5,611 rows mart_route_health carries over the current window. */
function SameAirportNote() {
  return (
    <p className="foot">
      Same-airport rows (route_key_low = route_key_high -- 6 of 5,611 mart_route_health rows)
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
      Carrier&ndash;route pairs below 50 seats of trailing-12 gauge are excluded from this
      leaderboard: without the
      floor, tiny bush and sightseeing operators dominate with trivial absolute swings rather
      than a genuinely underperforming mainline route (gauge_t12 &gt;= 50, the CRJ-200&rsquo;s
      seat count).
    </p>
  );
}

/** THE DEPARTURE FLOOR, stated on ALL FOUR presets (#148), the same way SameAirportNote is.
 * It is a property of `mart_route_health`, which every preset reads, not of one leaderboard:
 * the mart's `derived` CTE admits only carrier-route pairs performing >= 30 departures per
 * month FLOWN, so every row on every preset here already clears the rate the tables and maps
 * apply (app/src/lib/floor.ts).
 *
 * It used to be Empty Planes' alone and said something different: `t12_departures_performed >=
 * 360`, a flat annual total, described as "the more restrictive of the two" filters. That
 * predicate is gone (watch_empty_planes.sql carries why). It was the reading #134 ruled wrong
 * -- a route flying three months at 40 a month files 120, runs at four times the rate floor,
 * and 360 excluded it anyway -- and it was also a strict subset of the mart's own gate, so
 * restating it as a rate would have enforced nothing.
 *
 * A page that enumerates its filters and omits one cannot be reproduced from what it says,
 * which is why this is stated rather than left implicit now that it applies everywhere. */
function DeparturesFloorNote() {
  return (
    <p className="foot">
      Every row here runs at least 30 performed departures per month flown over the trailing 12
      months. That floor is applied once, to mart_route_health itself, so it holds on all four
      leaderboards &mdash; it is the same rate the data tables and maps mark rows against, not a
      per-leaderboard filter.
    </p>
  );
}

/** Route Birth Tracker's own scope note, and TWO corrections the final whole-branch review
 * forced -- the second one on the fix that closed the first, which is why both are stated here
 * rather than left to the frame.
 *
 * `p12_months_present = 0` means nothing filed in the PRIOR 12 months and something filed in
 * the trailing 12. Two things follow, and the page shipped a false claim about each:
 *
 *   1. It is a RE-ENTRY, not a first appearance. mart_route_health carries no lookback past
 *      that window, so the query cannot distinguish one from the other -- 174 of the 297
 *      qualifying rows (58.6%) filed in some earlier month, B6 AUS-FLL as far back as 2015-01
 *      with 106 distinct months on file. (M6 shipped "first appearance since 2015".)
 *   2. It is a CARRIER-ROUTE PAIR, not a route. The mart's grain is (op_airline_id, route), so
 *      this filter is silent about every OTHER carrier on the same airport pair -- 245 of the
 *      297 (82.5%), and all 25 rows this page renders, had another carrier flying that pair
 *      inside the prior window. (M6 shipped "new service nobody flew last year", and the fix
 *      wave for #1 carried that clause over unexamined.)
 *
 * "mart_route_health carries no lookback", not "this database": fct_route_month spans 2015-01
 * onward and is exactly what both measurements above were taken from. The limitation belongs to
 * the mart, and overstating it as a property of the dataset is the same class of error as the
 * two it is explaining.
 *
 * Counts are written out the way SameAirportNote's and DeathWatchScopeNote's are; the window is
 * computed, since it moves every rebuild. */
function ReEntryNote({ p12From, p12To }: { p12From: string; p12To: string }) {
  return (
    <p className="foot">
      Re-entry, not first appearance &mdash; and a carrier&ndash;route pair, not a route. A pair
      qualifies when this carrier filed nothing at all on this route in the prior 12 months (
      {p12From} to {p12To}) and something in the trailing 12. mart_route_health carries no
      lookback beyond that window, so it cannot tell a brand-new pair from a resumed one:
      measured, 174 of the 297 qualifying pairs (58.6%) had already filed in some earlier month,
      one of them in 106 distinct months going back to 2015-01. Nor does it mean the route was
      unserved &mdash; 245 of the 297 (82.5%) had a <em>different</em> carrier flying the same
      airport pair inside that prior window. A pair that stopped and resumed <em>within</em>
      these two windows is excluded for the mirror-image reason.
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
      373 of 5,611 carrier-route pairs have no health score at all -- no prior-year window, no filed schedule,
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
        <p className="empty-state">
          No carrier&ndash;route pairs currently meet this preset&rsquo;s criteria.
        </p>
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
  const p12 = prior12Window(asOf);

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
            <DeparturesFloorNote />
            {preset.slug === "new-routes" ? <ReEntryNote p12From={p12.from} p12To={p12.to} /> : null}
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
          {/* Only where a rank column exists. `DirectionTable` renders an empty state and NO
              table when its direction has no rows, so a preset whose every direction is empty
              would leave the rail explaining a column the page never drew -- the same defect the
              gap pass found live on 44 `/carrier` pages. Not reachable on today's data; gated
              here because the condition is a fact about the data, not about the code. */}
          <LegendRail ranked={directions.some((d) => d.rows.length > 0)} />
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
