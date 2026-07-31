import { entitySlugFromPath } from "@/lib/entitySlug";

/** Where an airport page's slug starts. Shared by `not-found.tsx` (which has no props and no
 * route params, so it re-derives the slug from proxy.ts's RAW_PATH_HEADER -- see
 * lib/rawPath.ts) and `proxy.ts` itself, which resolves the entity before the page runs to
 * decide whether the response is cacheable. One constant, so the two can never disagree about
 * where the code begins.
 *
 * Lives here, in `lib/`, rather than beside `resolveAirportCode` in
 * `app/airport/[code]/resolveAirport.ts` where it and `airportSlugFromPath` both used to live --
 * M5 Task 6 moved both out, because `proxy.ts` and `lib/entityLink.ts` importing a route
 * segment's own file is the smell CLAUDE.md's M5 list named directly. `resolveAirport.ts`
 * re-exports both so nothing importing from there has to change. */
export const AIRPORT_PREFIX = "/airport/";

/** The `<code>` half of an `/airport/<code>` pathname, or null if this is not an airport page
 * OR the code segment is empty (`/airport/` with nothing after it).
 *
 * A thin wrapper around `lib/entitySlug.ts`'s `entitySlugFromPath` -- every other entity
 * reader (`routeSlugFromPath`, `carrierSlugFromPath`, `aircraftSlugFromPath`) is now exactly
 * that function under a different prefix, but this one carries one extra line: mapping the
 * bare-prefix case to `null` rather than `""`, so an empty code segment is never sent into
 * `resolveAirportCode` as a slug to reject -- Next would not route `/airport/` to `[code]` at
 * all, and returning `""` here would send an empty IN-list toward the lookup instead of
 * opting the request out of entity resolution entirely. That quirk predates this file (pinned
 * by `app/airport/[code]/not-found.test.tsx`'s `airportSlugFromPath("/airport/")` -> `null`
 * assertion) and does not generalize to the other three readers, which is why it is a
 * one-line wrapper here rather than a parameter on `entitySlugFromPath` itself. */
export function airportSlugFromPath(pathname: string): string | null {
  const slug = entitySlugFromPath(pathname, AIRPORT_PREFIX);
  return slug === "" ? null : slug;
}
