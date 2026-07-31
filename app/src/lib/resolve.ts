import { readFileSync } from "node:fs";
import path from "node:path";
import type { DuckDBValue } from "@duckdb/node-api";
import { connect } from "@/lib/db";
import type { Allowlist, DimensionEntry } from "@/lib/pivot/allowlist";

// Same anchor, same reason, as db.ts's ROOT: process.cwd() is correct in production, and
// Vitest gets a chdir of its own from vitest.config.ts's setupFiles. See db.ts's header
// comment for the full story -- __dirname is not usable here for the same reason.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

/** Which resolver file serves a given dimension table. Keyed on the catalog's own
 * `join_dim`, so adding a dimension is a catalog change plus a file -- never a branch on a
 * dimension's name. Exported so resolve.test.ts can assert this map is exhaustive against
 * the live allowlist's distinct `join_dim` values -- `collectIds`'s
 * `if (!(entry.joinDim in RESOLVER_FILE)) continue` is otherwise a silent-degradation path:
 * a dimension added to the catalog with a `join_dim` nobody wired a resolver file for would
 * quietly keep rendering raw ids forever, with every existing test still green. */
export const RESOLVER_FILE: Record<string, string> = {
  dim_carrier: "resolve_carrier",
  dim_airport: "resolve_airport",
  dim_city_market: "resolve_city_market",
  dim_aircraft_type: "resolve_aircraft_type",
};

export interface Resolved {
  code: string | null;
  name: string | null;
}

/** Map key. A plain template string would collide if two dimensions ever shared an id
 * space; the NUL separator cannot appear in a dimension key or a BTS code. */
export function resolutionKey(dimensionKey: string, id: unknown): string {
  return `${dimensionKey}\u0000${String(id)}`;
}

/** The one place the three-way display contract lives. `hit` is `resolved.get(resolutionKey(...))`
 * for a given cell; `rawId` is the id that produced that lookup.
 *   - key absent from the map (`hit === undefined`) -> unresolved: the raw id, never a dash.
 *     Absence of a NAME is not absence of DATA (lib/format.ts's opening rule).
 *   - resolved but no code (`hit.code === null`, e.g. dim_city_market) -> the name IS the
 *     value.
 *   - resolved with a code -> the code (callers that also want the name, e.g. for an `abbr`
 *     title, read `hit.name` themselves).
 * Every caller that renders a resolved id -- DataTable's DimensionCell, explore/page.tsx's
 * routeCode -- must go through this, not re-derive the three-way split locally: two
 * independent copies of the same contract is how one of them silently drifts (fix round 1,
 * Finding 1 -- routeCode's own `?.code ?? String(rawId)` collapsed "absent" and "code: null"
 * into the same fallback). */
export function displayValue(hit: Resolved | undefined, rawId: unknown): string {
  if (hit === undefined) return rawId === null || rawId === undefined ? "—" : String(rawId);
  if (hit.code === null) return hit.name ?? String(rawId);
  return hit.code;
}

/** The row columns a dimension occupies. Every dimension is its own key EXCEPT `route`,
 * whose column_expr names two columns that both resolve through dim_airport. Read from the
 * catalog, not hardcoded -- Task 1 exists so this can be data. */
function columnsFor(entry: DimensionEntry): string[] {
  return entry.columnExpr.split(",").map((c) => c.trim());
}

/** Column name -> { dim table, distinct ids present across the page }. Pulled out of
 * resolveRows so dedup and "no resolvable dimension" are testable directly against a pure
 * function, without going through connect() -- this codebase has no mocks, so the only other
 * way to observe these two properties would be indirectly, through map.size after a real
 * query, which cannot distinguish "bound once" from "bound N times with the same value" or
 * "no query ran" from "a query ran and matched nothing". */
export function collectIds(
  rows: Record<string, unknown>[],
  allowlist: Allowlist,
): Map<string, { joinDim: string; ids: Set<unknown> }> {
  const wanted = new Map<string, { joinDim: string; ids: Set<unknown> }>();
  for (const entry of allowlist.dims.values()) {
    if (entry.joinDim === null || entry.joinKey === null) continue;
    if (!(entry.joinDim in RESOLVER_FILE)) continue;
    for (const column of columnsFor(entry)) {
      for (const row of rows) {
        const value = row[column];
        if (value === undefined || value === null) continue;
        const slot = wanted.get(column) ?? { joinDim: entry.joinDim, ids: new Set() };
        slot.ids.add(value);
        wanted.set(column, slot);
      }
    }
  }
  return wanted;
}

/** Substitute the bound-parameter-name list for the `{{IDS}}` token. The token must appear
 * exactly once (Task 3's resolver files are written that way deliberately, after a round
 * where a header comment carried a second copy and silently ate the substitution, leaving
 * the real WHERE clause holding a raw token -- a DuckDB parse error at execution, not at
 * substitution time). `String.prototype.replace` with a string needle only ever replaces
 * the first match, so a stray second occurrence would misbehave silently; count occurrences
 * first and fail loudly instead. */
function substituteIds(statement: string, file: string, placeholder: string): string {
  const occurrences = statement.split("{{IDS}}").length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${file}.sql: expected exactly one {{IDS}} token, found ${occurrences} -- ` +
        "substitution would silently misfire (replace() only touches the first match)",
    );
  }
  return statement.replace("{{IDS}}", placeholder);
}

export interface AirportRef {
  id: number;
  code: string;
  name: string;
}

export interface CarrierRef {
  id: number;
  code: string;
  name: string;
}

/** `id` is a string, and that is not an oversight: the BTS aircraft key is zero-padded
 * ('036'), and CLAUDE.md's hard rule is that int-parsing it breaks every downstream join
 * silently. 13 fact-present types have a leading zero. */
export interface AircraftRef {
  id: string;
  code: string;
  name: string;
}

/** A slug matched more than one fact-present entity.
 *
 * A distinct class rather than a bare Error because for aircraft this is NOT a
 * should-never-happen: `CE-180` names two real, both-flew BTS codes today (030 CESSNA 180 and
 * 031 CESSNA 180A/B), so `/aircraft/CE-180` is a reachable URL that must render something
 * honest. A caller cannot do that from a string it has to re-parse, so the candidates ride on
 * the error: `ids` is every id the slug matched, in the order the driver returned them.
 * Entity pages catch this and render a named disambiguation; anything that does not catch it
 * gets a loud 500, which is still strictly better than the alternative this codebase already
 * paid for once -- see `AUS` in docs/data/invariants.md § Entity resolution, where the last
 * row the driver happened to return silently won and the page confidently displayed an
 * airport closed since 1999. */
export class AmbiguousCodeError extends Error {
  readonly lookup: string;
  readonly code: string;
  readonly ids: (string | number)[];

  constructor(
    lookup: string,
    code: string,
    idLabel: string,
    ids: (string | number)[],
    detail: string,
  ) {
    super(
      `${lookup}: code '${code}' matched more than one ${idLabel} (${ids.join(", ")}) -- ` +
        `${detail} Refusing to silently pick one.`,
    );
    this.name = "AmbiguousCodeError";
    this.lookup = lookup;
    this.code = code;
    this.ids = ids;
  }
}

interface LookupContext {
  /** The exported function's name, so the message says where to look. */
  lookup: string;
  /** The id column's name in the warehouse -- `airline_id`, `airport_id`, BTS `code`. */
  idLabel: string;
  /** One sentence on why a repeat is or is not expected for this entity. */
  detail: string;
}

/** Fold one reverse-lookup result row into the slug -> entity map, throwing if the slug was
 * already present.
 *
 * Pulled out of the lookup functions so the fail-loud path is directly testable with
 * synthetic rows -- the same reason collectIds is pulled out of resolveRows above. For
 * airports and carriers there is no live colliding pair to feed the real function (both
 * fact-presence filters take collisions to 0, measured), so the only way to reach this branch
 * through the database would be to wait for BTS to reuse a code, which is not a test. For
 * aircraft, CE-180 reaches it today.
 *
 * The already-inserted row is REMOVED on collision rather than left behind. A caller that
 * catches and continues would otherwise hold a map containing exactly the arbitrary
 * first-row-wins answer this whole mechanism exists to refuse. */
export function insertUniqueByCode<T extends { id: string | number; code: string }>(
  out: Map<string, T>,
  row: T,
  ctx: LookupContext,
): void {
  const code = row.code.toUpperCase();
  const existing = out.get(code);
  if (existing !== undefined) {
    out.delete(code);
    throw new AmbiguousCodeError(ctx.lookup, code, ctx.idLabel, [existing.id, row.id], ctx.detail);
  }
  out.set(code, row);
}

const AIRPORT_CTX: LookupContext = {
  lookup: "lookupAirportsByCode",
  idLabel: "airport_id",
  detail: "lookup_airport_by_code.sql's uniqueness guarantee no longer holds.",
};

const CARRIER_CTX: LookupContext = {
  lookup: "lookupCarriersByCode",
  idLabel: "airline_id",
  detail: "lookup_carrier_by_code.sql's uniqueness guarantee no longer holds.",
};

const AIRCRAFT_CTX: LookupContext = {
  lookup: "lookupAircraftByName",
  idLabel: "aircraft code",
  detail:
    "this short name identifies more than one BTS aircraft type, both of which really flew " +
    "(CE-180 is the known case; see lookup_aircraft_by_name.sql).",
};

/** The airport-shaped face of insertUniqueByCode. Kept as its own export so M4b's contract
 * and its tests read unchanged through this generalization. New lookups call
 * insertUniqueByCode directly with their own context. */
export function insertAirportRow(out: Map<string, AirportRef>, row: AirportRef): void {
  insertUniqueByCode(out, row, AIRPORT_CTX);
}

/** Read a `{{IDS}}`-templated lookup file, bind the uppercased slugs as parameter NAMES, and
 * return the raw rows. Four call sites had grown byte-identical copies of this by M4d; the
 * design spec's own rule is that a second version of something is the signal to generalize
 * the first. Returns `[]` WITHOUT opening a connection for an empty input -- the four callers
 * each carried their own copy of that early return, and one of them forgetting it would mean
 * a `WHERE code IN ()` syntax error rather than an empty map. */
async function runSlugLookup(file: string, slugs: string[]): Promise<Record<string, unknown>[]> {
  const wanted = [...new Set(slugs.map((s) => s.toUpperCase()))].filter((s) => s.length > 0);
  if (wanted.length === 0) return [];

  const names = wanted.map((_, i) => `$id${i}`);
  const raw = readFileSync(path.join(QUERIES_DIR, `${file}.sql`), "utf8");
  const statement = substituteIds(raw, file, `(${names.join(", ")})`);

  const params: Record<string, DuckDBValue> = {};
  wanted.forEach((s, i) => {
    params[`id${i}`] = s as DuckDBValue;
  });

  const con = await connect();
  const prepared = await con.prepare(statement);
  prepared.bind(params);
  const result = await prepared.run();
  return await result.getRowObjects();
}

/** Reverse of the airport resolver: code -> the airport. Keyed by UPPERCASED code, so a
 * lowercase URL resolves while the canonical form stays uppercase.
 *
 * Absent key means unknown, exactly as resolveRows()'s map does -- the caller renders a 404
 * naming the code rather than guessing.
 *
 * lookup_airport_by_code.sql's fact-presence filter is what makes a code unique today
 * (measured: 36 codes collide among all is_latest airports, 0 among fact-present ones -- see
 * that file's header). But that invariant is data-dependent, not structural -- a future BTS
 * refresh could reintroduce a collision (a newly-closed airport whose code gets reused, for
 * instance), and this function's own header comment already promises to fail loudly rather
 * than let a second row for the same code silently overwrite the first via Map.set(). This
 * is that promise enforced (in insertAirportRow, above): a repeated code throws, naming both
 * airport_ids, instead of rendering an arbitrary one of them under a DATA AS OF badge. */
export async function lookupAirportsByCode(codes: string[]): Promise<Map<string, AirportRef>> {
  const out = new Map<string, AirportRef>();
  for (const r of await runSlugLookup("lookup_airport_by_code", codes)) {
    insertUniqueByCode(
      out,
      { id: Number(r.id), code: String(r.code), name: String(r.name) },
      AIRPORT_CTX,
    );
  }
  return out;
}

/** Reverse of the carrier resolver: `carrier_code` -> the airline. Same contract as
 * lookupAirportsByCode -- keyed by UPPERCASED code, absent key means unknown, a repeated code
 * throws rather than resolving arbitrarily.
 *
 * The code returned is the airline's CURRENT code and the name its CURRENT name (CLAUDE.md:
 * dim_carrier carries neither as point-in-time fact), which the legend rail has to state on a
 * page whose entire subject is one carrier. */
export async function lookupCarriersByCode(codes: string[]): Promise<Map<string, CarrierRef>> {
  const out = new Map<string, CarrierRef>();
  for (const r of await runSlugLookup("lookup_carrier_by_code", codes)) {
    insertUniqueByCode(
      out,
      { id: Number(r.id), code: String(r.code), name: String(r.name) },
      CARRIER_CTX,
    );
  }
  return out;
}

/** Reverse of the aircraft-type resolver: `short_name` -> the BTS aircraft type.
 *
 * `id` is the zero-padded BTS code as a STRING and must stay one -- Number(r.id) here would
 * turn '036' into 36 and break the fact join silently, which is the exact failure CLAUDE.md's
 * zero-padding rule names. This is the one place the three lookups genuinely differ.
 *
 * This is also the one lookup whose slug is not a key. `CE-180` matches two fact-present
 * codes, so this REJECTS with AmbiguousCodeError for that slug -- today, on real data, not
 * hypothetically. Callers must handle that: `/aircraft/CE-180` is reachable, and the right
 * page for it names both airframes rather than picking whichever row DuckDB returned last.
 * See lookup_aircraft_by_name.sql for why no scoping fixes this and why narrowing to the
 * trailing 12 months would be the worst available "fix". */
export async function lookupAircraftByName(names: string[]): Promise<Map<string, AircraftRef>> {
  const out = new Map<string, AircraftRef>();
  for (const r of await runSlugLookup("lookup_aircraft_by_name", names)) {
    insertUniqueByCode(
      out,
      { id: String(r.id), code: String(r.code), name: String(r.name) },
      AIRCRAFT_CTX,
    );
  }
  return out;
}

/** Existence-only check, deliberately weaker than `lookupAirportsByCode`: a code coming back
 * in the returned set means it appears in `dim_airport`'s current (`is_latest`) roster, and
 * says nothing about whether it has any domestic segment data -- callers must not treat a hit
 * here as resolved. The one caller, `routePair.ts`, uses it only to choose a 404 reason: a
 * code that fails `lookupAirportsByCode` but appears here is a real, recognized airport this
 * domestic-only dataset (T-100 Segment, CLAUDE.md's "Segment only" rule) simply has no rows
 * for -- LHR, CDG, NRT are the measured examples -- which reads very differently from a typo
 * and would otherwise render the identical "unknown airport code" 404 either way. */
export async function airportCodesExist(codes: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of await runSlugLookup("lookup_airport_code_exists", codes)) {
    out.add(String(r.code));
  }
  return out;
}

export async function resolveRows(
  rows: Record<string, unknown>[],
  allowlist: Allowlist,
): Promise<Map<string, Resolved>> {
  const resolved = new Map<string, Resolved>();
  if (rows.length === 0) return resolved;

  const wanted = collectIds(rows, allowlist);

  for (const [column, { joinDim, ids }] of wanted) {
    if (ids.size === 0) continue;
    const values = [...ids];
    // {{IDS}} becomes ($id0, $id1, ...) -- parameter NAMES, never values. Same discipline
    // as render.ts: nothing user-facing or database-derived is ever concatenated into SQL.
    const names = values.map((_, i) => `$id${i}`);
    const file = RESOLVER_FILE[joinDim];
    const raw = readFileSync(path.join(QUERIES_DIR, `${file}.sql`), "utf8");
    const statement = substituteIds(raw, file, `(${names.join(", ")})`);

    const params: Record<string, DuckDBValue> = {};
    values.forEach((v, i) => {
      // Aircraft type codes are zero-padded strings ('079'); coercing them to numbers
      // breaks the join silently. Bind whatever type the row actually carried. `rows` is
      // typed `Record<string, unknown>[]` at this function's boundary (arbitrary pivot
      // result rows), but every value that survives as a dimension id is one db.ts's
      // demoteBigInts already normalized to a JS primitive -- never an object/array -- so
      // this cast doesn't widen what actually reaches the driver.
      params[`id${i}`] = v as DuckDBValue;
    });

    const con = await connect();
    const prepared = await con.prepare(statement);
    prepared.bind(params);
    const result = await prepared.run();
    for (const r of await result.getRowObjects()) {
      resolved.set(resolutionKey(column, r.id), {
        code: r.code === null || r.code === undefined ? null : String(r.code),
        name: r.name === null || r.name === undefined ? null : String(r.name),
      });
    }
  }

  return resolved;
}
