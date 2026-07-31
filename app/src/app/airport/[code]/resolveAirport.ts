import { airportCodesExist, lookupAirportsByCode, type AirportRef } from "@/lib/resolve";

/** Where an airport page's slug starts. Shared by `not-found.tsx` (which has no props and no
 * route params, so it re-derives the slug from proxy.ts's RAW_PATH_HEADER -- see
 * lib/rawPath.ts) and, once M4d Task 5 wires it, by `proxy.ts` itself, which must resolve the
 * entity before the page runs to decide whether the response is cacheable. One constant, so
 * the two can never disagree about where the code begins. */
export const AIRPORT_PREFIX = "/airport/";

/** The `<code>` half of an `/airport/<code>` pathname, or null if this is not an airport page.
 *
 * Deliberately a local twin of `lib/rawPath.ts`'s `routeSlugFromPath` rather than an edit to
 * it: Tasks 2, 3 and 4 of M4d run in parallel and all three need exactly this, so three
 * simultaneous edits to one shared file is a merge conflict by construction. The
 * generalization -- one `slugFromPath(prefix, pathname)` in lib/rawPath.ts -- belongs to
 * whichever task lands last, and is noted in this task's report. */
export function airportSlugFromPath(pathname: string): string | null {
  if (!pathname.startsWith(AIRPORT_PREFIX)) return null;
  const raw = pathname.slice(AIRPORT_PREFIX.length);
  if (raw.length === 0) return null;
  // `decodeURIComponent` THROWS on a malformed escape ('%zz') -- bug #2 on smoke.sh's list of
  // production-only failures, found once and never by a unit test -- so a malformed escape
  // falls back to the raw text, which resolveAirportCode then rejects by name. Never uncaught.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export type AirportResult =
  | { kind: "ok"; airport: AirportRef }
  | { kind: "redirect"; canonical: string }
  | { kind: "notFound"; reason: string };

/** Parse and canonicalise an `/airport/<code>` slug.
 *
 * The airport half of `lib/routePair.ts`, deliberately the same three-way shape (ok /
 * redirect / notFound) so `page.tsx` and `not-found.tsx` read the same as `/route/<pair>`'s.
 * One thing is simpler here and one is not:
 *
 *   - simpler: a single code has only ONE canonical form (uppercase), where a pair has two
 *     competing orderings (alphabetical for the URL, id order for the query).
 *   - not simpler: the code is uppercased for the URL but the lookup is case-insensitive, so
 *     `/airport/sea` RESOLVES. Redirecting rather than serving it is what keeps one page on
 *     one URL with one CDN cache entry.
 *
 * `lookupAirportsByCode` throws `AmbiguousCodeError` if a code ever matches two fact-present
 * airports. That is deliberately NOT caught here: it cannot happen on today's data (measured:
 * 36 codes collide among all is_latest airports, 0 among fact-present ones -- see
 * `sql/03_queries/lookup_airport_by_code.sql`), and a loud 500 is the right answer to a
 * broken uniqueness guarantee. Rendering an arbitrary one of two airports under a DATA AS OF
 * badge is the failure the guard exists to prevent -- `AUS` resolved to an airport closed
 * since 1999 (docs/data/invariants.md § Entity resolution). */
export async function resolveAirportCode(slug: string): Promise<AirportResult> {
  const trimmed = slug.trim();
  if (trimmed.length === 0) {
    return { kind: "notFound", reason: `expected an airport code, got '${slug}'` };
  }

  const canonical = trimmed.toUpperCase();
  if (canonical !== slug) return { kind: "redirect", canonical };

  const found = await lookupAirportsByCode([canonical]);
  const airport = found.get(canonical);
  if (airport === undefined) {
    // Exactly routePair.ts's split, for the same reason: a code this domestic-only dataset
    // (T-100 Segment) has no rows for still resolves in dim_airport's global roster, so the
    // fact-presence filter rejects LHR and a typo identically. Neither branch changes the
    // outcome -- both stay a named 404, never a silent resolve to an airport with nothing to
    // show -- but a reader is owed the difference.
    const recognized = await airportCodesExist([canonical]);
    return {
      kind: "notFound",
      reason: recognized.has(canonical)
        ? `'${canonical}' is a recognized airport code, but this dataset is domestic-only ` +
          "(T-100 Segment) and carries no rows for it"
        : `unknown airport code '${canonical}'`,
    };
  }

  return { kind: "ok", airport };
}
