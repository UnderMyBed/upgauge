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
