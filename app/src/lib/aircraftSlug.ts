import { AmbiguousCodeError, lookupAircraftByName, type AircraftRef } from "@/lib/resolve";

/** The `<name>` half of an `/aircraft/<name>` pathname, and the prefix it starts after.
 *
 * Sibling of `rawPath.ts`'s `ROUTE_PREFIX`/`routeSlugFromPath`, and deliberately a second copy
 * of that four-line decode guard rather than a shared generic: M4d builds `/airport`,
 * `/carrier` and `/aircraft` in three parallel tasks, and a shared helper is three agents
 * editing one file. Hoisting `slugFromPath(prefix, pathname)` once all three have landed is the
 * right cleanup; doing it now would be a merge conflict instead of a refactor.
 *
 * Shared by `proxy.ts` (which needs the slug to decide cache-worthiness before the page runs)
 * and `not-found.tsx` (which needs it to re-derive the 404 reason, since `not-found.js` accepts
 * no props), so the two can never disagree about where the slug starts. */
export const AIRCRAFT_PREFIX = "/aircraft/";

export function aircraftSlugFromPath(pathname: string): string | null {
  if (!pathname.startsWith(AIRCRAFT_PREFIX)) return null;
  const raw = pathname.slice(AIRCRAFT_PREFIX.length);
  // The page receives `params.name` already percent-decoded, so decode here too or the two
  // would disagree about a slug like `B737%2D8`. `decodeURIComponent` THROWS on a malformed
  // escape (`%zz`) -- bug #2 on smoke.sh's list of production-only failures, found exactly once
  // and never by a unit test -- so a malformed escape falls back to the raw text, which
  // resolveAircraftSlug then rejects as an unknown type. Never uncaught.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `short_name` -> the URL slug. THE TRANSFORM, and the reason this module exists.
 *
 * The slug is NEVER the BTS `code`: 612 is the 737-700, not the A321, and nobody pastes
 * `/aircraft/614`. But `short_name` is not a path segment either -- 16 of the 112 fact-present
 * names carry a `/` or a space ('A321/LR', 'MAX 8', 'FLT/AMPH', 'B767-3/R'), and
 * `/aircraft/A321/LR` parses as TWO segments, so it can never match a single dynamic segment.
 * Matching `upper(short_name)` directly 404s all 16, including the design spec's own worked
 * example and a band on the JFK-LAX chart. Task 1 measured that and left the decision here.
 *
 * Both characters become `-`, and the result is uppercased. Measured over the live catalog:
 * injective across all 112 fact-present types (111 distinct slugs; the single repeat is CE-180
 * colliding with ITSELF, two BTS codes sharing one short name -- not two names flattened
 * together). That zero is a property of TODAY'S DATA, not of the scheme: the transform maps two
 * characters onto one that already occurs in names like B737-8, so a future refresh could
 * collide two distinct names. aircraftSlug.test.ts asserts the injectivity against the real
 * catalog, and `resolveFromMatches` fails loudly if it ever stops holding -- the same treatment
 * `CE-180` gets, for the same reason. */
export function slugFor(shortName: string): string {
  return shortName.replaceAll("/", "-").replaceAll(" ", "-").toUpperCase();
}

/** How many `-` separators a slug may carry before it is rejected unread.
 *
 * The candidate set below is 3^n, so an unbounded expansion turns
 * `/aircraft/-------------------` into a request to bind 3^19 parameters. The measured maximum
 * over all 111 fact-present slugs is 2 (10 slugs have two, 65 have one, 36 have none), so 4 is
 * twice the real world and still finite -- 81 candidates in the worst accepted case. The
 * catalog test pins the measurement, so a BTS refresh that ships a five-separator type fails a
 * test rather than a page. */
export const MAX_SLUG_SEPARATORS = 4;

/** Every `short_name` a slug could have come from, or `null` if the slug is over-separated.
 *
 * The transform is many-to-one, so its inverse is a SET: each `-` in the slug could have been a
 * `-`, a `/`, or a space in the name. Expanding here and letting the EXISTING lookup match the
 * real name is what keeps `lookup_aircraft_by_name.sql` a lookup by short name -- rewriting its
 * WHERE clause to compare slugs would make the file's name a lie and would move the collision
 * guard out from under Task 1's `insertUniqueByCode`, which keys on the short name. */
export function shortNameCandidates(slug: string): string[] | null {
  const parts = slug.split("-");
  if (parts.length - 1 > MAX_SLUG_SEPARATORS) return null;
  let out = [parts[0]];
  for (const part of parts.slice(1)) {
    out = out.flatMap((prefix) => ["-", "/", " "].map((sep) => `${prefix}${sep}${part}`));
  }
  return out;
}

export type AircraftSlugResult =
  | { kind: "ok"; type: AircraftRef; canonical: string }
  | { kind: "redirect"; canonical: string }
  /** The slug names more than one fact-present BTS aircraft type. `ids` are the zero-padded
   * codes, as strings, so the page can name each airframe and link to it in the Explorer. */
  | { kind: "ambiguous"; slug: string; ids: string[] }
  | { kind: "notFound"; reason: string };

/** Turn the lookup's matches into an outcome. Pure, and separated from the query for one
 * reason: the >1 branch is unreachable from live data (the transform is injective today), so a
 * direct call is the only way to observe it -- the same split, for the same reason, as
 * `resolve.ts`'s `insertUniqueByCode`. */
export function resolveFromMatches(slug: string, matches: AircraftRef[]): AircraftSlugResult {
  if (matches.length === 0) {
    return {
      kind: "notFound",
      reason: `unknown aircraft type '${slug}'`,
    };
  }
  if (matches.length > 1) {
    // Two DIFFERENT short names flattened onto one slug. Distinct from the CE-180 case (one
    // short name, two BTS codes), which `lookupAircraftByName` throws for, but the answer is
    // the same: name both, resolve neither.
    return { kind: "ambiguous", slug, ids: matches.map((m) => m.id) };
  }
  const type = matches[0];
  return { kind: "ok", type, canonical: slugFor(type.code) };
}

/** Parse, canonicalise and resolve an `/aircraft/<slug>` segment.
 *
 * Four outcomes, and `ambiguous` is not a should-never-happen: `/aircraft/CE-180` is a
 * REACHABLE URL today. Code 030 (CESSNA 180) and code 031 (CESSNA 180A/B) share that short
 * name, both really flew, and no scoping resolves it -- narrowing to the trailing 12 months
 * makes it vanish today and brings it back as a production 500 the first month both file
 * (lookup_aircraft_by_name.sql). So the page names both airframes rather than rendering
 * whichever row DuckDB returned last, which is what the `AUS` bug did.
 *
 * The canonical URL is the uppercased SLUG, so `/aircraft/a321-lr` 308s to `/aircraft/A321-LR`
 * -- never to `/aircraft/A321/LR`, which is unroutable. */
export async function resolveAircraftSlug(slug: string): Promise<AircraftSlugResult> {
  const trimmed = slug.trim();
  if (trimmed.length === 0) return { kind: "notFound", reason: "no aircraft type named" };

  const candidates = shortNameCandidates(slugFor(trimmed));
  if (candidates === null) {
    return {
      kind: "notFound",
      reason:
        `'${trimmed}' has more than ${MAX_SLUG_SEPARATORS} separators; no aircraft type ` +
        "short name has more than two",
    };
  }

  let found: Map<string, AircraftRef>;
  try {
    found = await lookupAircraftByName(candidates);
  } catch (e: unknown) {
    // ONE short name, several BTS codes -- Task 1 put the candidates on the error precisely so
    // this branch does not have to regex a message. Anything else is a real failure and must
    // stay loud: swallowing it here would turn a broken database into a 404.
    if (e instanceof AmbiguousCodeError) {
      return {
        kind: "ambiguous",
        slug: slugFor(trimmed),
        ids: e.ids.map((id) => String(id)),
      };
    }
    throw e;
  }

  const resolved = resolveFromMatches(slugFor(trimmed), [...found.values()]);
  if (resolved.kind === "ok" && resolved.canonical !== slug) {
    return { kind: "redirect", canonical: resolved.canonical };
  }
  return resolved;
}
