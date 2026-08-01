import type { MetadataRoute } from "next";
import { BASE_URL } from "@/lib/siteUrl";

// Same shared constant as app/sitemap.ts and the four entity pages' canonical <link> tags
// (M5 Task 2 fix round 1, Critical 1) -- one definition of `UPGAUGE_BASE_URL`'s default
// rather than each consumer re-declaring the same literal.

// M5 Task 8, same reasoning and same measured build failure as app/sitemap.ts's identical
// export -- see that file's header. This one reads no database at all (BASE_URL is an env
// var), so it was never going to 500 the way sitemap.ts did, but leaving it prerenderable
// would freeze it against whatever UPGAUGE_BASE_URL the build-time environment happened to
// have, silently disagreeing with the runtime value if they ever differ (a staging build vs. a
// production run of the same image, for instance) -- the identical staleness class
// `dynamic = "force-dynamic"` exists to rule out on every other route in this app.
export const dynamic = "force-dynamic";

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
