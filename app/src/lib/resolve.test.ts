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
  lookupCarriersByCode,
  lookupAircraftByName,
  carrierHoldersByCode,
  insertAirportRow,
  insertUniqueByCode,
  AmbiguousCodeError,
  type AirportRef,
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

  it("resolves AUS to Austin-Bergstrom, not the closed Robert Mueller Municipal", async () => {
    // Fix round 1, Critical: `is_latest` is scoped per airport_id's OWN seq chain, not per
    // code, so two DIFFERENT airport_ids sharing a code can each be is_latest = TRUE at once.
    // Measured: 36 codes collide this way. AUS is one -- airport_id 10423 "Austin -
    // Bergstrom International" (69,132 traffic rows) and airport_id 16440 "Robert Mueller
    // Municipal" (closed since 1999, zero traffic rows) both come back is_latest = TRUE.
    // Without the EXISTS-in-facts filter, whichever row the driver returns last wins the Map
    // silently -- Robert Mueller today. This test fails without that filter, which is the
    // point.
    const m = await lookupAirportsByCode(["AUS"]);
    expect(m.get("AUS")?.id).toBe(10423);
    expect(m.get("AUS")?.name).not.toContain("Mueller");
  });
});

// Fix round 1: shows the un-scoped (is_latest only) query really does return 2 rows for AUS
// while the shipped query (with the fact-presence filter) returns 1 -- the direct-SQL
// counterpart to the "resolves AUS" Map-based test above, mirroring how "lookup_airport_by_
// code.sql's cardinality guard" (below) backs up the JFK multi-seq test.
//
// Fix wave 3: this test used to strip the filter with a regex naming the clause's SYNTAX
// (`AND EXISTS ( SELECT 1 FROM fct_segment_month f ...`), which pinned the query TEXT rather
// than its behaviour -- rewriting that correlated EXISTS as the hash semi-join it is today
// (43-51 ms -> 17 ms; see the .sql file) left the regex matching nothing, so `unscoped`
// silently became a second copy of `shipped` and the test failed for a reason that had
// nothing to do with the guarantee. It now truncates at a marker comment the .sql file
// declares for this purpose, and asserts that marker exists, so any future rewrite of the
// predicate keeps working while its DISAPPEARANCE still fails loudly.
const FACT_FILTER_MARKER = "-- FACT-PRESENCE FILTER";

describe("lookup_airport_by_code.sql's fact-presence filter", () => {
  it("un-scoped (is_latest only) AUS returns 2 rows; the shipped query returns 1", async () => {
    const raw = readFileSync(path.join(QUERIES_DIR, "lookup_airport_by_code.sql"), "utf8");
    const con = await connect();

    // The shipped statement, as-is.
    const shippedStatement = raw.replace("{{IDS}}", "($id0)");
    const shippedPrepared = await con.prepare(shippedStatement);
    shippedPrepared.bind({ id0: "AUS" });
    const shippedRows = await (await shippedPrepared.run()).getRowObjects();
    expect(shippedRows.length).toBe(1);
    expect(shippedRows[0].id).toBe(10423);

    // The same statement with the fact-presence clause stripped back out -- reproduces the
    // pre-fix query to prove the collision this filter closes is real, not assumed.
    const marker = shippedStatement.indexOf(FACT_FILTER_MARKER);
    expect(shippedStatement.split(FACT_FILTER_MARKER).length - 1).toBe(1);
    expect(marker).toBeGreaterThan(shippedStatement.indexOf("WHERE is_latest"));
    const unscopedStatement = shippedStatement.slice(0, marker).trimEnd();
    const unscopedPrepared = await con.prepare(unscopedStatement);
    unscopedPrepared.bind({ id0: "AUS" });
    const unscopedRows = await (await unscopedPrepared.run()).getRowObjects();
    expect(unscopedRows.length).toBe(2);
    expect(new Set(unscopedRows.map((r) => r.id))).toEqual(new Set([10423, 16440]));
  });
});

// Fix round 1: proves the fail-loud path actually fires. Real data no longer produces a
// colliding pair for ANY code (lookup_airport_by_code.sql's fact-presence filter took 36 collisions
// to 0, measured), so there is no way to trigger this branch through lookupAirportsByCode()
// itself without waiting for BTS to reuse a closed airport's code -- not a test. This
// exercises insertAirportRow directly with synthetic rows instead, the same reasoning
// collectIds's extraction above documents for testing without connect().
describe("insertAirportRow", () => {
  it("accepts the first row for a code", () => {
    const out = new Map<string, AirportRef>();
    insertAirportRow(out, { id: 10423, code: "AUS", name: "Austin - Bergstrom International" });
    expect(out.get("AUS")?.id).toBe(10423);
  });

  it("throws, naming both airport_ids, on a second row for an already-seen code", () => {
    const out = new Map<string, AirportRef>();
    insertAirportRow(out, { id: 10423, code: "AUS", name: "Austin - Bergstrom International" });
    expect(() =>
      insertAirportRow(out, { id: 16440, code: "AUS", name: "Robert Mueller Municipal" }),
    ).toThrow(/AUS.*10423.*16440/);
  });
});

// A Map-based test built on lookupAirportsByCode() itself CANNOT detect a missing `WHERE
// is_latest` here, and the brief's own version of that test (asserting `m.size === 1` for
// JFK) was deleted rather than kept (Minor, final whole-branch review: an assertion that
// cannot fail is worse than no assertion -- it reports green). JFK's 5 seq rows (1247801-05,
// confirmed against dim_airport directly while building this file) all carry the SAME code
// ('JFK') and the SAME airport_id (12478), so a Map keyed by uppercased CODE collapses them
// to one entry via plain overwrite regardless of how many rows the underlying query returns
// -- exactly the same blind spot resolve.test.ts's own comment calls out for resolveRows()'s
// id-keyed map, just one level removed (there it's Map.set on a repeated id; here every one
// of JFK's rows would produce the identical (key, value) pair, so even a "did the value
// change" check wouldn't catch it). Row COUNT is the only thing that actually distinguishes
// "one row" from "five identical rows", so this test runs lookup_airport_by_code.sql
// directly, the same way "resolve_airport.sql's cardinality guard" above does for the
// id -> code direction -- this IS the real guard for the multi-seq-history invariant on the
// code -> id direction, not a supplement to a Map-based one.
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

// ---------------------------------------------------------------------------------------
// M4d Task 1: the carrier and aircraft reverse lookups.
//
// Both are modelled on lookup_airport_by_code.sql and both carry its two defences -- the
// fact-presence filter and the fail-loud collision guard -- for the reason the AUS incident
// established: a slug -> id map that silently keeps the last row it saw resolves an entity
// nobody asked for, under a DATA AS OF badge. What differs is that for aircraft the collision
// is not hypothetical. `CE-180` really does name two fact-present BTS codes, so the guard is
// exercised here by real data rather than by a synthetic pair.
// ---------------------------------------------------------------------------------------

describe("lookupCarriersByCode", () => {
  it("resolves a code to its airline_id, current code and name", async () => {
    const m = await lookupCarriersByCode(["DL"]);
    expect(m.get("DL")).toEqual({ id: 19790, code: "DL", name: "Delta Air Lines Inc." });
  });

  it("is case-insensitive, keyed by the uppercased code", async () => {
    // Red if runSlugLookup stops uppercasing the INPUT -- verified by mutation, not assumed.
    // It is NOT red if the .sql predicate's column-side `upper()` is removed: dim_carrier
    // stores 0 lower-case codes, so that fold is inert against today's data. Recorded in that
    // file's header rather than papered over; there is no fixture that can kill it.
    const m = await lookupCarriersByCode(["dl"]);
    expect(m.get("DL")?.id).toBe(19790);
  });

  it("omits an unknown code rather than inventing one", async () => {
    const m = await lookupCarriersByCode(["ZZ9"]);
    expect(m.has("ZZ9")).toBe(false);
  });

  it("resolves several codes in one query", async () => {
    const m = await lookupCarriersByCode(["DL", "AS"]);
    expect(m.get("DL")?.id).toBe(19790);
    expect(m.get("AS")?.id).toBe(19930);
  });

  it("returns an empty map for no codes rather than emitting `IN ()`", async () => {
    // Red if runSlugLookup's early return goes: the substitution would produce `IN ()`, which
    // is a DuckDB parse error at execution rather than an empty result. All four lookups
    // carried their own copy of this guard before it was pulled into runSlugLookup, so it is
    // now one branch four callers depend on -- worth one assertion.
    expect((await lookupCarriersByCode([])).size).toBe(0);
    expect((await lookupCarriersByCode([""])).size).toBe(0);
  });

  it("resolves VX to Virgin America, not the defunct Aces Airlines", async () => {
    // The AUS shape, for carriers. `carrier_code` is reused -- 112 codes map to more than one
    // airline_id across dim_carrier -- and dim_carrier has no `is_latest` analogue to lean on
    // (it is already one row per airline_id, measured: 0 ids with >1 row), so the
    // fact-presence filter is the ONLY thing making a code a key here. VX carries two rows:
    // airline_id 19995 "Aces Airlines" (a defunct Colombian carrier, 0 fct_segment_month rows)
    // and 21171 "Virgin America" (real in-window traffic; CLAUDE.md's mainline_group rule
    // names its 2016 acquisition). Drop the filter and both rows come back, so this rejects
    // with AmbiguousCodeError instead of resolving -- which is the loud failure by design, and
    // is exactly how this test goes red.
    const m = await lookupCarriersByCode(["VX"]);
    expect(m.get("VX")?.id).toBe(21171);
    expect(m.get("VX")?.name).not.toContain("Aces");
  });
});

// M5 Task 6: the second reverse lookup this project's carrier page needed, so
// resolveCarrier's 404 can split "unknown code" from "recognized, never filed" the same way
// routePair.ts already splits its two cases via airportCodesExist. The carrier version cannot
// be a bare Set, unlike the airport one: a carrier code can name more than one airline_id
// (112 codes, unscoped -- lookup_carrier_by_code.sql's header), so a caller needs the FULL
// row, not just a hit.
describe("carrierHoldersByCode", () => {
  it("is empty for a code dim_carrier has never heard of", async () => {
    const m = await carrierHoldersByCode(["ZZ"]);
    expect(m.has("ZZ")).toBe(false);
  });

  it("names every holder of a recognized-but-never-filed code, not just the first", async () => {
    // PA: Pan American World Airways (airline_id 20384 and 20386) plus Florida Coastal
    // Airlines (20389, an unrelated carrier that happens to share the code) -- three holders,
    // none fact-present. Measured: 94 of the 1,543 never-filed codes have more than one
    // holder; PA is the worst case at 3 (docs/data/invariants.md § Entity resolution).
    const m = await carrierHoldersByCode(["PA"]);
    const holders = m.get("PA") ?? [];
    expect(holders.length).toBe(3);
    expect(new Set(holders.map((h) => h.id))).toEqual(new Set([20384, 20386, 20389]));
    expect(holders.filter((h) => h.name === "Pan American World Airways").length).toBe(2);
    expect(holders.some((h) => h.name === "Florida Coastal Airlines")).toBe(true);
  });

  it("has no fact-presence filter at all, unlike lookupCarriersByCode", async () => {
    // DL resolves normally through lookupCarriersByCode, so resolveCarrier never actually
    // reaches this function for it -- but the query itself must not silently exclude
    // fact-present rows either; this is a plain existence check over dim_carrier, deliberately
    // WITHOUT the clause lookup_carrier_by_code.sql applies (that file's own header comment,
    // mirrored from lookup_airport_code_exists.sql's).
    const m = await carrierHoldersByCode(["DL"]);
    expect(m.get("DL")?.[0]?.id).toBe(19790);
  });

  it("returns an empty map for no codes rather than emitting `IN ()`", async () => {
    expect((await carrierHoldersByCode([])).size).toBe(0);
  });
});

describe("lookup_carrier_by_code.sql's fact-presence filter", () => {
  it("un-scoped CP returns 3 rows; the shipped query returns 1", async () => {
    // The direct-SQL counterpart to the VX test above, on the code with the widest fan-out:
    // CP names Canadian Airlines International (19523), Compass Airlines (21167) and Alis
    // Cargo Airlines (22088), of which only Compass ever filed a T-100 Segment row. Truncating
    // at the marker comment reproduces the pre-filter query rather than pinning its syntax --
    // see the airport version of this test above for why a regex over the predicate's text was
    // the wrong instrument.
    const raw = readFileSync(path.join(QUERIES_DIR, "lookup_carrier_by_code.sql"), "utf8");
    const con = await connect();

    const shippedStatement = raw.replace("{{IDS}}", "($id0)");
    const shipped = await con.prepare(shippedStatement);
    shipped.bind({ id0: "CP" });
    const shippedRows = await (await shipped.run()).getRowObjects();
    expect(shippedRows.length).toBe(1);
    expect(shippedRows[0].id).toBe(21167);

    const marker = shippedStatement.indexOf(FACT_FILTER_MARKER);
    expect(shippedStatement.split(FACT_FILTER_MARKER).length - 1).toBe(1);
    expect(marker).toBeGreaterThan(shippedStatement.indexOf("WHERE"));
    const unscoped = await con.prepare(shippedStatement.slice(0, marker).trimEnd());
    unscoped.bind({ id0: "CP" });
    const unscopedRows = await (await unscoped.run()).getRowObjects();
    expect(unscopedRows.length).toBe(3);
    expect(new Set(unscopedRows.map((r) => r.id))).toEqual(new Set([19523, 21167, 22088]));
  });
});

describe("lookupAircraftByName", () => {
  it("resolves a short_name to its BTS code, short name and full designation", async () => {
    const m = await lookupAircraftByName(["B737-8"]);
    expect(m.get("B737-8")).toEqual({ id: "614", code: "B737-8", name: "BOEING 737-800" });
  });

  it("keeps a zero-padded id a string", async () => {
    // CLAUDE.md hard rule: AIRCRAFT_TYPE '036' becomes 36 if int-parsed and every downstream
    // join breaks silently. Red the moment this lookup copies lookupAirportsByCode's
    // `Number(r.id)` -- which is the natural thing to do when mirroring it, and is why this
    // asserts the type rather than only the value ('036' == 36 would still pass a loose check,
    // and toBe("036") alone would not say WHY it matters).
    const m = await lookupAircraftByName(["SKYHAWK"]);
    expect(m.get("SKYHAWK")?.id).toBe("036");
    expect(typeof m.get("SKYHAWK")?.id).toBe("string");
  });

  it("is case-insensitive, keyed by the uppercased short_name", async () => {
    // Same accounting as the carrier version above: this pins runSlugLookup's input fold, not
    // the .sql's column-side `upper(short_name)`. The one lower-case short name in the
    // dimension ('330-9neo', code 824) has never filed a row, so the fact-presence clause
    // removes the only fixture that could tell the two apart.
    const m = await lookupAircraftByName(["b737-8"]);
    expect(m.get("B737-8")?.id).toBe("614");
  });

  it("omits an unknown short_name rather than inventing one", async () => {
    const m = await lookupAircraftByName(["NOPE-1"]);
    expect(m.has("NOPE-1")).toBe(false);
  });

  it("resolves KINGAIR to the fact-present Beech 200, not the King Air C-90", async () => {
    // The AUS shape again, for aircraft: KINGAIR names code 406 "BEECH 200 SUPER KINGAIR"
    // (fact-present) and code 457 "BEECH KING AIR C-90" (never filed). Drop the fact-presence
    // filter and both come back, so this rejects instead of resolving. 12 short_names have
    // more than one dim_aircraft_type row; the filter takes that to 1 (CE-180, below).
    const m = await lookupAircraftByName(["KINGAIR"]);
    expect(m.get("KINGAIR")?.id).toBe("406");
    expect(m.get("KINGAIR")?.name).toBe("BEECH 200 SUPER KINGAIR");
  });

  it("rejects the genuinely ambiguous CE-180 rather than picking one of its two codes", async () => {
    // THE test on this task. Unlike every other collision in this codebase, this one survives
    // the fact-presence filter: CE-180 names code 030 "CESSNA 180" (183 rows, 994 seats,
    // 2015-01..2024-07) AND code 031 "CESSNA 180A/B" (131 rows, 557 seats, 2016-05..2025-11),
    // both with real filed traffic. There is no scope in which one of them is the right
    // answer, so resolving either is a lie about which airframe the page describes. Delete the
    // guard and this test goes green-to-red the useful way round: the lookup returns a
    // one-entry map whose contents depend on driver row order -- the AUS bug, reproduced
    // exactly, on data that exists TODAY rather than data BTS might ship next year.
    //
    // The structured `ids` are load-bearing, not decoration: an entity page catches this and
    // renders a named disambiguation, so it needs the candidates, not a string to re-parse.
    const err = await lookupAircraftByName(["CE-180"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AmbiguousCodeError);
    const ambiguous = err as AmbiguousCodeError;
    expect(ambiguous.code).toBe("CE-180");
    expect(new Set(ambiguous.ids)).toEqual(new Set(["030", "031"]));
    expect(ambiguous.message).toMatch(/CE-180.*030.*031|CE-180.*031.*030/);
  });
});

describe("lookup_aircraft_by_name.sql's fact-presence filter", () => {
  it("un-scoped KINGAIR returns 2 rows; the shipped query returns 1", async () => {
    const raw = readFileSync(path.join(QUERIES_DIR, "lookup_aircraft_by_name.sql"), "utf8");
    const con = await connect();

    const shippedStatement = raw.replace("{{IDS}}", "($id0)");
    const shipped = await con.prepare(shippedStatement);
    shipped.bind({ id0: "KINGAIR" });
    const shippedRows = await (await shipped.run()).getRowObjects();
    expect(shippedRows.length).toBe(1);
    expect(shippedRows[0].id).toBe("406");

    const marker = shippedStatement.indexOf(FACT_FILTER_MARKER);
    expect(shippedStatement.split(FACT_FILTER_MARKER).length - 1).toBe(1);
    expect(marker).toBeGreaterThan(shippedStatement.indexOf("WHERE"));
    const unscoped = await con.prepare(shippedStatement.slice(0, marker).trimEnd());
    unscoped.bind({ id0: "KINGAIR" });
    const unscopedRows = await (await unscoped.run()).getRowObjects();
    expect(unscopedRows.length).toBe(2);
    expect(new Set(unscopedRows.map((r) => r.id))).toEqual(new Set(["406", "457"]));
  });

  it("still returns BOTH CE-180 codes -- the filter is not what makes a slug unique", async () => {
    // Guards against the tempting wrong fix. Someone who reads only the airport file will
    // assume the fact-presence filter IS the uniqueness mechanism and treat the guard as
    // belt-and-braces. It is not: for aircraft the filter changes nothing about CE-180, so the
    // guard is the entire defence. If a future edit narrows this query (to the trailing 12
    // months, say, where the collision happens to vanish) the collision comes back the moment
    // BTS ships a month in which both types flew -- and this test, which pins the SQL's own
    // scope rather than the lookup's outcome, is what refuses that narrowing.
    const raw = readFileSync(path.join(QUERIES_DIR, "lookup_aircraft_by_name.sql"), "utf8");
    const statement = raw.replace("{{IDS}}", "($id0)");
    const con = await connect();
    const prepared = await con.prepare(statement);
    prepared.bind({ id0: "CE-180" });
    const rows = await (await prepared.run()).getRowObjects();
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["030", "031"]));
  });
});

// The generic behind insertAirportRow. Extracted so the carrier lookup's fail-loud path is
// testable at all: real data produces 0 colliding fact-present carrier codes (measured), so
// there is no live pair to feed lookupCarriersByCode -- the same reasoning insertAirportRow's
// own tests document. The aircraft path needs no synthetic pair; CE-180 is real.
describe("insertUniqueByCode", () => {
  it("accepts the first row for a code", () => {
    const out = new Map<string, { id: number; code: string; name: string }>();
    insertUniqueByCode(out, { id: 21171, code: "VX", name: "Virgin America" }, CARRIER_CTX);
    expect(out.get("VX")?.id).toBe(21171);
  });

  it("throws AmbiguousCodeError naming both ids on a second row for a seen code", () => {
    const out = new Map<string, { id: number; code: string; name: string }>();
    insertUniqueByCode(out, { id: 21171, code: "VX", name: "Virgin America" }, CARRIER_CTX);
    let thrown: unknown;
    try {
      insertUniqueByCode(out, { id: 19995, code: "VX", name: "Aces Airlines" }, CARRIER_CTX);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AmbiguousCodeError);
    expect((thrown as AmbiguousCodeError).ids).toEqual([21171, 19995]);
    expect((thrown as AmbiguousCodeError).message).toMatch(/VX.*21171.*19995/);
    // The first row is NOT left in the map for a caller that swallows the error: a partially
    // populated map is how "fail loudly" degrades back into "resolve arbitrarily".
    expect(out.has("VX")).toBe(false);
  });

  it("uppercases the map key so a lowercase slug lands on the canonical entry", () => {
    const out = new Map<string, { id: number; code: string; name: string }>();
    insertUniqueByCode(out, { id: 19790, code: "dl", name: "Delta Air Lines Inc." }, CARRIER_CTX);
    expect(out.get("DL")?.id).toBe(19790);
  });
});

const CARRIER_CTX = {
  lookup: "lookupCarriersByCode",
  idLabel: "airline_id",
  detail: "test fixture",
};
