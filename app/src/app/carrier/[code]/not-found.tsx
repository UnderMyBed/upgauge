import Link from "next/link";
import { headers } from "next/headers";
import { dataAsOf } from "@/lib/db";
import { rawPathFromHeaders } from "@/lib/rawPath";
import { carrierSlugFromPath, resolveCarrier } from "@/lib/carrier";
import { TopBar } from "@/components/TopBar";
import { recoveryHref } from "@/lib/pivot/recovery";

// Same reasoning as page.tsx's own export of this constant: DATA AS OF must never be frozen
// at build time, even on the 404 path. proxy.ts sets `no-store` on this response for the same
// reason one level out, at the CDN.
export const dynamic = "force-dynamic";

/** The specific reason this slug is not a carrier, in `lib/carrier.ts`'s own words -- which
 * name the offending CODE.
 *
 * Re-running `resolveCarrier` rather than receiving `page.tsx`'s result is forced by the
 * framework: `notFound()` takes no argument and `not-found.js` accepts no props, so there is
 * no channel between the two renders. It is one extra read of a dimension-sized table, on a
 * request that has already decided it has nothing else to do. Identical shape to
 * route/[pair]/not-found.tsx's `reasonFor`. */
async function reasonFor(pathname: string): Promise<string | null> {
  const slug = carrierSlugFromPath(pathname);
  if (slug === null) return null;
  const resolved = await resolveCarrier(slug);
  return resolved.kind === "notFound" ? resolved.reason : null;
}

/** Next's `not-found.js` convention: rendered when `notFound()` is thrown from this route
 * segment. Without it, Next's stock `404 | This page could not be found.` renders instead --
 * no wordmark, no DATA AS OF, and no hint of what `resolveCarrier` already worked out.
 *
 * Structure matches route/[pair]/not-found.tsx and explore/page.tsx's error state so the
 * product's three "this URL didn't work" pages read as one system, and -- like both of them --
 * it takes its one request-derived value as a prop, so the whole page is renderable in a test
 * without mocking a framework seam. */
export async function NotFoundView({ pathname }: { pathname: string }) {
  const [asOf, reason] = await Promise.all([dataAsOf(), reasonFor(pathname)]);
  const slug = carrierSlugFromPath(pathname);
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>Carrier not found</h1>
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
          {/* eslint-plugin-next flags a LITERAL internal href; it never inspects one built
              from an expression (`href.value.type !== 'Literal'` returns early), which is why the
              Explorer links here are plain `<a>`. Carrying a query string is NOT the reason --
              the rule strips the query before matching (`utils/url.js`).
              `prefetch={false}` is load-bearing here, not style -- TopBar.tsx's own note
              has the why in full, and prefetchPolicy.test.ts enforces it repo-wide. */}
          Try <Link href="/carrier/DL" prefetch={false}>DL, Delta Air Lines</Link>, or start from{" "}
          <a href={recoveryHref(asOf)}>
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
  // Fails loudly if proxy.ts did not run. There is deliberately no fallback: a 404 page that
  // quietly stops naming the offending code, with every gate green, is the precise failure
  // this header was introduced to make impossible (lib/rawPath.ts). NOTE FOR THE PROXY: this
  // means `/carrier/:code` MUST be in proxy.ts's matcher, or every carrier 404 is a 500.
  return <NotFoundView pathname={rawPathFromHeaders(requestHeaders)} />;
}
