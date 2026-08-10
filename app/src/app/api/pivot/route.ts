import { decode, encode, UrlStateError } from "@/lib/pivot/urlstate";
import { PivotError } from "@/lib/pivot/types";
import { loadAllowlist, runPivot } from "@/lib/db";
import { rawQueryFromHeaders } from "@/lib/rawQuery";
import { queryVerdict } from "@/lib/canonicalQuery";

const CACHE = "public, s-maxage=2592000, stale-while-revalidate=86400";

/** This boundary is total: an unknown key, a duplicate non-`f` key, a keyless chunk, a malformed
 * time range, or an off-allowlist identifier always produces a 400 with a message, never a
 * fallback to defaults. A permalink that quietly renders a different query than it encodes
 * is worse than one that errors -- the screenshot still looks authoritative.
 *
 * Two guards, in this order, and the split is not arbitrary: `queryVerdict` (below) owns the
 * SHAPE of the query -- which keys, how many of each, and the exact bytes joining them -- because
 * that is what a CDN's cache key is made of; `decode()` owns the MEANING of the values. An
 * unknown or duplicated key is caught by the first now rather than the second, so its 400 names
 * the canonical spelling instead of the offending key; the outcome (400 + `no-store`, never a
 * default) is what has not changed.
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
    // The canonical-key gate, before the catalog read it would otherwise pay for. Whole-branch
    // review, Finding 2: this endpoint was declared exempt from lib/canonicalQuery.ts on the
    // grounds that it already answers 400 + no-store to an unknown key -- true, and irrelevant to
    // the KEYLESS axis. urlstate.ts's splitPairs does `if (!chunk) continue`, so
    // `?<valid permalink>&`, `&&`, `&&&`... all decode cleanly and this handler returned 200
    // under `s-maxage=2592000` for every one of them: an unbounded, attacker-chosen family of
    // 30-day CDN entries, each a full pivot render, on the ONE path the gate called closed and at
    // ten times the TTL of any HTML page it protects. Measured by disabling this gate: a
    // trailing `&`, `&&`, `&&&` and a LEADING `&` all returned 200 under
    // `public, s-maxage=2592000, stale-while-revalidate=86400`. Key ORDER is a separate axis and
    // this does NOT close it -- see hosting.md § What this does not close.
    //
    // `queryVerdict`, not `canonicalize`: the second is the proxy's action (an exempt row is
    // always `clean` there, so /api/pivot is never 307ed and /search is never redirected at all),
    // the first is the rules. The rules are not restated here -- a second copy of the key table is
    // exactly what that module exists to prevent.
    //
    // 400, never 307, and that is a design ruling rather than a convenience: a JSON endpoint that
    // redirects makes every XHR client's error handling depend on `redirect: "follow"`, and a
    // named error is a better answer than a silent hop. It is the same 400 + no-store this
    // handler already gives an unknown key -- BEHAVIOUR CHANGE, deliberate and signed off:
    // `/api/pivot?<valid>&&` went from 200 to 400.
    //
    // Pathname off `request.url` rather than RAW_PATH_HEADER: only the QUERY is normalized by
    // Next (the comment above), the path is not, and reading the header would turn every unit
    // test that builds a bare `Request` into a 500. An unmatched pathname is `clean` by
    // construction (lib/canonicalQuery.ts rule 1), so a future rewrite that changed it fails open,
    // never closed.
    const verdict = queryVerdict(new URL(request.url).pathname, qs);
    if (verdict.kind !== "clean") {
      const detail =
        verdict.kind === "reject"
          ? verdict.reason
          : `the canonical spelling of this query is '${verdict.location}'`;
      return Response.json(
        { error: `non-canonical query: ${detail}` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const allowlist = await loadAllowlist();
    const query = decode(qs, allowlist);
    const result = await runPivot(query);
    // Named fields, not `...result`: `Response.json()` can't serialise a `Map`, so a bare
    // spread would silently emit `"resolved": {}` -- data-shaped, but not data. Spelling out
    // what's included, rather than destructuring `resolved` back out, also means a FUTURE
    // field added to PivotResult defaults to excluded until someone deliberately adds it
    // here -- opt-in, not opt-out-and-hope-nobody-forgets.
    const body = {
      columns: result.columns,
      rows: result.rows,
      quarantinedRowsOnPage: result.quarantinedRowsOnPage,
    };
    return Response.json(
      { ...body, url: encode(query) },
      { headers: { "Cache-Control": CACHE } },
    );
  } catch (e) {
    // UrlStateError (decode()'s own documented exception) AND PivotError (thrown by
    // renderPivot() when runPivot() re-derives the executable SQL, e.g. a composite filter
    // value shaped like an id pair but not numeric -- `f=route:JFK-LAX`) are both "this
    // request could never produce valid SQL" -- a client mistake, not a server fault.
    // Important 4, final whole-branch review: PivotError does not extend UrlStateError, so
    // before this it fell through to the catch-all below and came back as an opaque
    // `{"error":"internal error"}` 500 instead of a named 400 -- verified against a running
    // build before this fix.
    if (e instanceof UrlStateError || e instanceof PivotError) {
      return Response.json(
        { error: e.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    // decode() documents UrlStateError (and, as of the above, PivotError) as the exceptions
    // it validates with, but a crafted URL -- or a failure elsewhere in this block, e.g. the
    // catalog read or the DuckDB call inside runPivot() -- can still surface a different
    // error type here. This is deliberately a catch-all, not a rethrow: an uncaught
    // exception would either leak a Next.js stack trace (with real filesystem paths --
    // QUERIES_DIR, DB_PATH) to the client or, worse, be swallowed into a default 200 by some
    // outer layer. Neither is acceptable for a validation boundary, so log the real error
    // server-side for operators and return a generic, uncached 500 that carries no
    // query-specific or path-specific detail.
    console.error("GET /api/pivot: unexpected error", e);
    return Response.json(
      { error: "internal error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
