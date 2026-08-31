import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, demoteBigInts } from "@/lib/db";
import { entitySlugFromPath } from "@/lib/entitySlug";
import { routeHrefFromCodes } from "@/lib/entityLink";
import { exploreHref } from "@/lib/pivot/builder";
import { normalizeQuery } from "@/lib/pivot/types";

// Same anchor, same reason, as db.ts's ROOT / sitemap.ts's ROOT: process.cwd() is correct in
// production; Vitest gets a chdir of its own from vitest.config.ts's setupFiles.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

function sql(name: string): string {
  return readFileSync(path.join(QUERIES_DIR, `${name}.sql`), "utf8");
}

export type PresetSlug = "gauge" | "empty-planes" | "new-routes" | "death-watch";

export const PRESETS: readonly PresetSlug[] = ["gauge", "empty-planes", "new-routes", "death-watch"];

/** The `/watch/<preset>` slug's prefix, and the reader for it -- Task 6's own instance of the
 * same sibling pattern as `rawPath.ts`'s `ROUTE_PREFIX`/`routeSlugFromPath`, `carrier.ts`'s
 * `CARRIER_PREFIX`/`carrierSlugFromPath`, and `airport.ts`/`aircraftSlug.ts`'s equivalents:
 * `proxy.ts` needs it to decide cacheability before the page runs, and `not-found.tsx` needs it
 * because Next's `not-found.js` convention takes no props and no route params, so the request
 * header is the only channel that carries the requested slug to that render. */
export const WATCH_PREFIX = "/watch/";

export function presetSlugFromPath(pathname: string): string | null {
  return entitySlugFromPath(pathname, WATCH_PREFIX);
}

export interface Preset {
  slug: PresetSlug;
  title: string;
  frame: string;
  sqlFile: string;
  /** Gauge Watch renders two tables; every other preset renders one. */
  directions: ReadonlyArray<{ heading: string; direction: "asc" | "desc" }>;
}

// A Map, not an object literal keyed by slug -- pivot/urlstate.ts's GRAIN_TO_URL carries the
// same choice and the same reason: a plain object's prototype chain (`{}["constructor"]`)
// would return a truthy value and sail past `presetBySlug`'s "unknown slug" guard.
const REGISTRY: ReadonlyMap<PresetSlug, Preset> = new Map([
  [
    "gauge",
    {
      slug: "gauge",
      title: "Gauge Watch",
      frame: "Which routes got a bigger plane this year, and which got a smaller one.",
      sqlFile: "watch_gauge",
      directions: [
        { heading: "Upgauging", direction: "desc" },
        { heading: "Downgauging", direction: "asc" },
      ],
    },
  ],
  [
    "empty-planes",
    {
      slug: "empty-planes",
      title: "Empty Planes",
      frame: "Real airliner metal, flown often, with the seats going out empty.",
      sqlFile: "watch_empty_planes",
      directions: [{ heading: "Emptiest", direction: "asc" }],
    },
  ],
  [
    "new-routes",
    {
      slug: "new-routes",
      title: "Route Birth Tracker",
      // TWO false claims were packed into one sentence here, and they failed at different
      // levels. The frame read "First appearance since 2015 -- new service nobody flew last
      // year."
      //
      // (1) NOT "first appearance since 2015". watch_new_routes.sql selects
      //     `p12_months_present = 0`: nothing filed in the PRIOR 12 months. That is a re-entry.
      //     174 of the 297 qualifying rows (58.6%) filed before that window -- B6 AUS-FLL in 106
      //     distinct months back to 2015-01.
      // (2) NOT "nobody flew last year". mart_route_health's grain is (op_airline_id, route) --
      //     a CARRIER-ROUTE PAIR, not a route -- so `p12_months_present = 0` says nothing
      //     whatever about the other carriers on that airport pair. 245 of the 297 (82.5%), and
      //     ALL 25 rows the page renders, had another carrier flying the same pair inside the
      //     prior window. The #1 row is AS HNL-ITO, where HA, UA and WN filed 1,786,963 seats
      //     in that window -- 3.7x the subject's own trailing 12.
      //
      // (2) survived the fix wave that caught (1), because "nobody flew last year" reads as the
      // accurate half of the old sentence and was carried over unexamined. The page's
      // ReEntryNote states both limits and carries the measurements;
      // docs/product/features.md § Insight presets owns the rule.
      frame: "A route this carrier flew nothing on last year -- not necessarily a first appearance, and usually not an unserved route.",
      sqlFile: "watch_new_routes",
      directions: [{ heading: "Newest", direction: "desc" }],
    },
  ],
  [
    "death-watch",
    {
      slug: "death-watch",
      title: "Route Death Watch",
      frame: "Trending worst on every axis at once, over the trailing 12 months.",
      sqlFile: "watch_death_watch",
      directions: [{ heading: "Most distressed", direction: "asc" }],
    },
  ],
] as const);

/** Null for an unknown slug, never a default preset -- see watch.test.ts's "returns null for
 * an unknown slug" for the failure this refuses (a silent fall-through to Gauge Watch under
 * the wrong URL and the wrong name). */
export function presetBySlug(slug: string): Preset | null {
  return REGISTRY.get(slug as PresetSlug) ?? null;
}

export interface WatchRow {
  op_airline_id: number;
  route_key_low: number;
  route_key_high: number;
  [measure: string]: unknown;
}

// The ONLY two literals this codebase will ever substitute into an ORDER BY. Not exported --
// runPreset is the sole caller, and it only ever indexes this with a direction that already
// matched one of the preset's OWN `directions` entries (see the lookup below), never a raw
// value from a request. This is the "closed set" the task brief requires in place of binding
// $direction as a value (DuckDB has no bound-parameter form for an ORDER BY keyword).
const DIRECTION_SQL: Readonly<Record<"asc" | "desc", "ASC" | "DESC">> = {
  asc: "ASC",
  desc: "DESC",
};

const DIRECTION_TOKEN = "{{DIRECTION}}";

// Blank out everything a real SQL parser would treat as either a line comment ("--" to end of
// line) or a block comment (star-slash delimited, non-nesting -- DuckDB's grammar doesn't nest
// them) with same-length whitespace (newlines kept verbatim), while leaving single-quoted
// string literals alone -- DuckDB strings are single-quoted, '' the standard escape for a
// literal quote -- so a "--" or a block-comment opener INSIDE a string is never mistaken for
// the start of a comment. Length-preserving throughout, so every index found against the
// masked text is valid against the original.
//
// (A `//` comment block, not `/** */`, is deliberate here: the block-comment delimiter this
// function has to describe cannot be written literally inside a `/** */` doc comment without
// terminating it early.)
//
// Found necessary by Task 6, against real data, not asserted from reading: watch_gauge.sql's
// own header comment explains the {{DIRECTION}} token BY NAME, which is itself a second
// textual occurrence of that literal string -- before that fix, EVERY call to runPreset() for
// the "gauge" preset (either direction) threw "expected at most one {{DIRECTION}} token, found
// 2" unconditionally, because a first, naive version of this function only stripped "--" line
// comments and counted the comment's mention as a candidate site. Task 5's watch.test.ts never
// caught it: it only runs Empty Planes' and Death Watch's runPreset() path, and neither of
// those two SQL files carries the token at all (each hardcodes its own fixed ORDER BY) -- so
// Gauge Watch, "the differentiator" per docs/product/features.md and the only preset with two
// directions, was never actually executed by any test before Task 6's page rendered it.
//
// Block comments and string-literal-embedded comment markers are a SECOND, review-flagged gap
// in that first fix: no watch_*.sql file uses either today, so neither was a live bug, but both
// are the identical failure shape one syntax variant away -- a future preset's comment or a
// string literal containing "--" would silently defeat the line-only version the same way the
// header comment did. Closed here rather than merely documented, since both are bounded,
// well-defined transformations over this grammar (exported as `maskComments` so
// watch.test.ts's block-comment and string-literal fixtures exercise this function directly,
// not just the one shipped file that happens to need it today).
export function maskComments(sql: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (!inString && two === "--") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (!inString && two === "/*") {
      let j = i + 2;
      while (j < sql.length && sql.slice(j, j + 2) !== "*/") j++;
      const end = Math.min(j + 2, sql.length);
      // Preserve newlines inside the block comment so line numbers in a later error message
      // (there are none today, but nothing here should assume that) stay meaningful.
      out += sql.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (ch === "'") {
      // Toggles correctly through a doubled '' escape too: two consecutive quote characters
      // flip `inString` twice with nothing (by definition) between them to mis-classify, so
      // the net state after `''` is unchanged, exactly as it should be for an escaped quote
      // inside an unbroken string.
      inString = !inString;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Substitute the closed-set direction keyword for the `{{DIRECTION}}` token, the same
 * exactly-once discipline resolve.ts's substituteIds uses for `{{IDS}}`. Only watch_gauge.sql
 * carries the token -- the other three presets each render one table and hardcode their own
 * ORDER BY -- so an absent token is not an error, just a fixed-direction preset.
 *
 * The substitution site is located in the MASKED text, not the raw one: watch_gauge.sql's
 * comment mentions the token before the real `ORDER BY` clause does, so a plain
 * `statement.replace(DIRECTION_TOKEN, ...)` against the raw text -- which only ever rewrites
 * the FIRST match -- would silently rewrite the comment instead, leaving the real clause
 * holding an unsubstituted token (a DuckDB syntax error at query time, not merely a
 * misordered result). Masking is length-preserving, so the located index is valid against
 * `statement` too. */
function substituteDirection(statement: string, file: string, direction: "asc" | "desc"): string {
  const masked = maskComments(statement);
  const occurrences = masked.split(DIRECTION_TOKEN).length - 1;
  if (occurrences === 0) return statement;
  if (occurrences !== 1) {
    throw new Error(
      `${file}.sql: expected at most one {{DIRECTION}} token outside comments, found ` +
        `${occurrences} -- substitution would silently misfire (replace() only touches the ` +
        "first match).",
    );
  }
  const idx = masked.indexOf(DIRECTION_TOKEN);
  return statement.slice(0, idx) + DIRECTION_SQL[direction] + statement.slice(idx + DIRECTION_TOKEN.length);
}

export async function runPreset(
  p: Preset,
  direction: "asc" | "desc",
  limit: number,
): Promise<WatchRow[]> {
  const entry = p.directions.find((d) => d.direction === direction);
  if (entry === undefined) {
    throw new Error(
      `runPreset(): '${direction}' is not a valid direction for preset '${p.slug}' -- ` +
        `valid directions are ${p.directions.map((d) => d.direction).join(", ")}.`,
    );
  }

  const raw = sql(p.sqlFile);
  const statement = substituteDirection(raw, p.sqlFile, direction);

  const con = await connect();
  const prepared = await con.prepare(statement);
  prepared.bind({ limit });
  const result = await prepared.run();
  const rows = (await result.getRowObjects()) as Record<string, unknown>[];
  return rows.map((r) => demoteBigInts(r) as unknown as WatchRow);
}

/** The Explorer permalink for the raw monthly rows behind one watch row: CLAUDE.md's "every
 * insight row is one click from the raw rows that produced it" rule, applied to a mart row
 * that has no id of its own to link through (mart_route_health has no primary key column the
 * Explorer's pivot understands). Filters on BOTH op_airline_id and route -- either alone
 * shows the wrong table (only the carrier: every route it flies; only the route: every
 * carrier on it), and this project treats a plausible-but-wrong link as worse than no link. */
export function rawRowsPermalink(row: WatchRow, timeFrom: string, timeTo: string): string {
  const query = normalizeQuery({
    grain: "segment",
    dimensions: ["year_month"],
    measures: ["seats", "passengers", "departures_performed"],
    timeFrom,
    timeTo,
    filters: [
      ["op_airline_id", [String(row.op_airline_id)]],
      ["route", [`${row.route_key_low}-${row.route_key_high}`]],
    ],
    sort: "year_month",
    sortDesc: false,
    limit: 100,
    grouping: "operating",
  });
  // `exploreHref`, never a second hand-spelled `/explore?${encode(q)}` -- that one line has
  // one owner (lib/pivot/builder.ts), and a private copy of it is a call site a future change
  // to what a valid `/explore` permalink requires would silently miss (#145).
  return exploreHref(query);
}

/** The canonical /route/ URL for a watch row's two airport CODES.
 *
 * A thin wrapper over routeHrefFromCodes rather than a second implementation: the ordering
 * rule has one owner (lib/entityLink.ts), and this is the caller that most needs it, since
 * watch rows arrive in airport-ID order straight from mart_route_health. */
export function routeCellHref(lowCode: string, highCode: string): string {
  return routeHrefFromCodes(lowCode, highCode);
}
