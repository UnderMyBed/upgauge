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
 * Exactly one non-empty RAW segment follows the prefix, or this returns null -- the same shape
 * a `[param]` folder's PAGE receives: `/carrier/DL` reaches `[code]`'s page with `code` =
 * `"DL"`, while `/carrier/` and `/carrier/DL/x` reach no page there. (The one route `[code]`
 * carries besides the page is its `opengraph-image` card, which `ogSlugFromPath` below reads by
 * stripping that suffix first.) The check runs on the RAW text, before decoding: an encoded
 * slash (`%2F`) stays inside one segment -- `/carrier/D%2FL` is a single path segment, and Next
 * routes it to `[code]`'s page with `code` = `"D/L"` -- so checking after decoding would wrongly
 * split a legitimate slug in two.
 *
 * `decodeURIComponent` THROWS on a malformed percent-escape (`%zz`, or the more exotic
 * `%E0%A4%A`) -- bug #2 on `smoke.sh`'s list of production-only failures, found once and never
 * by a unit test, because a page receives `params.<x>` already decoded by Next while
 * `proxy.ts` and every `not-found.tsx` read the RAW pathname and must decode it themselves to
 * agree. An uncaught throw here is a 500 on a page whose entire job is to render a 404, so a
 * malformed escape falls back to the raw (still-encoded) text instead -- every downstream
 * resolver then rejects that raw text as an unrecognized code, which is the honest outcome. */
export function entitySlugFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (raw === "" || raw.includes("/")) return null;
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
 * Delegates the whole one-segment rule to `entitySlugFromPath` above rather than carrying its
 * own copy -- that guard existed in four copies once and M5 Task 6 collapsed it; a fifth copy
 * here would be the same defect re-introduced. The suffix comes off the RAW pathname first, so
 * a malformed escape inside the slug (`%zz`) still falls back to raw text without taking the
 * suffix test with it, and an empty slug (`/route//opengraph-image`) or one carrying more than
 * one segment (`/route/JFK-LAX/extra/opengraph-image`) is refused by the same check that refuses
 * it on every other entity page. */
export function ogSlugFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.endsWith(OG_SUFFIX)) return null;
  return entitySlugFromPath(pathname.slice(0, -OG_SUFFIX.length), prefix);
}
