import type { Metadata } from "next";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveAirportCode } from "./resolveAirport";
import { rawQueryFromHeaders } from "@/lib/rawQuery";
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
import { networkArcsDrawn } from "@/lib/map/networkMap";
import { NetworkMap } from "@/components/NetworkMap";
import { AIRCRAFT_MIX_LIMIT } from "@/lib/chart/aircraftMix";
import { mixChartDraws } from "@/lib/chart/mixPlotConfig";
import { fetchAirportNetwork } from "@/lib/map/airportNetwork";
import { EARLIEST_YEAR, parseYear, yearTrack, yearWindow, type ParsedYear } from "@/lib/year";
import { encode } from "@/lib/pivot/urlstate";
import { EARLIEST_MONTH, trailing12From } from "@/lib/entityFacts";
import { quarantineClause } from "@/lib/quarantineClause";
import { formatSeats, formatCount, formatLoadFactor, formatGauge } from "@/lib/format";
import type { AirportRef } from "@/lib/resolve";
import type { Allowlist } from "@/lib/pivot/allowlist";
import type { PivotQuery } from "@/lib/pivot/types";

// Same reasoning as route/[pair]/page.tsx and explore/page.tsx: this page's content depends
// on live warehouse state (dataAsOf(), the pivots), so freezing it at build time would keep
// serving a stale DATA AS OF badge and stale totals to every visitor.
export const dynamic = "force-dynamic";

// Same reasoning, same pattern, as route/[pair]/page.tsx's identically-named wrapper: dedupes
// the slug resolution across `generateMetadata` and the default page export -- two separate
// calls per request in this Next version -- without touching `resolveAirportCode` itself,
// which `proxy.ts` also imports from a non-render context. Full rationale on the route page's
// own copy of this comment; not verifiable by this project's Vitest suite (disclosed in
// task-2-report.md).
const resolveAirportCodeForRequest = cache((slug: string) => resolveAirportCode(slug));

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

/** THIS PAGE'S OWN QUERY, as a single Explorer permalink.
 *
 * `endpoint_airport_id` (M7 Task 3, `filter_only`, `filter_mode='either'`) compiles to
 * `(origin_airport_id IN (...) OR dest_airport_id IN (...))`, so one filter on it reproduces
 * exactly what the carriers table above sums -- verified against the real warehouse: this
 * query returns 53,372,100 seats for SEA over 2025-06..2026-05, the same figure the stat strip
 * prints, not the 26,708,918 an origin-only (or dest-only) half would show.
 *
 * Without an either-endpoint dimension this page can only offer two half permalinks, each
 * labelled as a half -- see endpoints.ts's header for the mechanism and
 * docs/architecture/pipeline.md § Composite and either-endpoint dimensions. */
function endpointQuery(airportId: number, timeFrom: string, timeTo: string): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats", "passengers", "departures_performed", "load_factor", "avg_gauge"],
    timeFrom,
    timeTo,
    filters: [["endpoint_airport_id", [String(airportId)]]],
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
        <a href={exploreHref(endpointQuery(airport.id, EARLIEST_MONTH, timeTo))}>
          Try the same query over {EARLIEST_MONTH} → {timeTo}
        </a>
        , the widest window this data covers.
      </p>
    </div>
  );
}

/** The whole render for a resolved airport, taking the row limit as an explicit input for the
 * same reason `RouteView` does: nothing in production data reaches either truncation branch
 * (measured worst case 1,732 carrier-origin-dest groups against a 5,000 limit, and 4,118
 * (month, type) cells against 10,000 -- both at ORD, M7 Task 3), so the disclosures would be
 * untestable without them. Split from the default export so a test can drive a real,
 * live-database render without going near Next's routing plumbing. */
/** Every month name, so the partial-year disclosure on the track can say "through April 2026"
 * rather than the terser "2026-04" the rest of this page uses for machine-shaped windows --
 * the track's whole job is a plain-language reading of a boundary a visitor is picking by
 * hand, not a permalink. Index 0 is January, matching `Number(asOf.split("-")[1])` 1-indexed. */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `y`'s three-way outcome rendered as a named error, exactly mirroring `/explore`'s own
 * "invalid permalink" contract: state the offending value and the valid range, never fall
 * back to the default view silently. The range is `EARLIEST_YEAR` (this file's own constant,
 * matching every other page's hardcoded `EARLIEST_MONTH`) through `yearTrack(asOf)`'s own last
 * entry -- derived from `asOf`, not a hardcoded "2026", so a future rebuild that extends the
 * window needs no edit here. */
function InvalidYearView({
  airport,
  asOf,
  raw,
}: {
  airport: AirportRef;
  asOf: string;
  raw: string;
}) {
  const track = yearTrack(asOf);
  const latestYear = track[track.length - 1]?.year ?? EARLIEST_YEAR;
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>This year can&rsquo;t be shown</h1>
        <p role="alert">
          {`unknown year '${raw}' — this dataset covers ${EARLIEST_YEAR}–${latestYear}`}
        </p>
        <p>
          Nothing was guessed from it. Pick a year below, or go back to{" "}
          <a href={`/airport/${airport.code}`}>the default trailing-12-month view</a>.
        </p>
      </main>
    </div>
  );
}

export async function AirportView({
  airport,
  limit = AIRPORT_ENDPOINT_LIMIT,
  mixLimit = AIRCRAFT_MIX_LIMIT,
  year = { kind: "default" },
}: {
  airport: AirportRef;
  limit?: number;
  mixLimit?: number;
  year?: ParsedYear;
}) {
  const asOf = await dataAsOf();

  // M7 Task 9: an invalid `y` is a named error, never a silent fallback to the default view --
  // checked and returned BEFORE the allowlist or any pivot runs, since there is nothing valid
  // to query. `proxy.ts` has already independently decided this request is `no-store` for the
  // identical reason (`parseYear(y).kind !== "invalid"`); this is the page-side half of that
  // same contract, not a second definition of it -- both read `lib/year.ts`'s `parseYear`.
  if (year.kind === "invalid") {
    return <InvalidYearView airport={airport} asOf={asOf} raw={year.raw} />;
  }

  const allowlist = await loadAllowlist();
  const trailing12 = trailing12From(asOf);

  // The year track: every calendar year this dataset covers, plus the default trailing-12
  // link. `selectedYear` is null for the default view and the year number for `?y=<year>`
  // (year.kind is "default" | "year" here -- "invalid" already returned above).
  const track = yearTrack(asOf);
  const selectedYear = year.kind === "year" ? year.year : null;
  const selectedEntry =
    selectedYear !== null ? track.find((t) => t.year === selectedYear) : undefined;
  const asOfMonth = Number(asOf.split("-")[1]);

  // The MAP's own window, which is NOT the table's: the default is the trailing 12 (matching
  // the carriers table and stat strip above it, docs/design/system.md § The map), but a
  // selected year replaces it with that bare calendar year (`yearWindow`, Jan-Dec, not clamped
  // to `asOf` -- a query run past `asOf` simply returns no rows for those months). Stating the
  // TABLE's window under a map drawn over a different one would be the exact fabrication
  // CLAUDE.md's chart-window rule already forbids for the aircraft-mix chart, now extended to
  // the map.
  const mapWindow = selectedYear !== null ? yearWindow(selectedYear) : { from: trailing12, to: asOf };

  // CONCURRENT: three pivots in one wave (two through M7 Task 7 -- the map is the third, M7
  // Task 8). They share nothing, and connect() hands each its own DuckDBConnection off the
  // single memoized instance, so the serial form would pay for all three in turn for no
  // reason.
  //
  // The chart takes the FULL window, not the table's trailing 12: a twelve-point stacked area
  // of an airport's fleet mix says almost nothing, and the whole point is the trend. The map
  // takes `mapWindow` -- the trailing 12 by default, or the selected calendar year (M7 Task 9,
  // above). The three windows are why the `.window` line below names all three when the map
  // has something to draw.
  const [traffic, mix, network] = await Promise.all([
    fetchAirportTraffic(airport.id, trailing12, asOf, limit),
    fetchAirportMix(airport.id, EARLIEST_MONTH, asOf, mixLimit),
    fetchAirportNetwork(airport, mapWindow.from, mapWindow.to),
  ]);

  const rows = carrierRows(traffic.rows);
  const totals = airportTotals(traffic.rows, airport.id);
  const isEmpty = rows.length === 0;
  const hasMix = mix.rows.length > 0;
  /** WHETHER THE CHART DREW, which is not whether it has rows (#123). One filed month has rows
   *  and draws a line of text, so `hasMix` is the right gate for RENDERING `AircraftMixChart`
   *  -- it is what makes the absence note appear -- and the wrong one for the legend rail's
   *  fleet-shading group, which would then explain a ramp the reader cannot see. Read from the
   *  chart's own predicate, never re-derived here. */
  const chartDrawn = mixChartDraws(mix.rows);

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

  const hasNetwork = network !== null;
  /** WHETHER AN ARC WAS DRAWN, which is not whether a map was (#123). A hub map always paints
   *  its origin disc, so `/airport/A18` and `/airport/OQZ` render a map with zero polylines --
   *  and the rail's "Arc rendering" group describes three arc encodings and nothing else. Same
   *  rule as `chartDrawn` above, applied to the group beside it. */
  const arcsDrawn = network !== null && networkArcsDrawn(network);
  // Same "one string" discipline as `chartWindow` immediately above, and the same reason: a
  // grep over the served bytes (app/smoke.sh), not `textContent`, is what actually proves this
  // survives to production. States which window the MAP drew, which is the table's trailing
  // 12 only by default -- a selected year replaces it, and saying "trailing 12" under a map
  // drawn over 2019 would be the exact fabrication the aircraft-mix chart's own window line
  // exists to forbid, now extended to the map.
  const mapWindowLabel =
    selectedYear !== null
      ? `calendar year ${selectedYear}${
          selectedEntry?.partial
            ? ` — partial, filed through ${MONTH_NAMES[asOfMonth - 1]} ${asOf.slice(0, 4)} only`
            : ""
        }`
      : "trailing 12 months, matching the table above";
  const mapWindowLine = `map: ${mapWindowLabel}`;

  const columns = buildColumns(allowlist);
  const explorerQuery = endpointQuery(airport.id, trailing12, asOf);

  // ONE string each, not adjacent JSX expressions, for this file's own `chartWindow` reason:
  // React's SSR emits `<!-- -->` between adjacent expression children, which `textContent`
  // skips and a grep over the served bytes (app/smoke.sh) does not.
  //
  // Pluralised because the count is 1 on the three pages this page's null branch exists for,
  // and "1 destinations" under a DATA AS OF badge is the kind of small wrongness that makes a
  // reader doubt the large numbers. Its other half two clauses along has always agreed with
  // its count; this half did not.
  const destinationsClause =
    `${formatCount(totals.destinations)} destination` +
    `${totals.destinations === 1 ? "" : "s"} counted once each.`;

  // ONE implementation, in lib/quarantineClause.ts, shared by all four entity pages. This page
  // is where the three-branch split was first worked out (#118); #121 copied it to the other
  // three, and review found one of those copies was dead string nothing could reach. The cases
  // and the wording now live in one tested place, and this page supplies only its own subject
  // and its own count line -- which really is different here, because /airport states TWO counts.
  const quarantineClauseText = quarantineClause({
    subject: `at ${airport.code}`,
    counts: "The carrier and destination counts are",
    seatsAreNull: totals.seats === null,
    quarantinedRows: totals.quarantinedRows,
  });

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
          {hasNetwork ? (
            <>
              {" "}
              · {mapWindowLine}
            </>
          ) : null}
        </p>
        {/* The network map, above the carriers table: `network` is null exactly when the
            airport filed nothing in `mapWindow` (fetchAirportNetwork's own contract,
            mirroring /route's chart -- a subject with nothing in the window gets NO map,
            never a second empty-state panel repeating what AirportEmptyState already says
            below). Unlike the trailing-12 default, a selected calendar year CAN legitimately
            have nothing filed (ISN's history ends 2019-10; a later year has no rows at all),
            so that case gets its own short note rather than a silent gap under the track. */}
        {hasNetwork ? (
          <NetworkMap network={network} />
        ) : selectedYear !== null ? (
          <p className="foot">{`No filings at ${airport.code} in ${selectedYear}.`}</p>
        ) : null}
        {/* M7 Task 9: the year track. Always rendered, even when the SELECTED year has no map
            to show (above) -- the whole point is that every other year stays one click away.
            `aria-current="page"` marks whichever view is currently showing, matching the
            landmark-navigation pattern rather than inventing a bespoke "selected" attribute. */}
        <nav className="year-track" aria-label="Select a year for the network map">
          <a href={`/airport/${airport.code}`} aria-current={selectedYear === null ? "page" : undefined}>
            Trailing 12 months
          </a>
          {track.map((t) => (
            <a
              key={t.year}
              href={`/airport/${airport.code}?y=${t.year}`}
              aria-current={selectedYear === t.year ? "page" : undefined}
            >
              {/* ONE expression, not two adjacent ones (`{t.year}{t.partial ? "*" : ""}`):
                  React's SSR emits `<!-- -->` between adjacent expression children the same
                  way it does between adjacent text nodes (M4c's own rule, CLAUDE.md), which
                  would put a comment marker inside a served `>2019<`-shaped grep needle. */}
              {`${t.year}${t.partial ? "*" : ""}`}
            </a>
          ))}
        </nav>
        {/* The partial-year disclosure this track exists to make honest: `asOf` ends mid-year
            (2026-04 at the time this was written), so the current year's tick covers only
            through that month. A tick presented identically to a complete year would be the
            same class of false claim as M6's "First appearance since 2015" -- CLAUDE.md names
            it directly. Derived from `track` (itself derived from `asOf`), never a hardcoded
            "2026 is partial", so this stays correct across a rebuild without a code change. */}
        {track.some((t) => t.partial) && (
          <p className="foot">
            {`* ${track.find((t) => t.partial)!.year} is a partial year — filed through ` +
              `${MONTH_NAMES[asOfMonth - 1]} ${asOf.slice(0, 4)} only.`}
          </p>
        )}
        <div className="body">
          <div>
            {hasMix ? <AircraftMixChart rows={mix.rows} title={airport.code} /> : null}
            {/* The chart's own truncation, disclosed separately from the table's: they are two
                separate pivots (one per grain) with separate limits, and either can be short
                while the other is whole. Saying "the totals above" here would be false -- the
                stat strip is fed by the table's pivot, not by this one. */}
            {mix.truncated && (
              <p className="foot">
                The chart hit its {mixLimit}-row limit, so some months or aircraft types are
                missing from it; the table and the totals above are unaffected.
              </p>
            )}
            {isEmpty ? (
              <AirportEmptyState airport={airport} timeFrom={trailing12} timeTo={asOf} />
            ) : (
              <DataTable columns={columns} rows={rows} resolved={traffic.resolved} />
            )}
            {traffic.truncated && (
              <p className="foot">
                Showing the top {limit} carrier–origin–destination groups by seats; the totals
                above cover only those rows.
              </p>
            )}
            <p className="foot">
              Every figure on this page counts {airport.code} at <b>both</b> endpoints —
              departures and arrivals — with the {destinationsClause} {quarantineClauseText}{" "}
              <span className="deriv">Load factor</span> and{" "}
              <span className="deriv">avg gauge</span> are computed at query time from summed
              passengers, seats and performed departures — never averaged.
            </p>
            <p className="foot">
              <a href={exploreHref(explorerQuery)}>Open in the Explorer</a> for the identical
              query, filtered on {airport.code} at either endpoint — every row above is one
              click from the raw rows that produced it.
            </p>
          </div>
          {/* The rail describes the encodings THIS page uses and no others, and DRAWN is the
              test -- not "the data for it exists". `chartDrawn`, never `hasMix`: gating on
              `hasMix` shipped the fleet-shading swatches and the COVID-window sentence beside
              a one-month airport's line of absence text (#123, measured on A18/JZM/OQZ), which
              is the stale "how to read this" the rail exists to replace. `hasNetwork` is
              already the drawn test for the map group -- `NetworkMap` is rendered under the
              same condition and always paints its origin disc.
              The two gates follow the same PATTERN and not the same VALUES: the chart is over
              the full window (EARLIEST_MONTH..asOf) while `hasNetwork` is over `mapWindow`, so
              `?y=<year>` with no filings in that year gives `chartDrawn && !hasNetwork` --
              which is exactly why the branch above renders the chart without the map. */}
          <LegendRail fleetMix={chartDrawn} map={arcsDrawn} />
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
  const base = { alternates: { canonical: `${BASE_URL}/airport/${canonical}` } };

  // `openGraph` only on "ok" -- the "redirect" branch above carries just the uppercased code
  // (no resolved `AirportRef`, so no name to build an honest description from), and this page
  // never actually serves that outcome's HTML (it 308s before rendering). `alternates.canonical`
  // is unchanged for either outcome.
  if (resolved.kind !== "ok") return base;

  // Fix round 1: `title: code` alone (e.g. "SEA") matched `.entity .code` but dropped
  // `.entity .ename` -- the page's heading is TWO elements, and `og:title` is the one string a
  // pasted link previews with. The OG image (Task 6) can afford to drop the name from its own
  // `title` because it carries a separate `subtitle` line; a flat metadata tag has no second
  // line, so the name has to ride in this one string or it never reaches a reader at all.
  // `${code} — ${name}`, em dash with spaces, matching the design spec's own worked example
  // (docs/superpowers/specs/2026-08-20-og-cards-design.md § Card content: "SEA — Seattle/
  // Tacoma Intl") -- `resolved.airport.name` is reused verbatim (dim_airport's own spelling,
  // "Seattle/Tacoma International" measured, not the spec's abbreviated "Intl"), never a
  // second phrasing of it.
  const code = resolved.airport.code;
  const title = `${code} — ${resolved.airport.name}`;
  return {
    ...base,
    openGraph: {
      title,
      // "Both endpoints" names the one thing about this page's figures a reader could
      // otherwise get wrong (CLAUDE.md: an origin-only reading is silently about half the
      // airport). No fare or real-time claim -- this dataset has neither.
      description:
        `Monthly US DOT T-100 segment filings at ${code}, both endpoints — seats, load ` +
        `factor and network, trailing 12 months. Domestic only, not fares or real-time.`,
    },
  };
}

/** The redirect target for a case-normalized airport code, carrying the ORIGINAL raw query
 * string through UNCHANGED.
 *
 * Fix round 1 finding: `AirportPage` used to build `/airport/${canonical}` from the slug
 * alone, silently dropping every query key -- `/airport/sea?y=2019` 308ed to `/airport/SEA`
 * with `y` gone entirely, and the destination silently rendered the trailing-12 default
 * instead of 2019, with no error anywhere. That is precisely the "silently renders a
 * different query than the URL encodes" failure this project refuses everywhere else --
 * it is why `/explore`'s decode is total (never a fallback to a default view) and why an
 * out-of-range `y` here renders a named error rather than quietly reverting.
 *
 * The query is appended VERBATIM from the raw string, never reconstructed from parsed
 * `searchParams` -- reassembling a query from decoded params is exactly the re-encoding
 * corruption `lib/rawQuery.ts`'s whole header exists to prevent (CLAUDE.md's `proxy.ts`
 * section: a comma or colon in a value becomes indistinguishable from a separator once
 * decoded and re-serialized). An empty raw query (no `?` at all on the original request)
 * appends nothing, so a bare `/airport/sea` still redirects to the bare `/airport/SEA`. */
export function airportRedirectTarget(canonical: string, rawQuery: string): string {
  return rawQuery.length > 0 ? `/airport/${canonical}?${rawQuery}` : `/airport/${canonical}`;
}

/** Thin wrapper: resolve the slug, handle the three-way result, hand the "ok" case to
 * `AirportView`. Same split, same reason, as `RoutePage`/`RouteView`. */
export default async function AirportPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  // Optional so every existing call site that never passed it (page.test.tsx's `renderSEA`/
  // `catchDigest`, both predating M7 Task 9) keeps compiling -- Next itself always supplies
  // this at request time regardless of what this type annotation permits; the annotation is
  // for callers, not for Next's own routing.
  searchParams?: Promise<{ y?: string | string[] }>;
}) {
  const { code: slug } = await params;
  const resolved = await resolveAirportCodeForRequest(slug);

  if (resolved.kind === "redirect") {
    // 308, not 307: /airport/SEA IS the canonical URL for this airport, not a temporary
    // relocation. route/[pair]/page.tsx's comment records where that is pinned in Next's own
    // source; page.test.tsx pins the exact digest here too.
    //
    // Fix round 1: the raw query string must survive this redirect, or `?y=<year>` is
    // silently lost on a miscased code (`airportRedirectTarget`'s own doc comment has the
    // full account). Read off the same `RAW_QUERY_HEADER` proxy.ts sets, never off
    // `searchParams` -- by the time this branch runs, `searchParams` has not been read yet,
    // and even if it had, reconstructing a query string from decoded params is the exact
    // corruption this header exists to avoid.
    const requestHeaders = await headers();
    const rawQuery = rawQueryFromHeaders(requestHeaders);
    permanentRedirect(airportRedirectTarget(resolved.canonical, rawQuery));
  }
  if (resolved.kind === "notFound") {
    notFound();
  }

  // `y` follows /search's own precedent for a bare, delimiter-free query value (SearchPage's
  // own comment): read straight off `searchParams` rather than through proxy.ts's raw-header
  // machinery, because a bare four-digit year carries none of the Explorer permalink's `,`/`:`
  // delimiters that decoding makes ambiguous (lib/rawQuery.ts). `proxy.ts` DOES read it off the
  // raw header (its own doc comment explains why -- cacheability must be decided before this
  // page runs at all, and that happens in a different file with a different raw string), but
  // that is a distinct concern from how THIS page reads the same key for its own render.
  const sp = searchParams ? await searchParams : {};
  const rawY = sp.y;
  const y = Array.isArray(rawY) ? (rawY[0] ?? null) : (rawY ?? null);

  // Called directly rather than as <AirportView .../>: this codebase's tests render the result
  // of `await AirportPage(...)` through react-dom's ordinary client renderer, which cannot
  // await a nested async component reached via JSX. Equivalent under Next's real RSC renderer.
  return await AirportView({ airport: resolved.airport, year: parseYear(y) });
}
