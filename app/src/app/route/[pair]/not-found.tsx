import Link from "next/link";
import { headers } from "next/headers";
import { dataAsOf } from "@/lib/db";
import { rawPathFromHeaders, routeSlugFromPath } from "@/lib/rawPath";
import { resolveRoutePair } from "@/lib/routePair";
import { TopBar } from "@/components/TopBar";
import { RECOVERY_HREF } from "@/lib/pivot/recovery";

// Same reasoning as page.tsx's own export of this constant: DATA AS OF must never be frozen
// at build time, even on the 404 path -- a statically-cached 404 would keep serving a stale
// badge to every visitor forever. proxy.ts sets `no-store` on this response for the same
// reason one level out, at the CDN (see its NEW-1 comment).
export const dynamic = "force-dynamic";

/** The specific reason this slug is not a route, in `routePair.ts`'s own words -- which name
 * the offending CODE (`unknown airport code 'ZZZZ'`), not merely the pair.
 *
 * Re-running `resolveRoutePair` rather than receiving `page.tsx`'s result is forced by the
 * framework: `notFound()` takes no argument and `not-found.js` accepts no props, so there is
 * no channel between the two renders. It is one extra read of dimension-sized tables, on a
 * request that has already decided it has nothing else to do.
 *
 * A non-`notFound` outcome is unreachable in practice (this file only renders because
 * `page.tsx` threw `notFound()` for this same slug) but is not asserted away: a slug that
 * resolves on the second call would otherwise render an empty sentence. */
async function reasonFor(pathname: string): Promise<string | null> {
  const slug = routeSlugFromPath(pathname);
  if (slug === null) return null;
  const resolved = await resolveRoutePair(slug);
  return resolved.kind === "notFound" ? resolved.reason : null;
}

/** Next's `not-found.js` convention: rendered when `notFound()` is thrown from a page in this
 * route segment (`page.tsx`'s `RoutePage`, for all of `routePair.ts`'s `notFound` reasons --
 * a malformed slug, an unknown code, a same-airport slug, and a real airport this
 * domestic-only dataset has no rows for). Without this file Next's own stock UI rendered
 * instead -- `404 | This page could not be found.`, no wordmark, no `DATA AS OF`, no hint of
 * what routePair.ts already worked out. CLAUDE.md: "DATA AS OF ... is a first-class element
 * on every data view" -- this page still asserts something about the data (that a query
 * against it would answer nothing), so it keeps the badge rather than treating a 404 as
 * data-free.
 *
 * Matches explore/page.tsx's error-page structure (wrap > TopBar + main.error-page > h1 +
 * p[role=alert] + a recovery link) so the two "this URL didn't work" pages read as one
 * system, not two ad hoc ones -- and, like `ExploreView`, takes its one request-derived value
 * as a prop so the whole page is renderable in a test without mocking a framework seam.
 *
 * Fix wave 2, Important 2: this was briefly a Client Component reading `usePathname()`,
 * because `not-found.js` accepts no props (not-found.md:131) and the same docs point at
 * client-side fetching for path-derived content (`:181`). That named the PAIR, which is
 * weaker than the "naming the offending code" four doc sites promise, and it put the value
 * the entire message depends on somewhere no server test and no `curl` could see it. The same
 * docs' Data Fetching example (`:135-152`) shows an async `not-found.tsx` calling `headers()`
 * -- and proxy.ts already sets a request header on every one of these requests -- so the
 * pathname arrives server-side (lib/rawPath.ts) and the real reason can be re-derived. */
export async function NotFoundView({ pathname }: { pathname: string }) {
  const [asOf, reason] = await Promise.all([dataAsOf(), reasonFor(pathname)]);
  const slug = routeSlugFromPath(pathname);
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>Route not found</h1>
        <p role="alert">
          {slug !== null && reason !== null ? (
            <>
              We can&rsquo;t show &lsquo;{slug}&rsquo;: {reason}.
            </>
          ) : (
            <>We don&rsquo;t recognize this page.</>
          )}
        </p>
        <p>
          {/* eslint-plugin-next flags a literal <a href="/route/..."> against this exact
              dynamic route ([pair]) as "use next/link instead" -- it does NOT flag the
              Explorer link below, whose href carries a query string, so only this one needed
              the swap.
              `prefetch={false}` is load-bearing here, not style -- TopBar.tsx's own note
              has the why in full, and prefetchPolicy.test.ts enforces it repo-wide. */}
          Try <Link href="/route/JFK-LAX" prefetch={false}>JFK–LAX</Link>, or start from{" "}
          <a href={RECOVERY_HREF}>
            the Explorer
          </a>
          .
        </p>
      </main>
    </div>
  );
}

export default async function NotFound() {
  const requestHeaders = await headers();
  // Fails loudly if proxy.ts did not run, exactly as /explore does for its own header
  // (lib/rawQuery.ts). There is deliberately no fallback: a 404 page that quietly stops
  // naming the offending code, with every gate green, is the precise failure this header was
  // introduced to make impossible.
  return <NotFoundView pathname={rawPathFromHeaders(requestHeaders)} />;
}
