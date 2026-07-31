import type { MetadataRoute } from "next";
import { BASE_URL } from "@/lib/siteUrl";

// Same shared constant as app/sitemap.ts and the four entity pages' canonical <link> tags
// (M5 Task 2 fix round 1, Critical 1) -- one definition of `UPGAUGE_BASE_URL`'s default
// rather than each consumer re-declaring the same literal.

/** `/search` is disallowed for the same reason Task 8's proxy gives it `no-store` rather than
 * the project's 30-day cache: `q` is an unbounded, attacker-chosen string, and a crawler
 * enumerating it is the same cache/crawl-budget problem either way. `/api/` is disallowed
 * because it is a data endpoint, not a page -- `/api/pivot` has no canonical content for a
 * crawler to index. Everything else -- the four entity page families, `/explore` -- is the
 * crawl graph this milestone exists to open up, so it is allowed outright rather than
 * enumerated. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/search", "/api/"],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
