import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { RAW_QUERY_HEADER } from "@/lib/rawQuery";

// `proxy`, not `middleware`: Next 16 deprecated and renamed the convention
// (node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md, "middleware to
// proxy"). This also settles CLAUDE.md's portability rule in our favour -- the docs are
// explicit that "the `edge` runtime is NOT supported in `proxy`. The `proxy` runtime is
// `nodejs`, and it cannot be configured", so this cannot drag in a provider-specific edge
// runtime, and the platform-support table lists a plain Node.js server as supported.
//
// Why this exists at all: `/explore` needs the RAW, still-encoded query string, and a page
// only ever receives `searchParams` already percent-decoded. See lib/rawQuery.ts for the
// full reasoning. `NextResponse.next({ request: { headers } })` is the documented way to
// make a header visible to the app upstream -- NOT `NextResponse.next({ headers })`, which
// would expose it to clients instead.
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  // `new URL(request.url).search`, NOT `request.nextUrl.search`: nextUrl re-serializes its
  // searchParams, which form-encodes the query and destroys the escapes this header exists to
  // preserve. Verified against a running production server at each step.
  //
  // `request.url` is only raw here because next.config.ts sets `skipProxyUrlNormalize`.
  // WITHOUT that flag Next normalizes the query the same way -- `k:a%2Cb,c` becomes
  // `k%3Aa%2Cb%2Cc`, collapsing a data comma into a separator -- and every filtered query on
  // BOTH entry points failed with `malformed filter 'origin_state%3AOR'`, reserved characters
  // or not. The flag and this file are one mechanism; neither works alone.
  //
  // No unit test can catch a regression here: these tests never construct a NextRequest and
  // never cross Next's URL normalization. Only a built-and-served smoke check can.
  headers.set(RAW_QUERY_HEADER, new URL(request.url).search.replace(/^\?/, ""));
  const response = NextResponse.next({ request: { headers } });

  // CLAUDE.md: "Every response gets Cache-Control: public, s-maxage=2592000,
  // stale-while-revalidate=86400" -- the caching IS the cost control, not the hosting tier
  // (docs/architecture/hosting.md). /api/pivot sets its own on the JSON response, including
  // `no-store` on errors, so it must not be overridden here. /explore had none: it exports
  // `dynamic = "force-dynamic"`, so Next emits its own no-store for the HTML and every shared
  // permalink -- the growth mechanic, and the cold-start path the always-on box is sized
  // around -- hit DuckDB with the CDN doing nothing. Setting it on the proxy response is what
  // makes it stick regardless of the route segment config.
  if (new URL(request.url).pathname === "/explore") {
    response.headers.set("Cache-Control", CACHE);
  }
  return response;
}

const CACHE = "public, s-maxage=2592000, stale-while-revalidate=86400";

// Without a matcher, proxy runs on every request including _next/static and public assets.
// Both entry points need the header: /api/pivot's own `new URL(request.url).search` is
// normalized too -- measured, every filtered API query returned `malformed filter
// 'origin_state%3AOR'` before this. They now read the identical raw string from one source.
export const config = {
  matcher: ["/explore", "/api/pivot"],
};
