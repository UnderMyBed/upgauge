import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/sitemap";

/** Base URL env var, matching this project's `UPGAUGE_*` naming convention (db.ts's
 * `UPGAUGE_ROOT` / `UPGAUGE_DB`). Absolute URLs are what the sitemap protocol requires
 * (`<loc>` must be fully-qualified -- sitemaps.org), so a relative path from
 * `sitemapEntries()` alone is not enough, and the production hostname cannot be hardcoded
 * here -- CLAUDE.md's portability rule is "Docker + Parquet + env vars only", so a sensible
 * local default is what this reads without one set. */
const BASE_URL = process.env.UPGAUGE_BASE_URL ?? "http://localhost:3000";

/** The full crawl graph: every entity page this dataset can serve today, each dated by its
 * OWN last-filed month rather than the build date (`@/lib/sitemap`'s header explains why that
 * distinction needs a dormant-entity fixture, not an active one, to catch a regression).
 *
 * 23,689 URLs, quarantine-inclusive throughout (`sql/03_queries/sitemap_routes.sql`'s header:
 * a quarantined row is still a real filing and a real 200-serving page) --
 * `docs/product/scope.md` § D2 records the breakdown: 22,420 routes + 1,045 airports +
 * 114 carriers + 110 aircraft. Well under Google's 50,000-URL-per-sitemap limit, so one
 * sitemap file is enough and `generateSitemaps()`'s multi-file split is not needed. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [routes, airports, carriers, aircraft] = await Promise.all([
    sitemapEntries("routes"),
    sitemapEntries("airports"),
    sitemapEntries("carriers"),
    sitemapEntries("aircraft"),
  ]);
  return [...routes, ...airports, ...carriers, ...aircraft].map((entry) => ({
    url: `${BASE_URL}${entry.url}`,
    lastModified: entry.lastModified,
  }));
}
