import Link from "next/link";
import { headers } from "next/headers";
import { dataAsOf } from "@/lib/db";
import { rawPathFromHeaders } from "@/lib/rawPath";
import { presetSlugFromPath, presetBySlug, PRESETS } from "@/lib/watch";
import { TopBar } from "@/components/TopBar";
import { recoveryHref } from "@/lib/pivot/recovery";

// Same reasoning as page.tsx's own export of this constant: DATA AS OF must never be frozen at
// build time, even on the 404 path. proxy.ts sets `no-store` on this response for the same
// reason one level out, at the CDN (Task 7's scope, not this one's).
export const dynamic = "force-dynamic";

/** Next's `not-found.js` convention: rendered when `notFound()` is thrown from
 * `page.tsx`'s `WatchPresetPage` for an unrecognized preset slug. Matches
 * carrier/[code]/not-found.tsx's structure (wrap > TopBar + main.error-page > h1 +
 * p[role=alert] + a recovery list) so every "this URL didn't work" page in the product reads
 * as one system, and takes its one request-derived value as a prop so the whole page is
 * renderable in a test without mocking a framework seam -- `not-found.js` itself accepts no
 * props, which is why the header exists at all.
 *
 * Unlike the four entity pages, there is no database re-resolution here: `presetBySlug` is a
 * pure lookup against a fixed, four-entry registry, not a warehouse query, so there is no
 * second "reason" to compute -- the slug either matches one of `PRESETS` or it does not, and
 * the list of valid presets IS the useful answer. */
export async function NotFoundView({ pathname }: { pathname: string }) {
  const asOf = await dataAsOf();
  const slug = presetSlugFromPath(pathname);
  return (
    <div className="wrap">
      <TopBar asOf={asOf} />
      <main className="error-page">
        <h1>Preset not found</h1>
        <p role="alert">
          {slug !== null ? (
            <>
              We don&rsquo;t recognize the preset &lsquo;{slug}&rsquo;. There are four:
            </>
          ) : (
            <>We don&rsquo;t recognize this page.</>
          )}
        </p>
        {slug !== null ? (
          <ul>
            {PRESETS.map((s) => {
              const p = presetBySlug(s)!;
              return (
                <li key={s}>
                  <Link href={`/watch/${s}`} prefetch={false}>{p.title}</Link> &mdash; {p.frame}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>
            Try <Link href="/watch/gauge" prefetch={false}>Gauge Watch</Link>, or start from{" "}
            <a href={recoveryHref(asOf)}>
              the Explorer
            </a>
            .
          </p>
        )}
      </main>
    </div>
  );
}

export default async function NotFound() {
  const requestHeaders = await headers();
  // Fails loudly if proxy.ts did not run, exactly as every other entity page's not-found.tsx
  // does for its own header. There is deliberately no fallback: a 404 page that quietly stops
  // naming the offending slug, with every gate green, is the precise failure this header
  // exists to make impossible. NOTE for the proxy: `/watch/:preset` must be in its matcher
  // (Task 7), or this throws.
  return <NotFoundView pathname={rawPathFromHeaders(requestHeaders)} />;
}
