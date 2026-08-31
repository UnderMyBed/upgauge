import { describe, expect, it } from "vitest";
import { connect, dataAsOf, demoteBigInts, loadAllowlist, runPivot } from "@/lib/db";
import { resolutionKey } from "@/lib/resolve";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import type { PivotQuery } from "@/lib/pivot/types";

describe("the query layer runs against the real database", () => {
  it("loads the allowlist from the catalog views", async () => {
    const a = await loadAllowlist();
    expect(a.dims.get("op_airline_id")?.columnExpr).toBe("op_airline_id");
    expect(a.dims.get("route")?.columnExpr).toBe("route_key_low, route_key_high");
    expect(a.meas.get("load_factor")?.expr).toContain("NULLIF");
    expect(a.meas.get("load_factor")?.expr).not.toContain("AVG(");
  });

  // M7 Task 1: filterOnly/filterMode are read BY NAME (db.ts) while pipeline/pivot.py reads
  // the same catalog row POSITIONALLY -- so a bug here is a TypeScript-only silent failure
  // (an appended column reads `undefined`/coerces to a default), never a loud Python one. This
  // must exercise the real loadAllowlist() against the built database, not a hand-typed
  // fixture -- a fixture literal would carry whatever value was typed into it regardless of
  // whether db.ts actually reads the column, which proves nothing about db.ts itself.
  it("reads filterOnly and filterMode from the catalog by name, not a default", async () => {
    const a = await loadAllowlist();
    const endpoint = a.dims.get("endpoint_airport_id");
    expect(endpoint?.filterOnly).toBe(true);
    expect(endpoint?.filterMode).toBe("either");
    expect(endpoint?.columnExpr).toBe("origin_airport_id, dest_airport_id");
    // route stays groupable and 'pair' mode -- catches flipping route into 'either', which
    // would silently match same-airport rows and reopen the 18,895-seat JFK-LAX inflation.
    expect(a.dims.get("route")?.filterOnly).toBe(false);
    expect(a.dims.get("route")?.filterMode).toBe("pair");
    // catches a stray filterOnly=true removing a dimension from the Explorer.
    const filterOnly = [...a.dims.values()].filter((d) => d.filterOnly).map((d) => d.key);
    expect(filterOnly).toEqual(["endpoint_airport_id"]);
  });

  it("does not memoize the allowlist across calls: each call re-reads the catalog", async () => {
    // A module-level cache here would let a stale allowlist survive a database rebuilt
    // mid-process. This can't observe the rebuild itself (that needs a second database, out
    // of scope for this layer), but it does pin that loadAllowlist() has no cache to defeat:
    // two calls must return two independently-constructed Maps, not the same object twice.
    const a1 = await loadAllowlist();
    const a2 = await loadAllowlist();
    expect(a1.dims).not.toBe(a2.dims);
    expect(a1.meas).not.toBe(a2.meas);
    expect(a1.dims.get("route")).toEqual(a2.dims.get("route"));
  });

  it("is genuinely read-only: DuckDB itself rejects a write on this connection", async () => {
    const con = await connect();
    await expect(
      con.run("CREATE TABLE db_test_should_never_be_created (i INTEGER)"),
    ).rejects.toThrow();
  });

  it("executes a pivot and returns rows", async () => {
    const r = await runPivot({
      grain: "segment",
      dimensions: ["op_airline_id"],
      measures: ["seats"],
      timeFrom: "2025-05",
      timeTo: "2026-04",
      filters: [],
      sort: "seats",
      sortDesc: true,
      limit: 5,
      grouping: "operating",
    });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(5);
    expect(r.columns).toContain("seats");
    expect(typeof r.quarantinedRowsOnPage).toBe("number");
  });

  it("returns JSON-serializable rows: no bigint reaches the caller", async () => {
    // quarantined_rows is BIGINT/HUGEINT at the SQL layer (COUNT at segment grain, SUM of a
    // BIGINT column at route grain) and comes back from the driver as JS `bigint`, which
    // JSON.stringify throws on. This is the exact landmine Task 8's Response.json() would
    // hit if runPivot did not downcast it.
    const r = await runPivot({
      grain: "route",
      dimensions: ["op_airline_id"],
      measures: ["seats"],
      timeFrom: "2025-05",
      timeTo: "2026-04",
      filters: [],
      sort: "seats",
      sortDesc: true,
      limit: 5,
      grouping: "operating",
    });
    expect(r.rows.length).toBeGreaterThan(0); // otherwise the loop below passes vacuously
    for (const row of r.rows) {
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe("bigint");
      }
    }
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("reads the freshness stamp", async () => {
    const asOf = await dataAsOf();
    expect(asOf).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("demoteBigInts", () => {
  it("downcasts an in-range bigint to number and leaves other values alone", () => {
    const out = demoteBigInts({ a: BigInt(5), b: "x", c: 1.5, d: null });
    expect(out).toEqual({ a: 5, b: "x", c: 1.5, d: null });
  });

  it("throws instead of silently losing precision above Number.MAX_SAFE_INTEGER", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    expect(() => demoteBigInts({ quarantined_rows: tooBig })).toThrow(/MAX_SAFE_INTEGER/);
  });
});

describe("runPivot resolves display values without altering the result shape", () => {
  // Typed as PivotQuery (not `as const`) so runPivot's `string[]` fields accept the object
  // as-is -- a readonly-tuple-inferring `as const` fails typecheck against a mutable field.
  const CARRIER_QUERY: PivotQuery = {
    grain: "segment", dimensions: ["op_airline_id"], measures: ["seats"],
    timeFrom: "2025-05", timeTo: "2026-04", sort: null, sortDesc: true,
    limit: 5, grouping: "operating", filters: [],
  };

  it("attaches a code for every returned id", async () => {
    const r = await runPivot({ ...CARRIER_QUERY });
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(r.resolved.get(resolutionKey("op_airline_id", row.op_airline_id))?.code).toBeTruthy();
    }
  });

  it("leaves the id on the row -- sorting and permalinks still use it", async () => {
    const r = await runPivot({ ...CARRIER_QUERY });
    expect(typeof r.rows[0].op_airline_id).toBe("number");
    expect(r.columns).toContain("op_airline_id");
  });

  it("does not change the row count -- resolveRows runs a separate query and never touches rows", async () => {
    // Not a fan-out guard: resolution returns a Map keyed by resolutionKey(), built from a
    // query distinct from the one that produced `rows`, and never joins into or mutates
    // `rows` itself. This only pins that wiring resolveRows() into runPivot() didn't
    // introduce some OTHER change to the row set (e.g. an accidental extra join on the pivot
    // query itself). The real cardinality guard on dim_airport's multi-seq join lives in
    // resolve.test.ts, against resolve_airport.sql directly -- a repeated key in `resolved`
    // would just overwrite silently in a Map, which nothing here would observe.
    // toBe, not toBeLessThanOrEqual: the pivot SQL already carries LIMIT 5, so "<= 5" holds
    // for any row set including zero rows and can never fail. 70 distinct op_airline_id
    // operated in THIS query's window (2025-06..2026-05), measured directly -- so the result
    // is genuinely truncated at 5 and toBe(5) catches a truncation regression the old bound
    // could not. Do NOT cite invariants.md's 114 here: that figure is the full 2015-2026
    // window (invariants.md says so explicitly), not this 12-month slice.
    const r = await runPivot({ ...CARRIER_QUERY, limit: 5 });
    expect(r.rows.length).toBe(5);
  });

  it("leaves origin_airport_id's row set alone too, despite airports carrying multi-seq history", async () => {
    // Same caveat as above: this is a non-regression check on runPivot's own rows, not proof
    // that resolve_airport.sql's `WHERE is_latest` is intact. See resolve.test.ts for that.
    // toBe, not toBeLessThanOrEqual, for the same reason as above -- 745 distinct
    // origin_airport_id appear in this query's window (2025-06..2026-05), measured directly,
    // so LIMIT 10 truly truncates and toBe(10) is a real assertion.
    const r = await runPivot({
      ...CARRIER_QUERY, dimensions: ["origin_airport_id"], limit: 10,
    });
    expect(r.rows.length).toBe(10);
    const seen = new Set(r.rows.map((x) => x.origin_airport_id));
    expect(seen.size).toBe(r.rows.length);
  });
});

// Whole-branch review, IMPORTANT 2: allowlist.fixture.ts hand-transcribes the catalog and
// claims "if it drifts from the catalog, the golden tests fail -- which is the point". That
// was only ever true for the golden-covered subset: the goldens exercise 4 of 14 dimensions
// and 3 of 12 measures, so a change to (say) meta_pivot_measures.expr for `asm` would leave
// every app test green while the TS suite asserted against a fiction and production ran the
// real catalog. This test closes the loop -- db.test.ts already opens the real database, so
// pinning the whole fixture against it costs one query and covers all 26 entries.
describe("allowlist.fixture.ts stays in sync with the real catalog", () => {
  it("matches meta_pivot_dimensions and meta_pivot_measures exactly", async () => {
    const live = await loadAllowlist();
    expect(Object.fromEntries(live.dims)).toEqual(Object.fromEntries(FIXTURE.dims));
    expect(Object.fromEntries(live.meas)).toEqual(Object.fromEntries(FIXTURE.meas));
  });

  // #139. The comparison above runs through Object.fromEntries, which is blind to key ORDER --
  // and order is load-bearing downstream: DimensionChips and MeasureChips render
  // [...allowlist.dims.values()] / [...meas.values()] verbatim, and groupableDimensions(a,
  // grain)[0] is the dimension a grain switch lands on. So the fixture could carry the right
  // 26 entries in the wrong sequence, every chip row would render in that wrong sequence, and
  // nothing here would say so. Arrays, not objects, is the whole difference.
  //
  // The served order is itself guaranteed at the query (sql/03_queries/catalog_*.sql order by an
  // explicit ordinal), and pipeline/tests/test_pivot_allowlist.py binds that ordinal to the
  // curated VALUES text in sql/02_marts/. This closes the last hop: catalog -> fixture.
  it("matches the catalog's ORDER, which Object.fromEntries above cannot see", async () => {
    const live = await loadAllowlist();
    expect([...live.dims.keys()]).toEqual([...FIXTURE.dims.keys()]);
    expect([...live.meas.keys()]).toEqual([...FIXTURE.meas.keys()]);
  });

  it("covers every catalog entry, so the comparison above cannot pass vacuously", async () => {
    const live = await loadAllowlist();
    expect(live.dims.size).toBeGreaterThan(0);
    expect(live.meas.size).toBeGreaterThan(0);
    expect(FIXTURE.dims.size).toBe(live.dims.size);
    expect(FIXTURE.meas.size).toBe(live.meas.size);
  });
});
