import { readFileSync } from "node:fs";
import path from "node:path";
import { connect } from "@/lib/db";
import {
  AmbiguousCodeError,
  lookupAircraftByName,
  lookupAirportsByCode,
  lookupCarriersByCode,
} from "@/lib/resolve";
import { AIRPORT_PREFIX } from "@/app/airport/[code]/resolveAirport";
import { CARRIER_PREFIX } from "@/lib/carrier";
import { AIRCRAFT_PREFIX, slugFor, shortNameCandidates } from "@/lib/aircraftSlug";
import { routeHrefFromCodes } from "@/lib/entityLink";

// Same anchor, same reason, as resolve.ts's QUERIES_DIR: process.cwd() is correct in
// production, and Vitest gets its own chdir from vitest.config.ts's setupFiles.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

/** One entity the omnibox can point at. `kind` doubles as the group key -- see `buildGroups`. */
export interface SearchHit {
  kind: "airport" | "carrier" | "aircraft";
  code: string;
  name: string;
  href: string;
}

const GROUP_LABEL: Record<SearchHit["kind"], string> = {
  airport: "Airports",
  carrier: "Carriers",
  aircraft: "Aircraft types",
};

export interface SearchGroup {
  kind: SearchHit["kind"];
  label: string;
  hits: SearchHit[];
}

/** The omnibox's whole contract. `results` carries every match this query produced -- never
 * pre-truncated -- so a caller can always state the true count; `truncated` says whether that
 * count exceeds `SEARCH_RESULT_CAP`, which is what a page renders and what it discloses when
 * it stops short of the full list (docs/design/system.md's "a silent truncation reads as
 * 'that's all there is'" rule, restated for this surface in the task brief). */
export type SearchResult =
  | { kind: "redirect"; to: string }
  | { kind: "results"; groups: SearchGroup[]; truncated: boolean }
  | { kind: "empty" }
  | { kind: "none"; query: string };

/** How many matches a substring search discloses before the page has to say "showing the
 * first N of M". Measured against the built database: 'air' alone returns 423 of the 1,271
 * fact-present rows across all three tables (docs/product/features.md's own worked example,
 * 'Alaska', returns 8; 'Portland' returns 4) -- so this is not a limit real named queries hit,
 * it exists for the pathological single-letter case ('a' returns 1,182). Exported so
 * search/page.tsx renders and discloses the identical number this file used to set
 * `truncated`. */
export const SEARCH_RESULT_CAP = 50;

/** Build the `%...%` ILIKE pattern for a user's raw text, escaping the two characters ILIKE
 * treats as wildcards. DuckDB's LIKE/ILIKE has NO default escape character (measured: 'a%b'
 * ILIKE '%a\%b%' is FALSE without an explicit ESCAPE clause -- the backslash is matched
 * literally, not interpreted), so search_by_name.sql pairs every ILIKE with `ESCAPE '\'` and
 * this is the other half of that contract. Order matters: the backslash itself must be
 * doubled FIRST, or escaping '%' would double-escape a backslash that preceded it. Without
 * this, a query containing a literal '%' or '_' would silently match far more than the
 * literal text asked for (task brief, "Escaping"). */
function likePattern(q: string): string {
  const escaped = q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  return `%${escaped}%`;
}

interface NameMatchRow {
  kind: string;
  code: string;
  name: string;
}

async function searchByName(q: string): Promise<NameMatchRow[]> {
  const statement = readFileSync(path.join(QUERIES_DIR, "search_by_name.sql"), "utf8");
  const con = await connect();
  const prepared = await con.prepare(statement);
  prepared.bind({ pattern: likePattern(q) });
  const result = await prepared.run();
  return (await result.getRowObjects()) as unknown as NameMatchRow[];
}

function hrefFor(kind: SearchHit["kind"], code: string): string {
  if (kind === "airport") return `${AIRPORT_PREFIX}${encodeURIComponent(code)}`;
  if (kind === "carrier") return `${CARRIER_PREFIX}${encodeURIComponent(code)}`;
  return `${AIRCRAFT_PREFIX}${encodeURIComponent(code)}`;
}

/** Two airport codes joined by '-', an en dash, or a space, case-insensitively -- the shapes
 * step 1(a) of the task brief requires ('PDX-AUS', 'PDX–AUS', 'PDX AUS'). Purely syntactic:
 * whether the two tokens actually resolve to airports is the caller's job (`routePairHit`),
 * so this cannot itself misfire against a two-word name search or a dashed aircraft slug like
 * 'B737-8' -- both fail to resolve as airports and fall through to the next resolution step. */
function routePairTokens(q: string): [string, string] | null {
  const trimmed = q.trim();
  const dashed = trimmed.match(/^(\S+)\s*[-–]\s*(\S+)$/);
  if (dashed) return [dashed[1], dashed[2]];
  const bySpace = trimmed.split(/\s+/).filter((s) => s.length > 0);
  return bySpace.length === 2 ? [bySpace[0], bySpace[1]] : null;
}

/** Step 1(a) resolution: does `q` name two distinct, fact-present airports? If so this is
 * unambiguous by construction -- a route pair can never collide with a single-code namespace
 * (airport/carrier/aircraft codes don't contain the separators this requires), so there is no
 * "which namespace ran first" question here the way there is for a single code (step 1(b)). */
async function routePairHit(q: string): Promise<SearchResult | null> {
  const tokens = routePairTokens(q);
  if (tokens === null) return null;
  const [rawA, rawB] = tokens;
  const a = rawA.toUpperCase();
  const b = rawB.toUpperCase();
  if (a === b) return null;
  const found = await lookupAirportsByCode([rawA, rawB]);
  const airportA = found.get(a);
  const airportB = found.get(b);
  if (airportA === undefined || airportB === undefined) return null;
  return { kind: "redirect", to: routeHrefFromCodes(airportA.code, airportB.code) };
}

/** The aircraft half of the single-code exact-match step. Reuses `slugFor`/`shortNameCandidates`
 * from aircraftSlug.ts -- the same many-to-one slug transform `/aircraft/<slug>` resolves with
 * -- rather than re-deriving it, so a search for 'A321 LR' or 'A321/LR' finds the same type
 * `/aircraft/A321-LR` does. `lookupAircraftByName` throws `AmbiguousCodeError` when the slug
 * names two BTS codes that share one short name (CE-180's shape); that is caught and turned
 * into two hits rather than allowed to propagate, so this step behaves exactly like the
 * cross-namespace collision guard below -- both real candidates are surfaced, neither is
 * picked silently. That is "the CE-180 shape a third time" the task brief names: the first
 * two instances are the AUS airport-id collision and CE-180's own /aircraft/ 404; this is the
 * omnibox's own copy of the same bug shape, guarded the same way. */
async function aircraftExactHits(q: string): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];
  const candidates = shortNameCandidates(slugFor(trimmed));
  if (candidates === null) return [];
  try {
    const found = await lookupAircraftByName(candidates);
    return [...found.values()].map((a) => ({
      kind: "aircraft" as const,
      code: slugFor(a.code),
      name: a.name,
      href: hrefFor("aircraft", slugFor(a.code)),
    }));
  } catch (e: unknown) {
    if (e instanceof AmbiguousCodeError) {
      const code = slugFor(e.code);
      return e.ids.map((id) => ({
        kind: "aircraft" as const,
        code,
        name: `BTS aircraft type ${id}`,
        href: hrefFor("aircraft", code),
      }));
    }
    throw e;
  }
}

/** Step 1(b): every namespace a single token could be an EXACT code in, checked concurrently
 * and collected rather than short-circuited. Collecting first and deciding after is the whole
 * fix for the bug the task brief names -- "a redirect that silently picks whichever step ran
 * first" -- for the three real collisions (LNY, NEW, WST are both an airport and a carrier
 * code; see search.test.ts). A resolver written as an if/else-if chain (try airport, ELSE try
 * carrier, ELSE try aircraft) would resolve LNY as an airport unconditionally, because the
 * airport branch is checked first and never learns the carrier branch would also have hit. */
async function exactHits(q: string): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];
  const upper = trimmed.toUpperCase();
  const [airports, carriers, aircraft] = await Promise.all([
    lookupAirportsByCode([trimmed]),
    lookupCarriersByCode([trimmed]),
    aircraftExactHits(trimmed),
  ]);
  const hits: SearchHit[] = [];
  const airport = airports.get(upper);
  if (airport !== undefined) {
    hits.push({ kind: "airport", code: airport.code, name: airport.name, href: hrefFor("airport", airport.code) });
  }
  const carrier = carriers.get(upper);
  if (carrier !== undefined) {
    hits.push({ kind: "carrier", code: carrier.code, name: carrier.name, href: hrefFor("carrier", carrier.code) });
  }
  hits.push(...aircraft);
  return hits;
}

/** Step 1(d)'s ranking, exported so it is directly falsifiable without going through the
 * grouping/paging built on top of it (`buildGroups` below re-derives the group order from
 * this function's output, so a bug here shows up there too, but the direct test is what
 * catches it precisely rather than through two layers of indirection).
 *
 * "A result whose name starts with the query ranks above one that merely contains it, ties
 * broken by the existing code order" -- literally a stable partition into two tiers, which is
 * what `Array.prototype.sort`'s ES2019+ stability guarantee gives for free: rows that were
 * already in `search_by_name.sql`'s `ORDER BY 1, 2` order keep that relative order within
 * each tier. No fuzzy distance, no traffic-based boost -- CLAUDE.md's honesty rules keep both
 * out; a number nobody can justify is not a ranking, it's a guess wearing a ranking's
 * clothes. */
export function rankByStartsWith(rows: NameMatchRow[], q: string): NameMatchRow[] {
  const needle = q.trim().toLowerCase();
  const tier = (r: NameMatchRow): 0 | 1 => (r.name.toLowerCase().startsWith(needle) ? 0 : 1);
  return [...rows].sort((a, b) => tier(a) - tier(b));
}

const KIND_OF: Record<string, SearchHit["kind"]> = { airport: "airport", carrier: "carrier", aircraft: "aircraft" };

function hitFromRow(r: NameMatchRow): SearchHit {
  const kind = KIND_OF[r.kind];
  return { kind, code: r.code, name: r.name, href: hrefFor(kind, r.code) };
}

/** Groups a ranked (or otherwise ordered) hit list by `kind`, in FIRST-SEEN order -- not a
 * fixed airport/carrier/aircraft priority. That is what carries `rankByStartsWith`'s ordering
 * through to the page: for 'Alaska', AS (a carrier) outranks DUT (an airport), so the carrier
 * group is listed first and `groups.flatMap(g => g.hits)[0]` is still AS -- a fixed
 * kind-ordering would instead force airports first regardless of relevance, silently undoing
 * the ranking one layer up. */
function buildGroups(hits: SearchHit[]): SearchGroup[] {
  const order: SearchHit["kind"][] = [];
  const byKind = new Map<SearchHit["kind"], SearchHit[]>();
  for (const hit of hits) {
    let bucket = byKind.get(hit.kind);
    if (bucket === undefined) {
      bucket = [];
      byKind.set(hit.kind, bucket);
      order.push(hit.kind);
    }
    bucket.push(hit);
  }
  return order.map((kind) => ({ kind, label: GROUP_LABEL[kind], hits: byKind.get(kind)! }));
}

/** The omnibox's single entry point. Resolution order (task brief): a route-pair pattern,
 * then an exact code in any of the three namespaces (collected, not short-circuited -- see
 * `exactHits`), then a substring match on name across all three. Each step either produces a
 * definitive answer or falls through; nothing here guesses. */
export async function search(q: string): Promise<SearchResult> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return { kind: "empty" };

  const routeHit = await routePairHit(trimmed);
  if (routeHit !== null) return routeHit;

  const exact = await exactHits(trimmed);
  if (exact.length === 1) return { kind: "redirect", to: exact[0].href };
  if (exact.length > 1) return { kind: "results", groups: buildGroups(exact), truncated: false };

  const rows = await searchByName(trimmed);
  if (rows.length === 0) return { kind: "none", query: trimmed };

  const ranked = rankByStartsWith(rows, trimmed).map(hitFromRow);
  return {
    kind: "results",
    groups: buildGroups(ranked),
    truncated: ranked.length > SEARCH_RESULT_CAP,
  };
}
