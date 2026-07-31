import { decode, encode, UrlStateError } from "@/lib/pivot/urlstate";
import { loadAllowlist, runPivot } from "@/lib/db";
import { rawQueryFromHeaders } from "@/lib/rawQuery";

const CACHE = "public, s-maxage=2592000, stale-while-revalidate=86400";

/** Decode is total at this boundary: an unknown key, a duplicate non-`f` key, a malformed
 * time range, or an off-allowlist identifier always produces a 400 with a message, never a
 * fallback to defaults. A permalink that quietly renders a different query than it encodes
 * is worse than one that errors -- the screenshot still looks authoritative.
 *
 * `loadAllowlist()` is called here (to decode) and again inside `runPivot()` (to render and
 * execute) -- two catalog reads per request rather than one. Fixing that would mean adding
 * an allowlist-accepting entry point to `db.ts`, which is out of this task's scope (route.ts
 * and its test only); both reads are cheap catalog-view queries against a small number of
 * rows, not the request's dominant cost, and `db.ts`'s "read fresh per request, never
 * memoize" invariant means a shared read would still have to happen twice per *build*
 * anyway if the catalog changed between them. Left as a known, documented duplicate read
 * rather than reached for out-of-scope surgery on db.ts. */
export async function GET(request: Request): Promise<Response> {
  // NOT `new URL(request.url).search`: Next normalizes the request URL by round-tripping the
  // query through form-encoding, which turns this format's structural `:` into `%3A` and
  // collapses `k:a%2Cb,c` into `k%3Aa%2Cb%2Cc` -- a data comma becomes indistinguishable from
  // a separator. Measured against a running production server before this change: EVERY
  // filtered query returned `malformed filter 'origin_state%3AOR'`, including ones with no
  // reserved characters. proxy.ts supplies the untouched string (next.config.ts's
  // skipProxyUrlNormalize is what keeps it untouched); /explore reads the same header.
  try {
    // Inside the try on purpose: rawQueryFromHeaders throws when proxy.ts did not run, and
    // this handler's whole contract is that nothing escapes uncaught (an uncaught throw here
    // would leak a Next stack trace with real filesystem paths). A misconfigured deploy is
    // exactly the catch-all's generic 500.
    const qs = rawQueryFromHeaders(request.headers);
    const allowlist = await loadAllowlist();
    const query = decode(qs, allowlist);
    const result = await runPivot(query);
    // `Response.json()` cannot serialise a Map -- spreading `result` as-is would silently
    // emit `"resolved": {}`, which looks like data but is not. No documented API consumer
    // needs resolution in this milestone, so it is excluded rather than mis-serialised.
    // `_resolved` is deliberately unread: this repo's eslint config has no
    // `no-unused-vars` ignore pattern, so the discard is spelled out with `void` rather
    // than adding a project-wide lint exception for one call site.
    const { resolved: _resolved, ...body } = result;
    void _resolved;
    return Response.json(
      { ...body, url: encode(query) },
      { headers: { "Cache-Control": CACHE } },
    );
  } catch (e) {
    if (e instanceof UrlStateError) {
      return Response.json(
        { error: e.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    // decode() documents UrlStateError as the exception it validates with, but a crafted
    // URL -- or a failure elsewhere in this block, e.g. the catalog read or the DuckDB call
    // inside runPivot() -- can still surface a different error type here. This is
    // deliberately a catch-all, not a rethrow: an uncaught exception would either leak a
    // Next.js stack trace (with real filesystem paths -- QUERIES_DIR, DB_PATH) to the client
    // or, worse, be swallowed into a default 200 by some outer layer. Neither is acceptable
    // for a validation boundary, so log the real error server-side for operators and return
    // a generic, uncached 500 that carries no query-specific or path-specific detail.
    console.error("GET /api/pivot: unexpected error", e);
    return Response.json(
      { error: "internal error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
