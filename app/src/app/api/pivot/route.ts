import { decode, encode, UrlStateError } from "@/lib/pivot/urlstate";
import { loadAllowlist, runPivot } from "@/lib/db";

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
  const qs = new URL(request.url).search.replace(/^\?/, "");
  try {
    const allowlist = await loadAllowlist();
    const query = decode(qs, allowlist);
    const result = await runPivot(query);
    return Response.json(
      { ...result, url: encode(query) },
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
