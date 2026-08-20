import { readFileSync } from "node:fs";
import path from "node:path";
import { PivotError, type PivotQuery } from "@/lib/pivot/types";
import type { Allowlist, DimensionEntry } from "@/lib/pivot/allowlist";

// process.cwd() is the correct anchor: docs/architecture/hosting.md requires WORKDIR to be
// the directory containing data/ (so the DuckDB catalog's relative Parquet paths resolve),
// which is the repo root -- the same directory that contains sql/. __dirname is NOT usable
// here: Turbopack inlines this module into a chunk under .next/server/ in a production
// build, where __dirname resolves to "/", so a "../../../../sql/03_queries" walk has no
// correct anchor and 404s every request (verified: `next start` throws ENOENT on
// '/sql/03_queries/pivot_segment.sql').
//
// UPGAUGE_ROOT overrides cwd() for Vitest only: vitest chdirs to its own root (app/), not
// the repo root npm was invoked from, so app/vitest.config.ts sets UPGAUGE_ROOT to the repo
// root for the test process. Production never sets it, so it falls through to cwd(), which
// hosting.md already pins correctly.
const QUERIES_DIR = path.join(process.env.UPGAUGE_ROOT ?? process.cwd(), "sql", "03_queries");
const MAINLINE_CARRIER_EXPR = "coalesce(m.parent_airline_id, f.op_airline_id)";

// Issue #87. A filter value is bound as a VARCHAR parameter against the dimension's fact
// column, so an integer column handed a value it cannot cast throws a DuckDB Conversion Error
// at EXECUTION -- after proxy.ts has resolved cacheability and written HTML_CACHE. That made a
// 500 an attacker could park in a shared cache for an hour at a cost of one request. Rejecting
// here turns it into a PivotError that decode() maps to UrlStateError, which /explore renders
// as its named error page, /api/pivot answers 400 + no-store, and isExploreCacheable() treats
// as not-cacheable. No extra database query: loadAllowlist() is the probe the proxy already makes.
//
// The type is READ from the catalog (DimensionEntry.valueType, introspected by
// sql/02_marts/300_meta_pivot_dimensions.sql from duckdb_columns()), never inferred from the key
// name -- aircraft_type is VARCHAR carrying zero-padded codes ('079') and a numeric rule guessed
// from the name would int-parse it to 79 and break the join silently.
//
// PERMISSIVE ON RANGE, STRICT ON SPELLING -- both directions on purpose. The range bound tracks
// the column's TYPE and never its content: `year`'s ceiling is INT64's even though every value it
// holds is SMALLINT-shaped, because tightening it to the data would reject values DuckDB accepts
// and buy nothing. The spelling rule runs the other way, deliberately NARROWER than the cast.
// Do not "simplify" either axis into the other.
//
// This duplicates part of DuckDB's type system on purpose. The standing rule is not to
// re-implement the engine -- but a cast failure lands at EXECUTION, after the proxy has committed
// a Cache-Control, so the engine's rejection arrives too late to be useful. Where the engine can
// refuse a value in time, leave it to the engine; where it cannot, refuse first. That is the line,
// and this is not a precedent for checking anything the engine would have caught in time.
//
// CANONICAL, not merely castable, is deliberate. DuckDB accepts a wide family of spellings for
// the SAME integer -- measured against the real warehouse, '0019790', '000000019790', '+19790',
// "' 19790 '", '19790\n', '1.979e4', '1.9790E4', '19790.0', '19790.', '19_790' and '1_9_7_9_0'
// each select airline_id 19790 (DL, 328,368 fact rows), so each is a distinct CDN cache key for
// a byte-identical page. The leading-zero and underscore families are unbounded, which makes that
// set unbounded. encode() emits only the canonical form, so nothing shipped is spelled this way.
//
// Hex is castable too but is NOT in that list: '0x4D5E' casts to 19806 (WAQ, 0 fact rows), a
// different carrier answering an empty page. It widens what the canonical rule has to exclude;
// it is not another spelling of the same result.
//
// Mirrored in pipeline/pivot.py's `_check_filter_value`. The goldens prove the two agree on what
// they EMIT; nothing proves they agree on what they REJECT, so the pair is kept in step by hand,
// backed by tests on each side that assert the same accept/reject OUTCOMES. No test on either
// side asserts the other's message TEXT, and the two do diverge there for non-printable values:
// Python renders the value with !r (so a trailing newline prints escaped) while this template
// interpolates it literally. Same verdict, same bound params, different bytes in the message.
// BigInt("...") calls rather than the `127n` literal form: app/tsconfig.json targets ES2017, where
// a BigInt LITERAL is a compile error (TS2737), even though the BigInt global itself is available
// (`lib` includes esnext) and present at runtime on Node 24. Do not "tidy" these back into `n`
// literals -- `make app-check` fails on them, while `npm test` alone does NOT, because vitest
// transpiles without typechecking.
const INTEGER_MAXIMA = new Map<string, bigint>([
  ["TINYINT", BigInt("127")],
  ["SMALLINT", BigInt("32767")],
  ["INTEGER", BigInt("2147483647")],
  ["BIGINT", BigInt("9223372036854775807")],
]);
const CANONICAL_UINT_RE = /^(0|[1-9][0-9]*)$/;

function checkFilterValue(value: string, key: string, valueType: string): void {
  const max = INTEGER_MAXIMA.get(valueType);
  // VARCHAR -- and any type the catalog grows later -- is left alone: junk returns zero rows,
  // the ordinary no-match shape. Defaulting an UNKNOWN type to the integer rule would silently
  // start rejecting values the moment a column changed type, which is the opposite of failing loud.
  if (max === undefined) return;
  // Length before parse, and not as an optimisation. `f` values are unbounded in length
  // (lib/pivot/bounds.ts exempts `f` from its value rules), so BigInt() would otherwise parse
  // an attacker-sized digit string; Python's int() additionally RAISES above 4300 digits, which
  // would escape the mirror as something other than PivotError. Canonical form guarantees no
  // leading zeros, so "more digits than the maximum" settles it without parsing at all.
  const maxDigits = max.toString().length;
  if (!CANONICAL_UINT_RE.test(value) || value.length > maxDigits || BigInt(value) > max) {
    throw new PivotError(
      `filter value '${value}' for '${key}' must be a plain whole number from 0 to ${max}`,
    );
  }
}

function validateDimension(
  key: string,
  a: Allowlist,
  grain: string,
  forGrouping = false,
): DimensionEntry {
  const entry = a.dims.get(key);
  if (!entry) throw new PivotError(`unknown dimension '${key}'`);
  if (forGrouping && entry.filterOnly) {
    throw new PivotError(`dimension '${key}' cannot be grouped by; it is filter-only`);
  }
  if (entry.grain !== "both" && entry.grain !== grain) {
    throw new PivotError(
      `dimension '${key}' is '${entry.grain}'-grain, not offered at '${grain}' grain`,
    );
  }
  return entry;
}

/** `route` is the one dimension spanning two columns. */
function dimensionColumns(e: DimensionEntry): string[] {
  return e.columnExpr.split(",").map((c) => c.trim());
}

/** Returns [selectExpr, groupByExpr, sortableName]. Only op_airline_id under mainline
 * grouping differs: aliased back to its own key so ORDER BY names the same thing in both
 * modes, while GROUP BY uses the raw expression (never an output alias). */
function dimRender(key: string, e: DimensionEntry, grouping: string): [string, string, string] {
  if (grouping === "mainline" && key === "op_airline_id") {
    return [`${MAINLINE_CARRIER_EXPR} AS op_airline_id`, MAINLINE_CARRIER_EXPR, "op_airline_id"];
  }
  return [e.columnExpr, e.columnExpr, e.columnExpr];
}

export function renderPivot(
  q: PivotQuery,
  a: Allowlist,
): { sql: string; params: Record<string, string | number> } {
  if (q.grain !== "segment" && q.grain !== "route") {
    throw new PivotError(`unknown grain '${q.grain}'`);
  }
  if (q.grouping !== "operating" && q.grouping !== "mainline") {
    throw new PivotError(`unknown grouping '${q.grouping}'`);
  }
  if (q.dimensions.length === 0) throw new PivotError("at least one dimension is required");
  if (q.measures.length === 0) throw new PivotError("at least one measure is required");
  if (!Number.isInteger(q.limit) || q.limit <= 0) {
    throw new PivotError(`limit must be a positive integer, got ${q.limit}`);
  }
  for (const [key, values] of q.filters) {
    if (values.length === 0) throw new PivotError(`filter '${key}' has no values`);
  }

  const dimEntries = q.dimensions.map((k) => validateDimension(k, a, q.grain, true));
  const measureEntries = q.measures.map((k) => {
    const e = a.meas.get(k);
    if (!e) throw new PivotError(`unknown measure '${k}'`);
    return e;
  });

  const dimRenders = q.dimensions.map((k, i) => dimRender(k, dimEntries[i], q.grouping));
  const dimSelect = dimRenders.map((r) => r[0]).join(", ");
  const groupBy = dimRenders.map((r) => r[1]).join(", ");
  const measureSelect = q.measures
    .map((k, i) => `${measureEntries[i].expr} AS ${k}`)
    .join(", ");

  const params: Record<string, string | number> = {
    time_from: q.timeFrom,
    time_to: q.timeTo,
    limit: q.limit,
  };

  const filterClauses: string[] = [];
  q.filters.forEach(([key, values], i) => {
    const entry = validateDimension(key, a, q.grain);
    const columns = dimensionColumns(entry);
    if (columns.length === 1) {
      const placeholders = values.map((value, j) => {
        checkFilterValue(value, key, entry.valueType);
        const pname = `f${i}_${j}`;
        params[pname] = value;
        return `$${pname}`;
      });
      filterClauses.push(`${columns[0]} IN (${placeholders.join(", ")})`);
      return;
    }

    // An `either` dimension's two columns are ALTERNATIVES, not a pair: the value list is
    // shared by both sides, so one parameter per value serves both IN-lists. This is what
    // lets ONE pivot express `origin = X OR dest = X` -- the OR /airport used to assemble
    // arithmetically from three pivots (inclusion-exclusion), and which no AND-ed filter can
    // express. Same-airport rows satisfy both sides and are counted ONCE by the OR, which is
    // exactly what the third inclusion-exclusion term existed to achieve.
    //
    // Branch on filterMode, not on column count: `route` also spans two columns but means the
    // OPPOSITE thing (one route pair, least()/greatest() equality) -- if an `either` OR ever
    // swallowed `route`'s filter, same-airport rows would match again and reopen the measured
    // 18,895-seat inflation on JFK-LAX this file's `pair` branch exists to prevent.
    if (entry.filterMode === "either") {
      if (columns.length !== 2) {
        throw new PivotError(
          `dimension '${key}' is 'either'-mode but spans ${columns.length} columns`,
        );
      }
      const placeholders = values.map((value, j) => {
        // Both columns of an `either` dimension share one type -- asserted in the catalog, not
        // assumed here (300_meta_pivot_dimensions.sql resolves value_type from the FIRST column
        // of column_expr and a test pins every column of a multi-column expr to one type).
        checkFilterValue(value, key, entry.valueType);
        const pname = `f${i}_${j}`;
        params[pname] = value;
        return `$${pname}`;
      });
      const list = placeholders.join(", ");
      filterClauses.push(`(${columns[0]} IN (${list}) OR ${columns[1]} IN (${list}))`);
      return;
    }

    // A composite dimension names more than one key column -- `route` is
    // (route_key_low, route_key_high). One filter VALUE encodes one whole route as
    // "<low>-<high>", so multiple values stay OR'd exactly like every other dimension's
    // IN-list rather than inventing a positional pair convention that would make "a,b,c"
    // meaningless.
    //
    // least()/greatest() rather than trusting stored column order: the filter must be
    // correct however the fact row was written. Filtering the underlying columns separately
    // -- what this branch used to tell callers to do -- is NOT equivalent and is silently
    // wrong: `origin IN (a,b) AND dest IN (a,b)` also matches a->a and b->b, and 12,738 such
    // (full window 2015-01..2026-04, quarantined included -- matching is what a filter does,
    // and quarantine does not change it; invariants.md § Route identity)
    // same-airport filings exist across 530 airports. On JFK-LAX that inflates seats by
    // 18,895 (docs/data/invariants.md).
    //
    // This must stay byte-identical to pipeline/pivot.py's emission -- the goldens are what
    // prove it, and a divergence here is exactly the two-implementation drift M3a exists to
    // prevent.
    if (columns.length !== 2) {
      throw new PivotError(
        `dimension '${key}' spans ${columns.length} columns; only two are supported`,
      );
    }
    const pairClauses = values.map((value, j) => {
      const parts = value.split("-");
      // Arity and value are different failures and keep different messages. '12478' is not two
      // ids at all, so the promise this error has always made -- "two ids joined by '-'" -- is
      // still the right thing to state. 'JFK-LAX' and '99999999999-99999999999' both CLEAR
      // arity and are caught by the per-part type rule below, which names the offending part.
      if (parts.length !== 2) {
        throw new PivotError(
          `filter value '${value}' for composite dimension '${key}' must be ` +
            "two ids joined by '-', e.g. '12478-12892'",
        );
      }
      // The rule runs on each RAW part -- split only, never stripped. It cannot run on the whole
      // value, because '-' is this format's structural separator so the composite is never itself
      // a plain integer (checking the raw VALUE rejects the filter_composite_route golden and
      // every /route/ page in production -- simulated against the committed goldens).
      //
      // Splitting without stripping is what closes the whitespace family. Measured on the real
      // warehouse, `route:'\n\n 12478-12892 \t'` and `route:' 12478  -  12892 '` returned rows
      // identical to `route:12478-12892`, each a distinct CDN key for one query, on the dimension
      // every /route/ page links through -- the same unbounded-spelling defect the canonical rule
      // closes for leading zeros. No production caller emits whitespace: all four build the value
      // from database integers (carrier/[code]/page.tsx, airport/[code]/endpoints.ts,
      // map/airportNetwork.ts, watch.ts).
      //
      // Rejecting rather than stripping also removes a latent cross-language divergence outright:
      // JS's `trim()` strips U+FEFF, which Python's `.strip()` does not, and `.strip()` strips
      // \x1c-\x1f, which `trim()` does not. With no strip on either side, there is no whitespace
      // set for the two runtimes to disagree about.
      //
      // This replaces a digits-only regex (/^\d+$/ per part) that let
      // '99999999999-99999999999' through to throw inside DuckDB exactly the way 'JFK-LAX'
      // once did -- route_key_low/high are INTEGER, max 2147483647, so "all digits" was never
      // the rule. Both columns share one type; the catalog pins that, this branch assumes it.
      for (const part of parts) checkFilterValue(part, key, entry.valueType);
      const loName = `f${i}_${j}a`;
      const hiName = `f${i}_${j}b`;
      params[loName] = parts[0];
      params[hiName] = parts[1];
      return (
        `(least(${columns[0]}, ${columns[1]}) = $${loName} ` +
        `AND greatest(${columns[0]}, ${columns[1]}) = $${hiName})`
      );
    });
    filterClauses.push(`(${pairClauses.join(" OR ")})`);
  });
  const filtersSql = filterClauses.length ? filterClauses.join(" AND ") : "TRUE";

  const sortable = new Map<string, string>();
  q.dimensions.forEach((k, i) => {
    if (dimensionColumns(dimEntries[i]).length === 1) sortable.set(k, dimRenders[i][2]);
  });
  for (const k of q.measures) sortable.set(k, k);

  // Default points at the first requested measure, so a sort default always names a value
  // column rather than a dimension.
  const sortKey = q.sort ?? q.measures[0];
  const resolved = sortable.get(sortKey);
  if (!resolved) {
    throw new PivotError(
      `unknown sort key '${sortKey}': must be one of the selected dimensions or measures ` +
        `(${[...sortable.keys()].sort().join(", ")})`,
    );
  }
  const sortSql = `${resolved} ${q.sortDesc ? "DESC" : "ASC"}`;

  const mainlineJoin =
    q.grouping === "mainline"
      ? "\n" +
        readFileSync(path.join(QUERIES_DIR, "pivot_mainline_join.sql"), "utf8").replace(/\n+$/, "")
      : "";

  // Each replacement uses the FUNCTION form, not a plain string, even though the search
  // pattern is a string (which only replaces the first occurrence -- correct, since every
  // token appears once). A string REPLACEMENT interprets `$&`, `` $` ``, `$'`, `$$`, `$n`,
  // `$<name>` as substitution patterns; a function replacement disables that interpretation
  // entirely, matching Python's str.replace exactly. No catalog expr contains `$` today, but
  // a future one that does must not silently diverge from the reference implementation in
  // the one place divergence is SQL-injection-shaped.
  let sql = readFileSync(path.join(QUERIES_DIR, `pivot_${q.grain}.sql`), "utf8");
  sql = sql.replace("{{DIM_SELECT}}", () => dimSelect);
  sql = sql.replace("{{MEASURE_SELECT}}", () => measureSelect);
  sql = sql.replace("{{GROUP_BY}}", () => groupBy);
  sql = sql.replace("{{FILTERS}}", () => filtersSql);
  sql = sql.replace("{{SORT}}", () => sortSql);
  sql = sql.replace("{{MAINLINE_JOIN}}", () => mainlineJoin);
  return { sql, params };
}
