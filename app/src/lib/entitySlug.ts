/** One reader for the `<prefix><slug>` shape every entity page's pathname takes.
 *
 * Before this file, four modules (`lib/rawPath.ts`'s `routeSlugFromPath`,
 * `app/airport/[code]/resolveAirport.ts`'s `airportSlugFromPath`, `lib/carrier.ts`'s
 * `carrierSlugFromPath`, `lib/aircraftSlug.ts`'s `aircraftSlugFromPath`) carried a
 * byte-identical copy of the same four-line decode guard. That was deliberate at the time --
 * M4d built three of those pages in parallel tasks, and a shared file is three agents editing
 * one file -- but `proxy.ts`'s own header comment named the collapse as the intended follow-up
 * once all three existed, and `CLAUDE.md`'s M5 punch list is where that follow-up landed.
 *
 * `decodeURIComponent` THROWS on a malformed percent-escape (`%zz`, or the more exotic
 * `%E0%A4%A`) -- bug #2 on `smoke.sh`'s list of production-only failures, found once and never
 * by a unit test, because a page receives `params.<x>` already decoded by Next while
 * `proxy.ts` and every `not-found.tsx` read the RAW pathname and must decode it themselves to
 * agree. An uncaught throw here is a 500 on a page whose entire job is to render a 404, so a
 * malformed escape falls back to the raw (still-encoded) text instead -- every downstream
 * resolver then rejects that raw text as an unrecognized code, which is the honest outcome.
 *
 * Deliberately un-opinionated beyond that: it does not special-case an empty slug (the bare
 * prefix, e.g. `/carrier/`) or a nested path (`/carrier/DL/extra`) -- both come back as the
 * literal text after the prefix (`""`, `"DL/extra"`), exactly as `routeSlugFromPath`,
 * `carrierSlugFromPath` and `aircraftSlugFromPath` always have. `airportSlugFromPath`
 * (`lib/airport.ts`) is the one caller that additionally maps `""` to `null` -- a quirk that
 * predates this collapse (pinned by its own not-found.test.tsx) and does not generalize to the
 * other three, so it stays a one-line wrapper around this function rather than a parameter
 * here. */
export function entitySlugFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The segment Next appends to an entity route for its `opengraph-image.tsx` file convention.
 *
 * One dynamic segment, then this literal -- `/route/JFK-LAX/opengraph-image`. There is no
 * `/[id]` segment and no content-hash PATH segment: `generateImageMetadata` is what would add
 * one, and none of the four cards uses it (each route's own `alt` comment says why). Measured
 * on the served production build, `next start` on :3251. */
export const OG_SUFFIX = "/opengraph-image";

/** The `<slug>` half of a `/<prefix>/<slug>/opengraph-image` pathname, or null if this is not
 * an OG card route.
 *
 * Shared by `proxy.ts`'s OG cache branch and `lib/canonicalQuery.ts`'s four OG rows, for the
 * same reason `routeSlugFromPath` is shared by `proxy.ts` and `not-found.tsx`: the cache branch
 * and the query gate must never disagree about which requests are OG cards or about where the
 * slug starts. It lives HERE, beside the decode guard it wraps, rather than in either consumer
 * -- this module imports nothing, so both can import it without an edge between them (`proxy.ts`
 * already imports `canonicalize` from `canonicalQuery.ts`, and a reader owned by that file would
 * have been the only reason for an edge back).
 *
 * Delegates the decode to `entitySlugFromPath` above rather than carrying its own
 * `decodeURIComponent` guard -- that guard existed in four copies once and M5 Task 6 collapsed
 * it; a fifth copy here would be the same defect re-introduced. The suffix comes off the RAW
 * pathname first, so a malformed escape inside the slug (`%zz`) still falls back to raw text
 * without taking the suffix test with it.
 *
 * Two extra rejections beyond the prefix test, both matching what `config.matcher`'s
 * `/<entity>/:slug/opengraph-image` shape actually forwards: an empty slug (`/route//
 * opengraph-image`) and a slug containing `/` (more than one dynamic segment). Without them this
 * reader would claim pathnames the matcher never sends here, and the branch that resolves them
 * would answer for a request that does not exist. */
export function ogSlugFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.endsWith(OG_SUFFIX)) return null;
  const slug = entitySlugFromPath(pathname.slice(0, -OG_SUFFIX.length), prefix);
  if (slug === null || slug === "" || slug.includes("/")) return null;
  return slug;
}
