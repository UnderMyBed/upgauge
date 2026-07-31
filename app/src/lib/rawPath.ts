/** The request header `proxy.ts` uses to hand the app the request's pathname.
 *
 * Sibling of `rawQuery.ts`'s `RAW_QUERY_HEADER`, and it exists for a different reason than
 * that one: nothing here is being rescued from Next's URL normalization. This header exists
 * because Next's `not-found.js` convention **accepts no props**
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/not-found.md:131),
 * so a segment-level 404 page has no route-parameter channel and cannot be told which slug
 * was requested.
 *
 * The documented alternative in that same file (`:181`) is a Client Component reading
 * `usePathname()`, which is what this project shipped first and then removed: it moves the
 * one value the page's entire message depends on onto a client boundary that no server-side
 * test and no served-build check can observe, so `usePathname()` returning null degrades the
 * page to a generic sentence with every gate still green. The same file's Data Fetching
 * example (`:135-152`) shows an `async not-found.tsx` calling `headers()` from
 * `next/headers` -- so a request header keeps the pathname on the server, where
 * `routePair.ts` can be re-run against it to name the *specific* offending code, and where a
 * `curl` against a served build can assert the rendered sentence. */
export const RAW_PATH_HEADER = "x-upgauge-path";

/** Thrown when the header is absent, which means `proxy.ts` did not run for this request.
 * Same fail-loud discipline as `MissingRawQueryError`: there is deliberately no fallback
 * (no `usePathname()`, no guess from `referer`) because a 404 page that silently stops
 * naming the offending code is exactly the "green tests, broken production" degradation this
 * header was introduced to make impossible. */
export class MissingRawPathError extends Error {
  constructor() {
    super(
      `request header '${RAW_PATH_HEADER}' is absent -- proxy.ts did not run for this ` +
        "request. A not-found.js render has no props and no route params, so it cannot " +
        "name the requested route without this header. Check that app/src/proxy.ts is " +
        "deployed and that its matcher covers this route.",
    );
    this.name = "MissingRawPathError";
  }
}

/** Pure, so it is testable against a real `Headers` object rather than a mocked `headers()`.
 * An empty string is not a legitimate pathname, so unlike `rawQueryFromHeaders` this rejects
 * falsiness rather than only null. */
export function rawPathFromHeaders(headers: { get(name: string): string | null }): string {
  const raw = headers.get(RAW_PATH_HEADER);
  if (!raw) throw new MissingRawPathError();
  return raw;
}

/** The `<pair>` half of a `/route/<pair>` pathname, or null if this is not a route page.
 * Shared by `proxy.ts` (which needs it to decide cache-worthiness before the page runs) and
 * `not-found.tsx` (which needs it to re-derive the 404 reason), so the two can never disagree
 * about where the slug starts. */
export const ROUTE_PREFIX = "/route/";

export function routeSlugFromPath(pathname: string): string | null {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  const raw = pathname.slice(ROUTE_PREFIX.length);
  // The page receives `params.pair` already percent-decoded, so decode here too or the two
  // would disagree about a slug like `JFK%2DLAX`. `decodeURIComponent` THROWS on a malformed
  // escape (`%zz`) -- that is bug #2 on smoke.sh's list of production-only failures, found
  // exactly once and never by a unit test -- so a malformed escape falls back to the raw
  // text, which resolveRoutePair then rejects as an unknown code. Never uncaught.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
