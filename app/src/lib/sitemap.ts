import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, dataAsOf } from "@/lib/db";
import { AIRPORT_PREFIX } from "@/lib/airport";
import { CARRIER_PREFIX } from "@/lib/carrier";
import { AIRCRAFT_PREFIX, slugFor } from "@/lib/aircraftSlug";
import { routeHrefFromCodes } from "@/lib/entityLink";
import { PRESETS, WATCH_PREFIX } from "@/lib/watch";

// Same anchor, same reason, as db.ts's ROOT / resolve.ts's ROOT: process.cwd() is correct in
// production; Vitest gets a chdir of its own from vitest.config.ts's setupFiles.
const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const QUERIES_DIR = path.join(ROOT, "sql", "03_queries");

function sql(name: string): string {
  return readFileSync(path.join(QUERIES_DIR, `${name}.sql`), "utf8");
}

export type SitemapKind = "routes" | "airports" | "carriers" | "aircraft" | "watch";

export interface SitemapEntry {
  url: string;
  lastModified: Date;
}

/** `sitemap_*.sql`'s `lastmod` column is always `'YYYY-MM-01'` (a VARCHAR -- `year_month`
 * itself is stored as one, not a DATE -- CLAUDE.md: "BTS dates arrive as strings ... parse
 * before sorting" is the general rule this specific column follows too). Parsed here, in the
 * ONE place a sitemap row becomes a `Date`, rather than at each of the four call sites, so a
 * malformed value fails loudly with the entity it belongs to named in the message instead of
 * silently becoming `Invalid Date` inside a `<lastmod>` tag no test reads byte-for-byte.
 * `T00:00:00Z` anchors the parse to UTC midnight -- without it `new Date('2018-03-01')` is
 * still UTC-midnight per the ECMA-262 date-only grammar, but spelling it out here means this
 * function does not depend on that grammar's date-only special case to stay correct if a
 * caller ever hands it a value with a time component. */
export function parseLastmod(value: unknown, context: string): Date {
  if (typeof value !== "string") {
    throw new Error(
      `sitemapEntries(): ${context} lastmod was not a string (got ${typeof value}) -- ` +
        "check sitemap_*.sql's lastmod column expression.",
    );
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`sitemapEntries(): ${context} lastmod '${value}' did not parse as a date.`);
  }
  return parsed;
}

async function routesEntries(): Promise<SitemapEntry[]> {
  const con = await connect();
  const rows = await (await con.run(sql("sitemap_routes"))).getRowObjects();
  return rows.map((r) => {
    const loCode = String(r.lo_code);
    const hiCode = String(r.hi_code);
    // sitemap_routes.sql returns the pair in AIRPORT-ID order, which disagrees with the
    // alphabetical URL order for 215 of 22,509 pairs (its own header; HPN/BNH is the
    // measured example). routeHrefFromCodes -- the same function /explore's route cells link
    // through -- is what re-sorts; reusing the SQL's own id order here would silently mint
    // 154 sitemap URLs that /route/<pair> itself 308s away from.
    return {
      url: routeHrefFromCodes(loCode, hiCode),
      lastModified: parseLastmod(r.lastmod, `route ${loCode}-${hiCode}`),
    };
  });
}

async function airportsEntries(): Promise<SitemapEntry[]> {
  const con = await connect();
  const rows = await (await con.run(sql("sitemap_airports"))).getRowObjects();
  return rows.map((r) => {
    const code = String(r.code);
    return {
      url: AIRPORT_PREFIX + encodeURIComponent(code),
      lastModified: parseLastmod(r.lastmod, `airport ${code}`),
    };
  });
}

async function carriersEntries(): Promise<SitemapEntry[]> {
  const con = await connect();
  const rows = await (await con.run(sql("sitemap_carriers"))).getRowObjects();
  return rows.map((r) => {
    const code = String(r.code);
    return {
      url: CARRIER_PREFIX + encodeURIComponent(code),
      lastModified: parseLastmod(r.lastmod, `carrier ${code}`),
    };
  });
}

export interface AircraftRow {
  shortName: string;
  lastmod: unknown;
}

/** Fold sitemap_aircraft.sql's rows into slug -> row, throwing on a collision between two
 * DIFFERENT short names that slug to the same value.
 *
 * sitemap_aircraft.sql already excludes the one short name (CE-180) that identifies two
 * DIFFERENT fact-present BTS codes, taking 111 distinct short names to 110 -- that is a
 * same-short-name collision, resolved in SQL. This function guards the OTHER direction:
 * slugFor() maps `/` and ' ' onto '-', a character that already occurs in names like
 * 'B737-8', so two DIFFERENT short names could in principle collapse onto the same slug.
 * aircraftSlug.ts's own header records that this is injective over TODAY's 111 distinct
 * fact-present short names (measured) but is a property of the data, not the scheme -- a
 * future BTS refresh could reintroduce it, and there is no live example to reach this branch
 * through the real database today. Pulled out of aircraftEntries, the same way resolve.ts
 * pulls insertUniqueByCode out of its lookup functions, so the guard is directly testable
 * with synthetic rows rather than only reachable (never, on current data) through a real
 * query. A collision throws rather than silently overwriting the first entry -- which would
 * point the sitemap at a page keyed on the OTHER name -- or silently emitting two identical
 * `<loc>` entries. */
export function dedupeAircraftBySlug(rows: AircraftRow[]): Map<string, AircraftRow> {
  const bySlug = new Map<string, AircraftRow>();
  for (const row of rows) {
    const slug = slugFor(row.shortName);
    const existing = bySlug.get(slug);
    if (existing !== undefined) {
      throw new Error(
        `sitemapEntries("aircraft"): short names '${existing.shortName}' and ` +
          `'${row.shortName}' both slug to '${slug}' -- aircraftSlug.ts's slugFor() is no ` +
          "longer injective over the fact-present catalog. Refusing to silently pick one.",
      );
    }
    bySlug.set(slug, row);
  }
  return bySlug;
}

async function aircraftEntries(): Promise<SitemapEntry[]> {
  const con = await connect();
  const rows = await (await con.run(sql("sitemap_aircraft"))).getRowObjects();
  const bySlug = dedupeAircraftBySlug(
    rows.map((r) => ({ shortName: String(r.short_name), lastmod: r.lastmod })),
  );
  return [...bySlug.entries()].map(([slug, { shortName, lastmod }]) => ({
    url: AIRCRAFT_PREFIX + encodeURIComponent(slug),
    lastModified: parseLastmod(lastmod, `aircraft ${shortName}`),
  }));
}

/** `/watch` plus its four presets (M6 Task 7) -- five URLs, ALL dated by the dataset's own
 * `asOf` month, deliberately NOT the per-entity last-filed month the four functions above use.
 * The distinction those functions draw (`/carrier/VX`'s own header, immediately below) exists
 * because an entity page's content is anchored to what THAT entity filed, so its own last-filed
 * month is the honest "this changed last" answer and the build date would lie about a dormant
 * carrier. None of that applies here: `/watch` and every preset are dataset-WIDE views over
 * `mart_route_health`'s current trailing-12 window (`lib/watch.ts`'s `runPreset()`) -- there is
 * no single underlying entity whose own filing date could anchor them, and the one date that
 * actually describes "what this leaderboard is current as of" is the same `asOf` value the
 * page's own `DATA AS OF` badge shows. Reusing `parseLastmod` (rather than constructing a `Date`
 * inline) keeps the one malformed-input guard shared across every sitemap section instead of a
 * fifth copy of it. */
async function watchEntries(): Promise<SitemapEntry[]> {
  const asOf = await dataAsOf();
  const lastModified = parseLastmod(`${asOf}-01`, "watch");
  const watchIndexUrl = WATCH_PREFIX.slice(0, -1); // "/watch/" -> "/watch"
  return [watchIndexUrl, ...PRESETS.map((slug) => `${WATCH_PREFIX}${slug}`)].map((url) => ({
    url,
    lastModified,
  }));
}

/** Every URL for one section of the crawl graph, with the entity's own last-filed month as
 * `lastModified` -- never the build date (see sitemap_*.sql: `lastmod` is `max(year_month)`
 * per entity, not `data_as_of.sql`'s single dataset-wide value). `/carrier/VX` (Virgin
 * America, last filed 2018-03) is the fixture this distinction needs: an active entity's last
 * filed month and the current window coincide, so a bug that reports the build date instead
 * would still pass a test anchored on an active carrier.
 *
 * `"watch"` (M6 Task 7) is the one kind that does NOT follow that rule, on purpose --
 * `watchEntries()`'s own header explains why a dataset-wide view has no per-entity date to
 * anchor to and uses `asOf` instead. */
export async function sitemapEntries(kind: SitemapKind): Promise<SitemapEntry[]> {
  switch (kind) {
    case "routes":
      return routesEntries();
    case "airports":
      return airportsEntries();
    case "carriers":
      return carriersEntries();
    case "aircraft":
      return aircraftEntries();
    case "watch":
      return watchEntries();
  }
}
