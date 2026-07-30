import { decode, encode, UrlStateError } from "@/lib/pivot/urlstate";
import { dataAsOf, loadAllowlist, runPivot, type PivotResult } from "@/lib/db";
import { DataTable, type ColumnSpec } from "@/components/DataTable";
import type { PivotQuery } from "@/lib/pivot/types";

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
const DERIVED = new Set(["load_factor", "avg_gauge", "asm", "rpm", "completion_factor"]);

// fct_{segment,route}_month expose quarantine bookkeeping columns alongside every dimension
// and measure a query asked for (sql/03_queries/pivot_segment.sql, pivot_route.sql) -- the
// gutter/foot text surfaces them, but they are not columns of the pivot vocabulary and must
// never appear as a DataTable column.
const NON_DISPLAY_COLUMNS = new Set(["quarantined_rows", "quarantine_reasons"]);

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

  const columns: ColumnSpec[] = result.columns
    .filter((c) => !NON_DISPLAY_COLUMNS.has(c))
    .map((c) => ({
      key: c,
      label: allowlist.meas.get(c)?.label ?? allowlist.dims.get(c)?.label ?? c,
      kind: KIND[c] ?? "identifier",
      derived: DERIVED.has(c),
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
        <DataTable columns={columns} rows={result.rows} />
        <p className="foot">
          {result.quarantinedRowsOnPage} quarantined row
          {result.quarantinedRowsOnPage === 1 ? "" : "s"} on this page excluded from these
          totals, never clamped. <span className="deriv">Load factor</span> and{" "}
          <span className="deriv">gauge</span> are computed at query time from summed
          passengers, seats and performed departures -- never averaged.
        </p>
        <div className="permalink">
          <span className="label">Permalink</span>
          <code>/explore?{permalink}</code>
        </div>
      </main>
    </div>
  );
}
