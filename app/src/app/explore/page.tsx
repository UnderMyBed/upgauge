import { decode, encode, UrlStateError } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import { LegendRail } from "@/components/LegendRail";
import type { PivotQuery } from "@/lib/pivot/types";
import type { Allowlist } from "@/lib/pivot/allowlist";

// searchParams is a request-time API (Next 16, App Router): reading it already opts this
// page into dynamic rendering. The explicit export documents that intent rather than
// relying on it being implicit -- a permalink page that got statically cached at build time
// would silently serve one frozen query to every visitor.
export const dynamic = "force-dynamic";

const KIND: Record<string, ColumnSpec["kind"]> = {
  seats: "seats",
  passengers: "seats",
  freight: "seats",
  mail: "seats",
  asm: "seats",
  rpm: "seats",
  load_factor: "loadFactor",
  completion_factor: "loadFactor",
  avg_gauge: "gauge",
  departures_performed: "count",
  departures_scheduled: "count",
  air_time: "count",
};

// fct_{segment,route}_month expose quarantine bookkeeping columns alongside every dimension
// and measure a query asked for (sql/03_queries/pivot_segment.sql, pivot_route.sql) -- the
// gutter/foot text surfaces them, but they are not columns of the pivot vocabulary and must
// never appear as a DataTable column.
const NON_DISPLAY_COLUMNS = new Set(["quarantined_rows", "quarantine_reasons"]);

// data/raw/ holds the full 2015-2026 window (CLAUDE.md's Status section) -- this is the
// widest time window any query against this database can have, so it is what "offer the
// nearest broader window" (docs/design/system.md, empty-result state) widens to.
const EARLIEST_MONTH = "2015-01";

function toQueryString(sp: Record<string, string | string[] | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) parts.push(`${k}=${one}`);
  }
  return parts.join("&");
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "State the query in words" (docs/design/system.md, empty-result state): every dimension,
 * the time window, and every filter, using the catalog's own labels so this can never name
 * a dimension differently than the table header above it would have. */
function describeQuery(query: PivotQuery, allowlist: Allowlist): string {
  const dimLabels = query.dimensions
    .map((d) => allowlist.dims.get(d)?.label ?? d)
    .join(", ");
  const filterText = query.filters.length
    ? `, filtered to ${query.filters
        .map(([k, vals]) => `${allowlist.dims.get(k)?.label ?? k}: ${vals.join(", ")}`)
        .join("; ")}`
    : "";
  return `${capitalize(query.grain)} data grouped by ${dimLabels}, ${query.timeFrom} → ${query.timeTo}${filterText}`;
}

/** The permalink for the same query widened to the full 2015-2026 window, or null when the
 * query already starts at EARLIEST_MONTH -- there is no broader window left to offer. */
function widerWindowHref(query: PivotQuery): string | null {
  if (query.timeFrom <= EARLIEST_MONTH) return null;
  return `/explore?${encode({ ...query, timeFrom: EARLIEST_MONTH })}`;
}

function Wordmark() {
  // docs/design/mockups/table.html's .mark: "UP" in --ink, "GAUGE" in --signal.
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

/** Valid query, zero matching rows -- a normal state in T-100, not an error
 * (docs/design/system.md, "Empty (valid query, no rows)"). The header, stat strip and
 * legend rail stay exactly as they are for a populated result; only the table area is
 * replaced, and never with a blank panel. */
function EmptyState({ query, allowlist }: { query: PivotQuery; allowlist: Allowlist }) {
  const wider = widerWindowHref(query);
  return (
    <div className="empty-state">
      <p>No rows match {describeQuery(query, allowlist)}.</p>
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

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const qs = toQueryString(await searchParams);
  const allowlist = await loadAllowlist();
  const asOf = await dataAsOf();

  // Only decode() is guarded: it is the sole step that validates untrusted request input
  // (the URL) against the allowlist, and UrlStateError is the one exception it documents
  // itself with. A permalink that quietly rendered a different query than it encodes would
  // be worse than one that errors -- the screenshot would still look authoritative -- so an
  // invalid key here always renders a named error, never a fallback to a default view.
  let query: PivotQuery;
  try {
    query = decode(qs, allowlist);
  } catch (e) {
    if (e instanceof UrlStateError) {
      return (
        <div className="wrap">
          <TopBar asOf={asOf} />
          <main className="error-page">
            <h1>This permalink can&rsquo;t be read</h1>
            <p role="alert">{e.message}</p>
            <p>
              Nothing was guessed from it. Fix the offending key above and reload, or start
              from{" "}
              <a href="/explore?v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op">
                a known-valid query
              </a>
              .
            </p>
          </main>
        </div>
      );
    }
    throw e;
  }

  const permalink = encode(query);
  const result: PivotResult = await runPivot(query);
  const isEmpty = result.rows.length === 0;

  const columns: ColumnSpec[] = result.columns
    .filter((c) => !NON_DISPLAY_COLUMNS.has(c))
    .map((c) => ({
      key: c,
      label: allowlist.meas.get(c)?.label ?? allowlist.dims.get(c)?.label ?? c,
      kind: KIND[c] ?? "identifier",
      // Derived from the catalog's own is_additive flag, not a second hand-copied list of
      // measure keys -- a measure added to meta_pivot_measures picks up its dotted
      // "computed" underline automatically instead of silently missing it until someone
      // remembers to update a parallel constant here too. Dimensions have no isAdditive
      // entry at all (allowlist.meas.get() on a dimension key returns undefined), so they
      // fall through to `false` rather than colliding with `undefined !== false`.
      derived: allowlist.meas.get(c)?.isAdditive === false,
    }));

  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main>
        <div className="stats">
          <Stat label="Grain" value={capitalize(query.grain)} />
          <Stat label="Grouping" value={capitalize(query.grouping)} />
          <Stat label="Window" value={`${query.timeFrom} → ${query.timeTo}`} />
          <Stat label="Rows" value={result.rows.length.toLocaleString("en-US")} />
          <Stat
            label="Quarantined"
            value={result.quarantinedRowsOnPage.toLocaleString("en-US")}
          />
        </div>
        <div className="body">
          <div>
            {isEmpty ? (
              <EmptyState query={query} allowlist={allowlist} />
            ) : (
              <DataTable columns={columns} rows={result.rows} />
            )}
            <p className="foot">
              {result.quarantinedRowsOnPage} quarantined row
              {result.quarantinedRowsOnPage === 1 ? "" : "s"} on this page excluded from
              these totals, never clamped. <span className="deriv">Load factor</span> and{" "}
              <span className="deriv">gauge</span> are computed at query time from summed
              passengers, seats and performed departures -- never averaged.
            </p>
            <div className="permalink">
              <span className="label">Permalink</span>
              <code>/explore?{permalink}</code>
            </div>
          </div>
          <LegendRail />
        </div>
      </main>
    </div>
  );
}
