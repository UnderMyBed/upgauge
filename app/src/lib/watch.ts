import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, demoteBigInts } from "@/lib/db";
import { routeHrefFromCodes } from "@/lib/entityLink";
import { normalizeQuery } from "@/lib/pivot/types";
import { encode } from "@/lib/pivot/urlstate";

// Same anchor, same reason, as db.ts's ROOT / sitemap.ts's ROOT: process.cwd() is correct in
// production; Vitest gets a chdir of its own from vitest.config.ts's setupFiles.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

function sql(name: string): string {
  return readFileSync(path.join(QUERIES_DIR, `${name}.sql`), "utf8");
}

export type PresetSlug = "gauge" | "empty-planes" | "new-routes" | "death-watch";

export const PRESETS: readonly PresetSlug[] = ["gauge", "empty-planes", "new-routes", "death-watch"];

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
      frame: "First appearance since 2015 -- new service nobody flew last year.",
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

/** Substitute the closed-set direction keyword for the `{{DIRECTION}}` token, the same
 * exactly-once discipline resolve.ts's substituteIds uses for `{{IDS}}`. Only watch_gauge.sql
 * carries the token -- the other three presets each render one table and hardcode their own
 * ORDER BY -- so an absent token is not an error, just a fixed-direction preset. */
function substituteDirection(statement: string, file: string, direction: "asc" | "desc"): string {
  const occurrences = statement.split("{{DIRECTION}}").length - 1;
  if (occurrences === 0) return statement;
  if (occurrences !== 1) {
    throw new Error(
      `${file}.sql: expected at most one {{DIRECTION}} token, found ${occurrences} -- ` +
        "substitution would silently misfire (replace() only touches the first match)",
    );
  }
  return statement.replace("{{DIRECTION}}", DIRECTION_SQL[direction]);
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
  return `/explore?${encode(query)}`;
}

/** The canonical /route/ URL for a watch row's two airport CODES.
 *
 * A thin wrapper over routeHrefFromCodes rather than a second implementation: the ordering
 * rule has one owner (lib/entityLink.ts), and this is the caller that most needs it, since
 * watch rows arrive in airport-ID order straight from mart_route_health. */
export function routeCellHref(lowCode: string, highCode: string): string {
  return routeHrefFromCodes(lowCode, highCode);
}
