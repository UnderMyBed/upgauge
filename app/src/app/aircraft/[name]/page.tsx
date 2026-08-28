import type { Metadata } from "next";
import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveAircraftSlug } from "@/lib/aircraftSlug";
import { headers } from "next/headers";
import { rawQueryFromHeaders } from "@/lib/rawQuery";
import { BASE_URL } from "@/lib/siteUrl";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import { TopBar } from "@/components/TopBar";
import { AircraftMixChart } from "@/components/AircraftMixChart";
import { MapPicker } from "@/components/MapPicker";
import { SegmentMap } from "@/components/SegmentMap";
import { BY_CARRIER, fetchAircraftMix } from "@/lib/chart/aircraftMix";
import { fetchCarrierTypeNetwork } from "@/lib/map/carrierTypeNetwork";
import { rawFilterValue, resolveCarrierFilter } from "@/lib/map/mapFilter";
import { pickerOptions } from "@/lib/map/picker";
import type { SegmentMapInput } from "@/lib/map/segmentMap";
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

/** WHAT THE FILTER DOES NOT DO, said out loud. `?carrier=` narrows the MAP and nothing else --
 * the stat strip, the chart and the table are the same on `/aircraft/B737-8?carrier=DL` as on
 * `/aircraft/B737-8`, because the map is the only element on this page that needs a carrier to
 * exist at all. A reader who assumes the whole page moved with the filter has been misled by
 * omission, and no other element here says otherwise. One string for the reason `chartWindow`
 * is one string: adjacent JSX expressions put a `<!-- -->` inside a served-bytes needle. */
const MAP_SCOPE_NOTE =
  "The filter applies to the map only — the stat strip, chart and table above cover every carrier.";

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

/** The "ok" branch's whole render, taking the resolved type, the carrier limit AND the raw map
 * filter as explicit inputs -- same split, same reason, as `RouteView` and `ExploreView`:
 * nothing here reaches Next's routing plumbing, so a test can drive it with a real,
 * live-database render (this codebase has no mocks), the truncation disclosure is reachable
 * without waiting for a type with 50 operators, and every outcome of the map section --
 * unfiltered, drawn, nothing to draw, unknown, ambiguous -- is reachable without a request. */
export async function AircraftView({
  type,
  canonical,
  limit = AIRCRAFT_CARRIER_LIMIT,
  carrierFilter = null,
}: {
  type: AircraftRef;
  canonical: string;
  limit?: number;
  /** `?carrier=`'s value as RAW, still-percent-encoded BYTES, or null when the key is absent.
   *  Raw and not decoded: `resolveCarrierFilter` admits on the raw bytes, and handing it a
   *  decoded value is how this page and `proxy.ts` end up with two readings of one URL --
   *  `AircraftPage` below has the full argument. Resolved here rather than by the caller so a
   *  test can drive every outcome of the section with a live database and no header at all. */
  carrierFilter?: string | null;
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

  // RESOLVED BEFORE THE WAVE BELOW, not as a fourth member of it: the map query needs
  // `filter.id`, so joining the resolve into the Promise.all would push the map -- the
  // expensive member -- behind the whole wave instead of alongside it. An absent key costs
  // nothing at all: `resolveCarrierFilter(null)` returns `{ kind: "none" }` without touching
  // the database (mapFilter.ts), which is every crawler hit and every URL in `sitemap.xml`.
  const filter = await resolveCarrierFilter(carrierFilter);

  // CONCURRENT, not sequential awaits -- same reasoning and the same measured saving as /route
  // (docs/architecture/hosting.md): the three share nothing, and connect() hands each its own
  // DuckDBConnection off the single memoized instance, so the wave costs what its slowest
  // member costs.
  //
  // The mix takes the FULL window, not `query`'s trailing 12. "Who adopted this type, and when"
  // is a decade-long question -- the 737-800's answer is that Southwest overtook American in
  // 2018 (measured, and the chart derives that annotation itself) -- and twelve points cannot
  // carry it. The two windows are therefore genuinely different, which is why the `.window`
  // line below names both. The map takes the TABLE's window, and states it itself.

  const [result, mix, map]: [
    PivotResult,
    Awaited<ReturnType<typeof fetchAircraftMix>>,
    SegmentMapInput | null,
  ] = await Promise.all([
    runPivot(query),
    // BY_CARRIER, and this is the point of the page: stacking by aircraft type here would
    // draw ONE band, since the page IS one aircraft type. Stacked by operating carrier the
    // ramp isolates CONFIGURATION choice from FLEET choice -- something /route cannot
    // separate -- and it still encodes something real (measured: F9 fits 230.0 seats into
    // the A321 to B6's 172.3, a 33% spread on identical metal).
    fetchAircraftMix(filters, EARLIEST_MONTH, asOf, BY_CARRIER),
    // `/carrier?type=` and `/aircraft?carrier=` are ONE view entered from two sides -- same
    // query, same renderer, same cap -- so this is `fetchCarrierTypeNetwork` with the two
    // arguments swapped end for end: the type is fixed by the page, the carrier by the
    // filter. It runs ONLY on a resolved filter. An unfiltered page issues no map query,
    // because the query needs both halves and there is no honest default for the missing
    // one: drawing every carrier's routes on this type would be a different map answering a
    // different question, and picking a carrier for the reader is the silent pick the
    // refusal states below exist to refuse.
    //
    // The window is the TABLE's trailing 12, deliberately, not the chart's full window: the
    // map's own footer line states it (`renderSegmentMap`), so the `.window` line above does
    // not restate it. Two hand-written statements of one measurement is how they drift.
    filter.kind === "ok"
      ? fetchCarrierTypeNetwork(filter.id, type.id, query.timeFrom, query.timeTo)
      : null,
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

  // WHAT THE QUARANTINED ROWS DID TO *THESE* NUMBERS, which is not one sentence but two cases
  // (#121, and `airport/[code]/page.tsx` splits the identical two). "Excluded from these totals"
  // is true only while there are totals left to exclude them from. Where every filing in the
  // window was quarantined there is no residue: no measure above can be stated at all, and the
  // carrier count is counted from every row regardless of quarantine -- so it is not net of an
  // exclusion, it is a count OF the excluded rows. Telling a reader otherwise, on a page whose
  // every other figure is an em dash, describes the data as the opposite of what it is.
  //
  // GATED ON BOTH, and the second half is not redundant. `seats === null` covers TWO absences:
  // every filing quarantined, and nothing filed at all. Only the first is a quarantine story;
  // telling the second one that "every filing is quarantined — 0 rows" would invent a finding on
  // 37 retired types to fix it on 2. That case says nothing here and gets its real message from
  // `AircraftEmptyState`.
  //
  // ONE TEMPLATE LITERAL, not adjacent JSX expressions. React's SSR emits `<!-- -->` between
  // adjacent expression children, which `textContent` skips (so a unit test cannot tell) and a
  // raw-bytes grep in app/smoke.sh does not -- the form this paragraph carried before #121 was
  // unreachable from the served-build gate for exactly that reason.
  const quarantineClause =
    totals.seats === null
      ? result.quarantinedRowsOnPage > 0
        ? `Every filing on the ${type.code} in this window is quarantined — ` +
          `${result.quarantinedRowsOnPage} row` +
          `${result.quarantinedRowsOnPage === 1 ? "" : "s"}, each having failed an invariant — ` +
          `so no measure above can be summed. The carrier count is a count of those rows, ` +
          `never clamped.`
        : ""
      : `${result.quarantinedRowsOnPage} quarantined row` +
        `${result.quarantinedRowsOnPage === 1 ? "" : "s"} excluded from these totals, never ` +
        `clamped.`;

  const columns = buildColumns(allowlist, result.columns);

  const hasMap = map !== null;
  const basePath = `/aircraft/${canonical}`;
  // The picker reads the rows the page ALREADY awaited -- this page groups by `op_airline_id`,
  // which is exactly the dimension its map filters on, so the control costs no second query.
  //
  // `filterValueOf` returns the LABEL, which for `op_airline_id` is `displayValue`'s answer:
  // the carrier CODE. `?carrier=` is a code vocabulary, not an id one -- `resolveCarrierFilter`
  // resolves `OO` and refuses `20304` -- so an href built from the raw id would name nothing
  // this server can filter by. It fails LOUDLY if a row's id ever fails to resolve: the label
  // is then the raw id, the href is `?carrier=<id>`, and the server answers with a named
  // refusal rather than a map of the wrong airline.
  //
  // `selected` is the RESOLVED code, never the raw bytes: `aria-current="page"` claims "this is
  // the view you are looking at", and only an `ok` filter has a view.
  const options = pickerOptions({
    rows: result.rows,
    resolved: result.resolved,
    dimKey: "op_airline_id",
    basePath,
    filterKey: "carrier",
    selected: filter.kind === "ok" ? filter.code : null,
    filterValueOf: (_rawId, label) => label,
  });

  // NO SECTION AT ALL on a page whose window is empty and whose reader asked nothing -- the
  // MD-80, retired 2023-04. `AircraftEmptyState` already states that finding in words, and a
  // second panel repeating it is the card soup /route's chart rule refuses. A filter PRESENT on
  // such a page still renders: the reader asked a question and gets an answer, even if the
  // answer is that there is nothing to draw.
  const showMapSection = !isEmpty || filter.kind !== "none";

  // ONE string per note, never adjacent JSX expressions: React's SSR emits `<!-- -->` between
  // adjacent text nodes, which `textContent` skips and a raw-bytes grep in app/smoke.sh does
  // not. Same trap, same fix, as `chartWindow` above.
  //
  // The `ok`-with-no-map arm is EXACT, not a hedge. `fetchCarrierTypeNetwork` returns null only
  // when all three of its categories are empty (`hasNothingToShow`), and a NULL-measure group
  // lands in `quarantinedRoutes` while a same-airport one lands in `sameAirportRoutes` -- so
  // null means every group this carrier filed on this type performed zero departures, or it
  // filed none at all. "Performed no departures" is true of both and claims nothing else.
  //
  // The `unknown` and `ambiguous` kinds get NOTHING here: `MapPicker` owns those two sentences,
  // wires the resolver's own `reason` through, and names every holder. A second wording of a
  // refusal on this page is how the two drift.
  const mapNote =
    filter.kind === "none"
      ? "Pick a carrier to draw the routes it flew this type on — the map draws one carrier at a time."
      : filter.kind === "ok" && !hasMap
        ? `No routes to draw: ${filter.code} performed no departures on the ${type.code} over ${query.timeFrom} → ${query.timeTo}.`
        : null;

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
        {/* THE MAP, above the two-column body -- `/airport`'s placement for the same element
            (airport/[code]/page.tsx: the network map and its year track sit under `main`, not
            inside `.body`), so the two maps on this site are not framed two different ways.

            No heading: `MapPicker` is a labelled `<nav>` carrying its own legend, which is the
            `.year-track` idiom this control was built to follow. A heading here would be the
            only one on the page. */}
        {showMapSection ? (
          <>
            {map !== null ? <SegmentMap map={map} /> : null}
            {mapNote !== null ? <p className="foot">{mapNote}</p> : null}
            <MapPicker options={options} filter={filter} legend="Carrier" truncated={truncated} />
            {/* The way back, which the picker cannot offer: it holds per-option hrefs and no
                base path, so only the page knows the URL of its own unfiltered view. Rendered
                ONLY when a filter value was supplied -- an unfiltered page has nothing to
                clear, and a control that does nothing is worse than no control.

                `MAP_SCOPE_NOTE` is gated on `ok` because on a refusal no filter was applied,
                so "applies to the map only" would describe something that did not happen. */}
            {filter.kind !== "none" ? (
              <div className="foot">
                {filter.kind === "ok" ? <p>{MAP_SCOPE_NOTE}</p> : null}
                <p>
                  <a href={basePath}>Clear the filter</a>
                </p>
              </div>
            ) : null}
          </>
        ) : null}
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
              {quarantineClause} <span className="deriv">Load factor</span> and{" "}
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
              "the five types with the most seats") would be false here.

              `map` is that same rule applied to the section above: the arcs encode three
              independent facts -- width by seats, dash below a 70% load factor, dotted and
              muted below the 30-departure floor (`lib/map/arcs.ts`) -- and nothing else on the
              served page explains any of them. Asked for only when a map was drawn, so an
              unfiltered page does not carry a legend for an element it does not have. */}
          <LegendRail fleetMix={hasMix} stack={BY_CARRIER} map={hasMap} />
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
  const base = { alternates: { canonical: `${BASE_URL}/aircraft/${resolved.canonical}` } };

  // `openGraph` only on "ok" -- "redirect" carries just the uppercased slug, no resolved
  // `AircraftRef` to build an honest description from, and this page never actually serves
  // that outcome's HTML (it 308s before rendering). `ambiguous` and `notFound` already fell
  // through to the empty return above, same as before this task.
  if (resolved.kind !== "ok") return base;

  // Fix round 1: `title: code` alone (e.g. "B737-8") matched `.entity .code` but dropped
  // `.entity .ename` -- the page's heading is TWO elements, and `og:title` is the one string a
  // pasted link previews with. The OG image (Task 6) can drop the name from its own `title`
  // because it carries a separate `subtitle` line; a flat metadata tag has no second line.
  // `${code} — ${name}`, em dash with spaces, matching the design spec's own worked example
  // (docs/superpowers/specs/2026-08-20-og-cards-design.md § Card content: "B737-800") --
  // `resolved.type.name` is reused verbatim (dim_aircraft_type's own full BTS designation,
  // "BOEING 737-800" measured, all-caps as filed), never a second phrasing of it. `code` is
  // still the short_name, never the raw BTS code (M4a's rule).
  const code = resolved.type.code;
  const title = `${code} — ${resolved.type.name}`;
  return {
    ...base,
    openGraph: {
      title,
      description:
        `Monthly US DOT T-100 segment filings for ${code} — seats, load factor and ` +
        `carriers, trailing 12 months. Domestic only, not fares or real-time.`,
    },
  };
}

/** The redirect target for a case-normalized aircraft type slug, carrying the ORIGINAL raw query string
 * through UNCHANGED.
 *
 * #106, and the identical measured bug `/airport` fixed with `airportRedirectTarget`
 * (`app/airport/[code]/page.tsx:497-499`, whose own doc comment has the full account). This
 * page built `/aircraft/${{resolved.canonical}}` from the slug alone, silently dropping every query
 * key -- so once `carrier` became a legitimate key here, `/aircraft/b737-8?carrier=DL` would have 308ed to
 * `/aircraft/B737-8` with the filter gone entirely, and the destination would have rendered the
 * unfiltered view with no error anywhere. That is precisely the "silently renders a different
 * query than the URL encodes" failure this project refuses everywhere else.
 *
 * The query is appended VERBATIM from the raw string, never reconstructed from parsed
 * `searchParams` -- reassembling a query from decoded params is the re-encoding corruption
 * `lib/rawQuery.ts`'s whole header exists to prevent. An empty raw query (no `?` at all on the
 * original request) appends nothing, so a bare `/aircraft/b737-8` still redirects to the bare
 * `/aircraft/B737-8`. */
export function aircraftRedirectTarget(canonical: string, rawQuery: string): string {
  return rawQuery.length > 0
    ? `/aircraft/${canonical}?${rawQuery}`
    : `/aircraft/${canonical}`;
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

  // ONE READING OF THE QUERY STRING, off the raw bytes `proxy.ts` set, feeding BOTH of this
  // page's uses of it: the 308 below, which must carry `?carrier=` through (#106), and the map
  // filter, which must reach the SAME verdict `proxy.ts` already reached about this URL.
  //
  // NEVER `searchParams`, and here that is a stronger rule than the `/airport` `?y=` precedent
  // it resembles. Next decodes `searchParams`; `?y=` tolerates that because `proxy.ts` decodes
  // too (`new URLSearchParams(rawQuery).get("y")`, proxy.ts:430), so both ends agree and the
  // residue is a duplicate cache key. `?carrier=` is admitted on the RAW BYTES --
  // `CARRIER_FILTER_VALUE` forbids `%` structurally (`lib/map/mapFilter.ts`) -- so only one end
  // would decode: a decoded read hands this page `DL` for `?carrier=%44L` while `proxy.ts`
  // refuses that spelling and declines the cache, and the page then applies a filter this
  // server's own admission policy rejected. One owner, two readers, one input.
  //
  // Reconstructing a query string from decoded params is separately the corruption
  // `lib/rawQuery.ts`'s whole header exists to prevent, which is why the redirect target takes
  // this string verbatim.
  //
  // This page therefore takes no `searchParams` prop. A prop nothing reads is a seam that looks
  // wired and is not.
  const rawQuery = rawQueryFromHeaders(await headers());
  const resolved = await resolveAircraftSlugForRequest(slug);

  if (resolved.kind === "redirect") {
    // permanentRedirect -> 308, not redirect()'s 307: the uppercased slug IS the canonical URL
    // for this type. Same source-verified digest as /route (page.test.tsx pins it).
    // #106: the raw query must survive this redirect, or the map filter is silently lost on a
    // miscased slug -- `/aircraft/b737-8?carrier=DL` would 308 to `/aircraft/B737-8` with the
    // filter gone and the destination would render the unfiltered view with no error anywhere.
    permanentRedirect(aircraftRedirectTarget(resolved.canonical, rawQuery));
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
    // Still ENCODED. `rawFilterValue` walks the query with the codec's own `splitPairs` and
    // hands back the bytes as they arrived, which is what `resolveCarrierFilter` admits on.
    carrierFilter: rawFilterValue(rawQuery, "carrier"),
  });
}
