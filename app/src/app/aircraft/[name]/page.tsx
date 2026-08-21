import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveAircraftSlug } from "@/lib/aircraftSlug";
import { BASE_URL } from "@/lib/siteUrl";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import { TopBar } from "@/components/TopBar";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import { BY_CARRIER, fetchAircraftMix } from "@/lib/chart/aircraftMix";
import { encode } from "@/lib/pivot/urlstate";
import {
  AIRCRAFT_CARRIER_LIMIT,
  EARLIEST_MONTH,
  sumTotals,
  trailing12Query,
} from "@/lib/entityFacts";
import { formatSeats, formatCount, formatLoadFactor, formatGauge } from "@/lib/format";
import type { AircraftRef } from "@/lib/resolve";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";

// Same reasoning as route/[pair]/page.tsx and explore/page.tsx: this page's content depends on
// live warehouse state (dataAsOf(), the pivot result), so a statically-cached render would keep
// serving a stale DATA AS OF badge and stale totals to every visitor.
export const dynamic = "force-dynamic";

// Same reasoning, same pattern, as route/[pair]/page.tsx's identically-named wrapper: dedupes
// the slug resolution across `generateMetadata` and the default page export without touching
// `resolveAircraftSlug` itself, which `proxy.ts` also imports from a non-render context. Full
// rationale on the route page's own copy of this comment; not verifiable by this project's
// Vitest suite (disclosed in task-2-report.md).
const resolveAircraftSlugForRequest = cache((slug: string) => resolveAircraftSlug(slug));

// fct_segment_month exposes quarantine bookkeeping columns alongside every measure a query
// asked for -- the stat strip surfaces the count, but they are not pivot-vocabulary columns and
// must never appear as a table column.
const NON_DISPLAY_COLUMNS = new Set(["quarantined_rows", "quarantine_reasons"]);

const KIND: Record<string, ColumnSpec["kind"]> = {
  seats: "seats",
  passengers: "seats",
  load_factor: "loadFactor",
  avg_gauge: "gauge",
  departures_performed: "count",
};

/** Same fallback as /route's and /explore's identically-named function: a measure the KIND
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

/** The permalink for the identical query against the Explorer, widened to `EARLIEST_MONTH` when
 * asked -- shared by the Explorer link and the empty state's widened-window offer, so both
 * always agree on what "the same query" means. */
function exploreHref(query: PivotQuery, timeFrom?: string): string {
  return `/explore?${encode(timeFrom === undefined ? query : { ...query, timeFrom })}`;
}

/** "Nobody flew this type last year" is DATA, not an error: the type resolved, the query is
 * valid, and zero rows is the honest answer. It is also the interesting answer here -- the
 * MD-80 filed 68 months and stopped in 2023-04 (measured), so this state IS the retirement, and
 * the chart above it is the story. Mirrors /route's and /explore's empty states: state the
 * finding in words, offer the widened-to-2015 permalink, never a blank panel. */
function AircraftEmptyState({ query, type }: { query: PivotQuery; type: AircraftRef }) {
  const wider = query.timeFrom > EARLIEST_MONTH ? exploreHref(query, EARLIEST_MONTH) : null;
  return (
    <div className="empty-state">
      <p>
        No filings for {type.name} ({type.code}) over {query.timeFrom} → {query.timeTo}.
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

/** The "ok" branch's whole render, taking the resolved type AND the carrier limit as explicit
 * inputs -- same split, same reason, as `RouteView` and `ExploreView`: nothing here reaches
 * Next's routing plumbing, so a test can drive it with a real, live-database render (this
 * codebase has no mocks), and the truncation disclosure is reachable without waiting for a type
 * with 50 operators. */
export async function AircraftView({
  type,
  canonical,
  limit = AIRCRAFT_CARRIER_LIMIT,
}: {
  type: AircraftRef;
  canonical: string;
  limit?: number;
}) {
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();

  // The filter value is the BTS `code` as a STRING -- CLAUDE.md's zero-padding rule. 13
  // fact-present types have a leading zero ('036'), and Number()-ing it here would silently
  // match nothing and render an empty page for a type that flies every day.
  const filters: [string, string[]][] = [["aircraft_type", [type.id]]];

  // The SAME query object this route's `opengraph-image` builds, from the same module, so the
  // card's stat row cannot disagree with the stat strip below (lib/entityFacts.ts).
  const query: PivotQuery = trailing12Query({
    dimensions: ["op_airline_id"],
    filters,
    asOf,
    limit,
  });

  // CONCURRENT, not two sequential awaits -- same reasoning and the same measured saving as
  // /route (docs/architecture/hosting.md): the two pivots share nothing, and connect() hands
  // each its own DuckDBConnection off the single memoized instance, so the pair now costs what
  // its slower half costs.
  //
  // The mix takes the FULL window, not `query`'s trailing 12. "Who adopted this type, and when"
  // is a decade-long question -- the 737-800's answer is that Southwest overtook American in
  // 2018 (measured, and the chart derives that annotation itself) -- and twelve points cannot
  // carry it. The two windows are therefore genuinely different, which is why the `.window`
  // line below names both.
  const [result, mix]: [PivotResult, Awaited<ReturnType<typeof fetchAircraftMix>>] =
    await Promise.all([
      runPivot(query),
      // BY_CARRIER, and this is the point of the page: stacking by aircraft type here would
      // draw ONE band, since the page IS one aircraft type. Stacked by operating carrier the
      // ramp isolates CONFIGURATION choice from FLEET choice -- something /route cannot
      // separate -- and it still encodes something real (measured: F9 fits 230.0 seats into
      // the A321 to B6's 172.3, a 33% spread on identical metal).
      fetchAircraftMix(filters, EARLIEST_MONTH, asOf, BY_CARRIER),
    ]);

  const totals = sumTotals(result.rows);
  const truncated = result.rows.length >= limit;
  const isEmpty = result.rows.length === 0;
  const hasMix = mix.length > 0;
  // The range the chart can DRAW, which is not the range it was fetched over -- 39 of the 112
  // fact-present types last filed before the current trailing-12 window (measured), so naming
  // the requested window here would put "2015-01 → 2026-04" over a chart that stops in 2023.
  // Months are zero-padded YYYY-MM, so lexical min/max IS chronological.
  const drawnFrom = hasMix ? mix.reduce((m, r) => (r.month < m ? r.month : m), mix[0].month) : null;
  const drawnTo = hasMix ? mix.reduce((m, r) => (r.month > m ? r.month : m), mix[0].month) : null;
  const drawsFullWindow = drawnFrom === EARLIEST_MONTH && drawnTo === asOf;
  // ONE string, not adjacent JSX expressions: React's SSR emits `<!-- -->` between adjacent
  // text nodes, which `textContent` skips (so every unit test stays green) and a raw-bytes grep
  // in app/smoke.sh does not. Same trap, same fix, as /route's identically-named value.
  const chartWindow = `chart: ${drawsFullWindow ? "the full window · " : ""}${drawnFrom} → ${drawnTo}`;

  const columns = buildColumns(allowlist, result.columns);

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="entity">
          {/* The short_name, never the BTS code (M4a's rule, and lookup_aircraft_by_name.sql's
              own header): '614' identifies the 737-800 in the warehouse and identifies nothing
              at all to a reader. */}
          <div className="code">{type.code}</div>
          <div className="ename">{type.name}</div>
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
          {hasMix ? <> · {chartWindow}</> : null}
        </p>
        <div className="body">
          <div>
            {hasMix ? (
              <AircraftMixChart rows={mix} title={canonical} dimension={BY_CARRIER} />
            ) : null}
            {isEmpty ? (
              <AircraftEmptyState query={query} type={type} />
            ) : (
              <DataTable columns={columns} rows={result.rows} resolved={result.resolved} />
            )}
            {truncated && (
              <p className="foot">
                Showing the top {limit} carriers by seats; the totals above cover only these rows.
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
              Every row is what the carrier <em>operated</em>: a Delta-branded regional flown by
              Endeavor files under 9E, not DL, so summing the rows above does not double-count.
            </p>
            <p className="foot">
              <a href={exploreHref(query)}>Open in the Explorer</a> for the identical query -- every
              row above is one click from the raw rows that produced it.
            </p>
          </div>
          {/* `stack` and not just `fleetMix`: the rail describes the encodings THIS page uses,
              and this chart's bands are carriers, so the type-stack wording ("larger metal",
              "the five types with the most seats") would be false here. */}
          <LegendRail fleetMix={hasMix} stack={BY_CARRIER} />
        </div>
      </main>
    </div>
  );
}

/** The self-referential canonical `<link>`, re-resolved from the slug rather than built from it
 * verbatim. Both the "ok" and "redirect" branches of `AircraftSlugResult` carry `canonical`
 * (aircraftSlug.ts: the uppercased slug), so `/aircraft/a320-1-2` declares `/aircraft/A320-1-2`
 * as canonical -- the bug this excludes is building the tag from `slug` directly. `ambiguous`
 * has no single canonical form to declare (that is the entire content of its 404, see
 * `AircraftPage` below), so it falls through to the same empty return as `notFound`. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name: slug } = await params;
  const resolved = await resolveAircraftSlugForRequest(slug);
  if (resolved.kind !== "ok" && resolved.kind !== "redirect") return {};
  return { alternates: { canonical: `${BASE_URL}/aircraft/${resolved.canonical}` } };
}

/** Thin wrapper: the ONLY job here is resolving the slug and handling the four-way
 * `AircraftSlugResult` before handing the "ok" case to `AircraftView`. Same split as
 * `RoutePage`/`RouteView`.
 *
 * `ambiguous` is a 404, and the choice is deliberate. `/aircraft/CE-180` names TWO fact-present
 * airframes (codes 030 and 031, both of which really flew), so there is no entity at this URL --
 * "not found" is literally true, and it is the outcome that gets `no-store` from the proxy, which
 * is right for an answer that changes when the dataset does. The candidates are not thrown away:
 * `not-found.tsx` re-runs the same resolution and names both airframes with a working Explorer
 * link for each, which is the honest form of "we will not pick one for you". */
export default async function AircraftPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: slug } = await params;
  const resolved = await resolveAircraftSlugForRequest(slug);

  if (resolved.kind === "redirect") {
    // permanentRedirect -> 308, not redirect()'s 307: the uppercased slug IS the canonical URL
    // for this type. Same source-verified digest as /route (page.test.tsx pins it).
    permanentRedirect(`/aircraft/${resolved.canonical}`);
  }
  if (resolved.kind === "notFound" || resolved.kind === "ambiguous") {
    notFound();
  }

  // Called directly rather than as `<AircraftView .../>`: this codebase's tests render the
  // result of `await AircraftPage(...)` through react-dom's ordinary client renderer, which --
  // unlike Next's RSC renderer -- cannot await a nested async component reached via JSX.
  // Equivalent under Next's real RSC rendering either way.
  return await AircraftView({
    type: resolved.type,
    canonical: resolved.canonical,
  });
}
