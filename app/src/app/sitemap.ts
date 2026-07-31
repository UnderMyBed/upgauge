import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/sitemap";
import { BASE_URL } from "@/lib/siteUrl";

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
