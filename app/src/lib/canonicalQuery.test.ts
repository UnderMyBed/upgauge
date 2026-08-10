import { describe, expect, it } from "vitest";
import { canonicalize, queryVerdict, QUERY_ROWS } from "@/lib/canonicalQuery";
import { config } from "@/proxy";

// The permalink fixture from app/smoke.sh:388 -- every reserved character this format has to
// survive, in one filter value. Used here because the whole point of comparing keys TEXTUALLY
// is that a percent-encoded structural comma or ampersand must come out the other side intact.
const RESERVED =
  "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12" +
  "&f=origin_state:14%2C771,13%26487,9%255,12%3A34,a%3Db,a%2Bb,a%20b&n=100&g=op";

describe("canonicalize", () => {
  it("leaves a query-less request alone", () => {
    expect(canonicalize("/watch", "")).toEqual({ kind: "clean" });
  });

  it("leaves a legitimate key alone", () => {
    expect(canonicalize("/airport/ORD", "y=2019")).toEqual({ kind: "clean" });
  });

  it("strips a leading '?' rather than throwing on it", () => {
    // CRITICAL, whole-branch review: this used to assert a throw, on the argument that only a
    // wiring bug could hand this function a `?`-prefixed rawQuery. proxy.ts's
    // `.search.replace(/^\?/, "")` is NON-GLOBAL, so `GET /airport/ORD??y=2019` (`search` ===
    // "??y=2019") strips one `?` of two and delivers exactly this input -- and the throw escaped
    // proxy(), which has no try/catch around it, as a 500 on every one of the twelve matcher
    // paths. Measured on a served build at d109845: `/watch?x=1` 307, `/watch??x=1` 500. A
    // leading `?` is a non-canonical spelling, and this module already has an answer for those.
    expect(canonicalize("/airport/ORD", "?y=2019")).toEqual({
      kind: "strip",
      location: "/airport/ORD?y=2019",
    });
  });

  it("the identical query WITHOUT the '?' is clean -- the verdict is about the spelling, not the query", () => {
    // Paired with the test above, and only now discriminating: while that one asserted a throw,
    // this was a duplicate of "leaves a legitimate key alone" fourteen lines up and could not
    // fail for any reason that one would not also fail for. Against the strip above it is the
    // control -- same path, same key, same value, only the leading `?` differs -- so a mutant
    // that stripped `y` outright, or one that redirected every query, moves exactly one of them.
    expect(canonicalize("/airport/ORD", "y=2019")).toEqual({ kind: "clean" });
  });

  it("collapses a whole run of leading '?'s to the same canonical URL", () => {
    // `/airport/ORD???y=2019` -- `search` "???y=2019", one `?` stripped by proxy.ts, "??y=2019"
    // arrives here. Stripping ONE `?` per pass would send this to `/airport/ORD` (key "?y" is in
    // no row's `keys`) while the doubled form goes to `/airport/ORD?y=2019`: the same typo
    // repeated would land on two different URLs, which is two cache entries again.
    expect(canonicalize("/airport/ORD", "??y=2019")).toEqual({
      kind: "strip",
      location: "/airport/ORD?y=2019",
    });
  });

  it("strips a leading '?' on a path that reads no keys at all", () => {
    // `GET /watch??x=1`, the exact URL that 500ed at d109845.
    expect(canonicalize("/watch", "?x=1")).toEqual({ kind: "strip", location: "/watch" });
  });

  it("strips a bare '??' with no key behind it", () => {
    // `GET /watch???` -- `search` "???", one stripped, "??" arrives. No chunk, no key, and the
    // canonical form is the bare path.
    expect(canonicalize("/watch", "??")).toEqual({ kind: "strip", location: "/watch" });
  });

  it("leaves a full permalink alone, reserved characters and all", () => {
    expect(canonicalize("/explore", RESERVED)).toEqual({ kind: "clean" });
  });

  it("leaves repeated f alone, because encode() emits one f= per filter", () => {
    // urlstate.ts:113-114 pushes one `f=` per filter, and decode() `continue`s past its own
    // duplicate check for `f`. A blanket duplicate rule would make every multi-filter permalink
    // -- the product's core shareable artifact -- uncacheable.
    const two = "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:OR&f=dest_state:WA&n=25&g=op";
    expect(canonicalize("/explore", two)).toEqual({ kind: "clean" });
  });

  it("strips an unknown key on a path that reads none", () => {
    expect(canonicalize("/watch", "x=1")).toEqual({ kind: "strip", location: "/watch" });
  });

  it("keeps the legitimate key while stripping the junk beside it", () => {
    expect(canonicalize("/airport/ORD", "y=2019&junk=1")).toEqual({
      kind: "strip",
      location: "/airport/ORD?y=2019",
    });
  });

  it("strips a valueless key", () => {
    // A chunk with no `=` is a key with an empty value, exactly as decode()'s splitPairs
    // treats it.
    expect(canonicalize("/watch", "x")).toEqual({ kind: "strip", location: "/watch" });
  });

  it("strips a keyless query, which no key-presence test can see", () => {
    // The reason rule 4 is byte-equality and not "were any unknown keys present": `?&`, `?&&`,
    // `?&&&...` carry no key to reject, yet each is a distinct CDN cache key on a cacheable path.
    expect(canonicalize("/watch", "&&")).toEqual({ kind: "strip", location: "/watch" });
  });

  it("strips a trailing ampersand", () => {
    expect(canonicalize("/airport/ORD", "y=2019&")).toEqual({
      kind: "strip",
      location: "/airport/ORD?y=2019",
    });
  });

  it("preserves a filter's percent-escapes byte-for-byte when stripping", () => {
    const result = canonicalize("/explore", `${RESERVED}&utm_source=twitter`);
    expect(result).toEqual({ kind: "strip", location: `/explore?${RESERVED}` });
  });

  it("preserves the pathname verbatim, escapes included", () => {
    // proxy.ts reads the pathname off `new URL(request.url)`, which does NOT decode it, so a
    // slug carrying an escape must survive the redirect exactly as it arrived.
    expect(canonicalize("/aircraft/B737%2D8", "x=1")).toEqual({
      kind: "strip",
      location: "/aircraft/B737%2D8",
    });
  });

  it("rejects a duplicated non-repeatable key instead of picking one", () => {
    // `?y=2019&y=2020` is cacheable at 4aa8087 because parseYear reads the FIRST y
    // (proxy.ts:208), which makes the second an unbounded cache-key axis. There is no canonical
    // form to redirect to: choosing one occurrence renders a different query than the URL
    // encodes, which is decode()'s own stated reason for erroring on duplicates.
    const result = canonicalize("/airport/ORD", "y=2019&y=2020");
    expect(result.kind).toBe("reject");
  });

  it("rejects a duplicate even when an unknown key also needs stripping", () => {
    // Reject outranks strip regardless of position: a strip would silently resolve the duplicate.
    const result = canonicalize("/airport/ORD", "junk=1&y=2019&y=2020");
    expect(result.kind).toBe("reject");
  });

  it("leaves /api/pivot's query alone: the handler owns its own answer", () => {
    // Measured at 4aa8087: /api/pivot?...&bogus=1 already returns 400 + no-store, and a 307 on a
    // JSON endpoint would be a worse answer than the 400 it gives.
    expect(canonicalize("/api/pivot", "v=1&bogus=1")).toEqual({ kind: "clean" });
  });

  it("leaves /search alone: no-store unconditionally, so no cache entry is reachable", () => {
    expect(canonicalize("/search", "q=DL&x=1")).toEqual({ kind: "clean" });
  });

  it("leaves an off-matcher path's query alone rather than stripping it", () => {
    // The safe default. A route added to the matcher without a row here loses the protection,
    // which the agreement test below makes unreachable -- but it must never lose its query.
    expect(canonicalize("/api/health", "x=1")).toEqual({ kind: "clean" });
  });

  // Totality, asserted rather than claimed. This module runs on the proxy path, where an uncaught
  // throw is a 500 on a request that was only ever going to be a redirect -- and it has thrown
  // for real once, on the first entry below, taking every one of the twelve matcher paths with it
  // because proxy() has no try/catch around the call. `%zz` and a lone `%` are the malformed
  // escapes `entitySlugFromPath` exists to survive; the rest are the shapes a hostile client is
  // free to send.
  it.each([
    ["/watch", "?x=1"],
    ["/watch", "??"],
    ["/aircraft/%zz", "x=1"],
    ["/carrier/%", "?%"],
    ["/route/%E0%A4%A", "y=%zz"],
    ["/airport/ORD", "=1"],
    ["/airport/ORD", "&=&=&"],
    ["/explore", "?".repeat(64)],
    ["/explore", "f=".repeat(500)],
    ["//evil.com", "x=1"],
    ["", ""],
  ])("never throws on (%s, %s)", (pathname, rawQuery) => {
    expect(() => canonicalize(pathname, rawQuery)).not.toThrow();
    expect(() => queryVerdict(pathname, rawQuery)).not.toThrow();
  });

  it("claims no row for a protocol-relative pathname, so no Location can leave this host", () => {
    // proxy.ts builds `new URL(canonical.location, request.nextUrl.origin)`, and
    // `new URL("//evil.com", "http://h")` is `http://evil.com/` -- an open redirect IF any row
    // ever claimed a `//`-leading pathname. None can: every `matches` predicate is either an
    // exact `p === "/literal"` or an `entitySlugFromPath` prefix test requiring `/<prefix>/` at
    // position 0. This pins that as an asserted property rather than a fact someone re-derives by
    // reading twelve predicates. (Next answers `GET //evil.com` with its own 308 before proxy()
    // runs -- app/smoke.sh asserts that second, independent reason on a served build.)
    expect(canonicalize("//evil.com", "x=1")).toEqual({ kind: "clean" });
    expect(canonicalize("//evil.com/watch", "x=1")).toEqual({ kind: "clean" });
  });

  // Every `strip` fixture above, re-fed its own answer. The proxy 307s to `location`, so a
  // location this function would strip AGAIN is a redirect loop -- not a cosmetic defect, and
  // asserted nowhere before this. Rule 0 (drop the leading `?` run) is what made it load-bearing:
  // a one-`?`-per-pass implementation sends `??y=2019` to `/airport/ORD?y=2019`, which is clean,
  // but a `?`-preserving one would emit a location that strips again.
  it.each([
    ["/watch", "x=1"],
    ["/watch", "x"],
    ["/watch", "&&"],
    ["/watch", "?x=1"],
    ["/watch", "??"],
    ["/airport/ORD", "y=2019&junk=1"],
    ["/airport/ORD", "y=2019&"],
    ["/airport/ORD", "?y=2019"],
    ["/airport/ORD", "??y=2019"],
    ["/aircraft/B737%2D8", "x=1"],
    ["/explore", `${RESERVED}&utm_source=twitter`],
  ])("the location it redirects %s?%s to is itself clean", (pathname, rawQuery) => {
    const first = canonicalize(pathname, rawQuery);
    expect(first.kind).toBe("strip");
    const location = (first as { location: string }).location;
    // Split exactly as a request does: the pathname carries no `?` (proxy.ts reads it off
    // `new URL(request.url).pathname`), so the first `?` is the query delimiter.
    const cut = location.indexOf("?");
    const [nextPath, nextQuery] =
      cut === -1 ? [location, ""] : [location.slice(0, cut), location.slice(cut + 1)];
    expect(canonicalize(nextPath, nextQuery)).toEqual({ kind: "clean" });
  });
});

// The rules bind every row; only the ACTION is the caller's. `canonicalize` (the proxy's entry
// point) answers `clean` for an exempt row so the proxy never redirects it; `queryVerdict` -- what
// app/api/pivot/route.ts calls -- applies the rules to it. Before this split, `exempt` meant "the
// rules do not exist for this path", and `/api/pivot?<valid permalink>&&` was a 200 under
// `s-maxage=2592000`: `splitPairs` skips an empty chunk, so decode() never saw anything wrong.
describe("queryVerdict vs canonicalize on an exempt row", () => {
  const VALID = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&n=5&g=op";

  it("finds /api/pivot's trailing '&' non-canonical, where canonicalize declines to act", () => {
    expect(queryVerdict("/api/pivot", `${VALID}&`)).toEqual({
      kind: "strip",
      location: `/api/pivot?${VALID}`,
    });
    expect(canonicalize("/api/pivot", `${VALID}&`)).toEqual({ kind: "clean" });
  });

  it("leaves a valid /api/pivot permalink clean under BOTH", () => {
    // The control the pair needs: a verdict function that called everything non-canonical would
    // pass the test above and 400 every real API request.
    expect(queryVerdict("/api/pivot", VALID)).toEqual({ kind: "clean" });
    expect(canonicalize("/api/pivot", VALID)).toEqual({ kind: "clean" });
  });

  it("keeps /api/pivot's repeated f=, exactly as /explore does", () => {
    // /api/pivot's row read `keys: NO_KEYS` while nothing evaluated it. Left that way, the
    // handler's new gate would 400 every filtered query in the product.
    const two = "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&f=origin_state:OR&f=dest_state:WA&n=25&g=op";
    expect(queryVerdict("/api/pivot", two)).toEqual({ kind: "clean" });
  });

  it("rejects a duplicated non-repeatable key on /api/pivot rather than picking one", () => {
    expect(queryVerdict("/api/pivot", `${VALID}&n=9`).kind).toBe("reject");
  });

  it("finds /search's unknown key non-canonical, and canonicalize still refuses to redirect it", () => {
    // /search's own behaviour must not change in any way: it is `no-store` unconditionally and
    // must never redirect. Nothing consumes this verdict today; the row states the truth anyway.
    expect(queryVerdict("/search", "q=DL&x=1")).toEqual({ kind: "strip", location: "/search?q=DL" });
    expect(canonicalize("/search", "q=DL&x=1")).toEqual({ kind: "clean" });
  });
});

describe("QUERY_ROWS", () => {
  it("has exactly one row per proxy matcher entry", () => {
    // The third list that must agree with config.matcher -- and with THAT list only. This comment
    // used to name ENTITY_ROUTES as well, which the assertion below does not check and could not:
    // QUERY_ROWS (12 rows, one per matcher entry) is a strict superset of ENTITY_ROUTES (3), so
    // row-for-row agreement with the latter is not a property that holds. docs/architecture/
    // hosting.md § "One canonical key set per cacheable URL" states the same thing. A row missing
    // here ships a path with no query protection; a matcher entry missing ships a page with no
    // Cache-Control at all and turns each of its 404s into a 500.
    expect(QUERY_ROWS.map((r) => r.matcher).sort()).toEqual([...config.matcher].sort());
  });

  it.each([
    ["/", "/"],
    ["/explore", "/explore"],
    ["/airport/:code", "/airport/ORD"],
    ["/route/:pair", "/route/JFK-LAX"],
    ["/carrier/:code", "/carrier/DL"],
    ["/aircraft/:name", "/aircraft/B737-8"],
    ["/watch", "/watch"],
    ["/watch/:preset", "/watch/gauge"],
    ["/sitemap.xml", "/sitemap.xml"],
    ["/robots.txt", "/robots.txt"],
    ["/api/pivot", "/api/pivot"],
    ["/search", "/search"],
  ])("row %s is the first to claim %s", (matcher, pathname) => {
    // Agreement on names is not agreement on behaviour: a row could carry the right `matcher`
    // string and a predicate that never fires, or fire on a path an earlier row should own.
    expect(QUERY_ROWS.find((r) => r.matches(pathname))?.matcher).toBe(matcher);
  });

  it("never declares a repeatable key it does not also allow", () => {
    for (const row of QUERY_ROWS) {
      for (const key of row.repeatable) {
        expect(row.keys.has(key)).toBe(true);
      }
    }
  });
});
