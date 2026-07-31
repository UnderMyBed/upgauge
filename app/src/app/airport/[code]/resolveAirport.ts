import { airportCodesExist, lookupAirportsByCode, type AirportRef } from "@/lib/resolve";
import { AIRPORT_PREFIX, airportSlugFromPath } from "@/lib/airport";

// Both used to be DEFINED here (M4d Task 5 built them as a local twin of lib/rawPath.ts's
// routeSlugFromPath, because three M4d tasks ran in parallel and one shared file is three
// agents editing one file). M5 Task 6 collapsed all four entity readers into
// lib/entitySlug.ts's entitySlugFromPath and moved this pair to lib/airport.ts -- a lib
// importing from an app route directory (proxy.ts, lib/entityLink.ts) was the smell that move
// exists to remove. Re-exported here, unchanged in name and behaviour, so this file's own
// existing importers (not-found.tsx, not-found.test.tsx) need no edit.
export { AIRPORT_PREFIX, airportSlugFromPath };

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
