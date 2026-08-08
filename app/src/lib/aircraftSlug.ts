import { entitySlugFromPath } from "@/lib/entitySlug";
import { AmbiguousCodeError, lookupAircraftByName, type AircraftRef } from "@/lib/resolve";

/** The `<name>` half of an `/aircraft/<name>` pathname, and the prefix it starts after.
 *
 * Shared by `proxy.ts` (which needs the slug to decide cache-worthiness before the page runs)
 * and `not-found.tsx` (which needs it to re-derive the 404 reason, since `not-found.js` accepts
 * no props), so the two can never disagree about where the slug starts. */
export const AIRCRAFT_PREFIX = "/aircraft/";

// A one-line wrapper around lib/entitySlug.ts's entitySlugFromPath -- this file used to carry
// its own copy of the decode guard below (a deliberate one at the time: M4d built `/airport`,
// `/carrier` and `/aircraft` in three parallel tasks, and a shared helper would have been
// three agents editing one file). M5 Task 6 is the collapse that comment always pointed at.
// The wrapper (and AIRCRAFT_PREFIX above) stays, unchanged in name and behaviour, so nothing
// importing aircraftSlugFromPath needs an edit.
export function aircraftSlugFromPath(pathname: string): string | null {
  return entitySlugFromPath(pathname, AIRCRAFT_PREFIX);
}

/** `short_name` -> the URL slug. THE TRANSFORM, and the reason this module exists.
 *
 * The slug is NEVER the BTS `code`: 612 is the 737-700, not the A321, and nobody pastes
 * `/aircraft/614`. But `short_name` is not a path segment either -- 15 of the 112 fact-present
 * names carry a `/` or a space ('A320-1/2', 'MAX 8', 'FLT/AMPH', 'B767-3/R'), and
 * `/aircraft/A320-1/2` parses as TWO segments, so it can never match a single dynamic segment.
 * Matching `upper(short_name)` directly 404s all 15, including a band on the JFK-LAX chart.
 * Task 1 measured that and left the decision here.
 *
 * That count is 15 and not 16 because BTS RENAMED one out from under it: type 699 was
 * 'A321/LR' (this module's original worked example, and the design spec's) until the
 * 20260807 refresh made it 'A321nXLR', which carries no separator at all. The mechanism is
 * unaffected -- 15 names still need it -- but every fixture that used A321/LR to exercise it
 * had to move to 'A320-1/2', the highest-traffic separator-bearing type (987 M seats over the
 * full window, vs the 71,640 of B767-2/R, which stopped filing in 2020). Pick a replacement
 * fixture on traffic AND on still-filing, not on how well it reads.
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
 * over all 111 fact-present slugs is 2 (10 slugs have two, 64 have one, 37 have none), so 4 is
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
 * The canonical URL is the uppercased SLUG, so `/aircraft/a320-1-2` 308s to `/aircraft/A320-1-2`
 * -- never to `/aircraft/A320-1/2`, which is unroutable. */
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
