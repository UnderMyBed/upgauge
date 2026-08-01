import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/sitemap";
import { BASE_URL } from "@/lib/siteUrl";

// M5 Task 8. Without this, `next build` tries to PRERENDER this route at build time -- Next's
// own docs: "sitemap.js is a special Route Handler that is cached by default unless it uses a
// Request-time API or dynamic config option" -- and build-time prerendering runs with cwd
// wherever the build tool started (`npm --prefix app run build`, the command every documented
// entry point uses, changes cwd to app/ BEFORE running `next build`), not the repo root
// `db.ts`'s WORKDIR contract assumes (docs/architecture/hosting.md's Portability test /
// Environment variables sections). Measured: `make app-build` failed outright --
// `IO Error: Cannot open database ".../app/upgauge.duckdb" in read-only mode: database does
// not exist` -- the first time this file was actually built rather than only typechecked,
// because `make app-smoke` (the only gate that runs a real `next build`) is the one M5 task
// reserves for a dedicated pass, per this repo's 8GB-memory working agreement. Every other
// DB-touching route already carries this export for the identical reason (`/`, `/explore`,
// each entity page); sitemap.ts and robots.ts were the two that had not, because neither
// looked like a "page" when Task 5 wrote them.
export const dynamic = "force-dynamic";

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
