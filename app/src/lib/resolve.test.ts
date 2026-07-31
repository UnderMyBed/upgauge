import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectIds,
  resolveRows,
  resolutionKey,
  displayValue,
  RESOLVER_FILE,
  lookupAirportsByCode,
} from "@/lib/resolve";
import { connect, loadAllowlist } from "@/lib/db";

// Same anchor as db.ts's ROOT / QUERIES_DIR -- see db.ts's header comment for the full
// story. Duplicated here (rather than imported) because resolve.ts's own QUERIES_DIR isn't
// exported, and this test deliberately reads the .sql file independently of resolve.ts's
// code path -- see "resolve_airport.sql's cardinality guard" below for why.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

describe("collectIds", () => {
  // Pure, no connect() -- these defend properties resolveRows's own tests can't: "dedup"
  // asserted only via post-query map.size can't tell "bound once" from "bound N times with
  // the same value" (IN (...) would return one row either way), and "no query issued"
  // asserted the same way can't tell "no query ran" from "a query ran and matched nothing".
  it("deduplicates repeated ids into a single-element set", async () => {
    const allowlist = await loadAllowlist();
    const rows = [{ op_airline_id: 19790 }, { op_airline_id: 19790 }, { op_airline_id: 19790 }];
    const wanted = collectIds(rows, allowlist);
    expect(wanted.get("op_airline_id")?.ids.size).toBe(1);
  });

  it("yields an empty map for a row with no resolvable dimension", async () => {
    const allowlist = await loadAllowlist();
    const wanted = collectIds([{ year_month: "2025-05", seats: 10 }], allowlist);
    expect(wanted.size).toBe(0);
  });
});

describe("resolveRows", () => {
  it("resolves a carrier id to its current code and name", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ op_airline_id: 19790 }], allowlist);
    expect(map.get(resolutionKey("op_airline_id", 19790))).toEqual({
      code: "DL",
      name: "Delta Air Lines Inc.",
    });
  });

  it("resolves an airport id to exactly one row despite multi-seq history", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ origin_airport_id: 14747 }], allowlist);
    expect(map.get(resolutionKey("origin_airport_id", 14747))?.code).toBe("SEA");
  });

  it("resolves an aircraft type code to a name, keeping the key a string", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ aircraft_type: "612" }], allowlist);
    const hit = map.get(resolutionKey("aircraft_type", "612"));
    // '612' is the 737-700, not the A321. The cell shows the SHORT name; the BTS code is
    // never displayed -- rendering '612' is the thing this milestone removes.
    expect(hit?.code).toBe("B737-7");
    expect(hit?.name).toBe("BOEING 737-700/700LR/MAX 7");
  });

  it("gives a city market a name and a null code", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ origin_city_market_id: 30559 }], allowlist);
    const hit = map.get(resolutionKey("origin_city_market_id", 30559));
    expect(hit?.name).toBeTruthy();
    expect(hit?.code).toBeNull();
  });

  it("resolves BOTH route keys through dim_airport", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ route_key_low: 10140, route_key_high: 14747 }], allowlist);
    expect(map.get(resolutionKey("route_key_low", 10140))?.code).toBeTruthy();
    expect(map.get(resolutionKey("route_key_high", 14747))?.code).toBe("SEA");
  });

  it("omits an unresolvable id rather than inventing a value", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ op_airline_id: 999999999 }], allowlist);
    expect(map.has(resolutionKey("op_airline_id", 999999999))).toBe(false);
  });

  it("issues no query for a result with no resolvable dimension", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ year_month: "2025-05", seats: 10 }], allowlist);
    expect(map.size).toBe(0);
  });

  it("deduplicates repeated ids", async () => {
    const allowlist = await loadAllowlist();
    const rows = [{ op_airline_id: 19790 }, { op_airline_id: 19790 }, { op_airline_id: 19790 }];
    const map = await resolveRows(rows, allowlist);
    expect(map.size).toBe(1);
  });
});

// Fix round 1, Finding 1: DataTable.tsx's DimensionCell and explore/page.tsx's routeCode each
// implemented this three-way contract independently, and one of the two copies (routeCode)
// collapsed "unresolved" and "resolved with a null code" into the same fallback. displayValue
// is the single place the contract now lives; both callers just select from its result.
describe("displayValue", () => {
  it("renders the raw id when the key is absent from the map -- unresolved, not un-coded", () => {
    expect(displayValue(undefined, 19790)).toBe("19790");
  });

  it("renders the name when resolved but the dimension has no code (e.g. a city market)", () => {
    expect(displayValue({ code: null, name: "Seattle, WA" }, 30559)).toBe("Seattle, WA");
  });

  it("renders the code when resolved and a code exists", () => {
    expect(displayValue({ code: "DL", name: "Delta Air Lines Inc." }, 19790)).toBe("DL");
  });
});

// resolveRows()'s own "multi-seq history" test (above) resolves airport_id 14747 and checks
// the returned code -- but that check goes through a Map keyed by id, and Map.set() on a
// repeated key just overwrites silently. If resolve_airport.sql's `WHERE is_latest` were
// ever removed, that test would still pass (whichever of the 3 rows for 14747 the driver
// returned last happens to also be coded 'SEA' -- confirmed by querying dim_airport directly:
// airport_id 14747 has seq rows 1474701/1474702/1474703, all coded 'SEA', only 1474703 marked
// is_latest). Row COUNT is what actually catches a fan-out, and nothing in resolve.test.ts or
// db.test.ts inspects it at the SQL level. This test does: it runs resolve_airport.sql
// directly, independent of resolveRows()'s Map-based interface, and asserts row count.
// Whole-branch review, Finding 6: `collectIds`'s `if (!(entry.joinDim in RESOLVER_FILE))
// continue` is the last unguarded silent-degradation path on a branch whose entire theme is
// that silent degradation is the enemy -- a dimension whose catalog `join_dim` has no
// matching resolver file would just keep rendering raw ids, forever, with no test noticing.
// This closes that gap: it walks the LIVE allowlist (not a hardcoded dimension list, for the
// same reason db.test.ts's fixture-vs-catalog test does) and asserts every distinct non-null
// `join_dim` present in the catalog today has a RESOLVER_FILE entry.
describe("RESOLVER_FILE is exhaustive against the live catalog", () => {
  it("has an entry for every distinct join_dim in meta_pivot_dimensions", async () => {
    const allowlist = await loadAllowlist();
    const joinDims = new Set(
      [...allowlist.dims.values()].map((d) => d.joinDim).filter((d): d is string => d !== null),
    );
    expect(joinDims.size).toBeGreaterThan(0);
    for (const joinDim of joinDims) {
      expect(RESOLVER_FILE).toHaveProperty(joinDim);
    }
  });
});

describe("resolve_airport.sql's cardinality guard", () => {
  it("returns exactly one row for an airport_id with multiple seq rows in dim_airport", async () => {
    const raw = readFileSync(path.join(QUERIES_DIR, "resolve_airport.sql"), "utf8");
    const statement = raw.replace("{{IDS}}", "($id0)");
    const con = await connect();
    const prepared = await con.prepare(statement);
    prepared.bind({ id0: 14747 });
    const result = await prepared.run();
    const rows = await result.getRowObjects();
    // airport_id 14747 (SEA) carries 3 rows in dim_airport (seq 1474701/02/03); exactly one
    // has is_latest. This assertion fails the moment `WHERE is_latest` is removed from
    // resolve_airport.sql, which the Map-based tests above cannot do.
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe("SEA");
  });
});

describe("lookupAirportsByCode", () => {
  it("resolves a code to its airport id", async () => {
    const m = await lookupAirportsByCode(["JFK"]);
    expect(m.get("JFK")?.id).toBe(12478);
    expect(m.get("JFK")?.code).toBe("JFK");
  });

  it("is case-insensitive, keyed by the uppercased code", async () => {
    const m = await lookupAirportsByCode(["jfk"]);
    expect(m.get("JFK")?.id).toBe(12478);
  });

  it("omits an unknown code rather than inventing one", async () => {
    const m = await lookupAirportsByCode(["ZZZZ"]);
    expect(m.has("ZZZZ")).toBe(false);
  });

  it("resolves several codes in one query", async () => {
    const m = await lookupAirportsByCode(["JFK", "LAX"]);
    expect(m.get("JFK")?.id).toBe(12478);
    expect(m.get("LAX")?.id).toBe(12892);
  });

  it("returns exactly one airport per code despite multi-seq history", async () => {
    // Without `WHERE is_latest` a code with several seq rows returns several -- the same
    // fan-out resolve_airport.sql guards against.
    const m = await lookupAirportsByCode(["JFK"]);
    expect(m.size).toBe(1);
  });
});

// The brief's own "multi-seq history" test above (map.size === 1) cannot actually detect a
// missing `WHERE is_latest`: JFK's 5 seq rows (1247801-05, confirmed against dim_airport
// directly while building this file) all carry the SAME code ('JFK') and the SAME
// airport_id (12478), so a Map keyed by uppercased CODE collapses them to one entry via
// plain overwrite regardless of how many rows the query returns -- exactly the same blind
// spot resolve.test.ts's own comment calls out for resolveRows()'s id-keyed map, just one
// level removed (there it's Map.set on a repeated id; here every one of JFK's rows would
// produce the identical (key, value) pair, so even a "did the value change" check wouldn't
// catch it). Row COUNT is the only thing that actually distinguishes "one row" from "five
// identical rows", so this test runs lookup_airport_by_code.sql directly, the same way
// "resolve_airport.sql's cardinality guard" above does for the id -> code direction.
describe("lookup_airport_by_code.sql's cardinality guard", () => {
  it("returns exactly one row for a code with multiple seq rows in dim_airport", async () => {
    const raw = readFileSync(path.join(QUERIES_DIR, "lookup_airport_by_code.sql"), "utf8");
    const statement = raw.replace("{{IDS}}", "($id0)");
    const con = await connect();
    const prepared = await con.prepare(statement);
    prepared.bind({ id0: "JFK" });
    const result = await prepared.run();
    const rows = await result.getRowObjects();
    // airport code 'JFK' carries 5 rows in dim_airport (seq 1247801-05); exactly one has
    // is_latest. This assertion fails the moment `WHERE is_latest` is removed from
    // lookup_airport_by_code.sql, which the Map-based test above cannot do.
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(12478);
  });
});
