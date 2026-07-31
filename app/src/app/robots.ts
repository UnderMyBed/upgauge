import type { MetadataRoute } from "next";

// Same env var, same default, as app/sitemap.ts -- kept as two separate reads rather than a
// shared constant module because these are the only two consumers and Next resolves each
// file convention independently at the routing layer; a shared import would not save
// anything a comment doesn't already say.
const BASE_URL = process.env.UPGAUGE_BASE_URL ?? "http://localhost:3000";

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
