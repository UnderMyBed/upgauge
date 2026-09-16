import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, isOurs, queryVerdict, QUERY_ROWS } from "@/lib/canonicalQuery";

const APP_DIR = path.resolve(__dirname, "../app");

/** Next's route and metadata file conventions this walker does not model -- from the
 * file-conventions docs and `next/dist/lib/metadata/is-metadata-route.js`, which also accepts a
 * one-digit variant (`icon1.png`, `opengraph-image2.tsx`). Each serves a URL no pattern below
 * produces, so a match throws rather than leaving a route this agreement cannot see. */
const UNMODELED_FILE = [
  /^(?:icon|apple-icon|twitter-image)\d?\.(?:ico|jpe?g|png|svg|gif|[jt]sx?|alt\.txt)$/,
  /^opengraph-image(?:\d?\.(?:jpe?g|png|gif|alt\.txt)|\d\.[jt]sx?)$/,
  /^manifest\.(?:json|webmanifest|[jt]sx?)$/,
  /^(?:sitemap\.xml|robots\.txt)$/,
];

/** An export that moves a code metadata route off the URL its file name gives: `generateSitemaps`
 * serves `/sitemap/<id>.xml`, and `generateImageMetadata` puts an `/<id>` segment under a card. */
const URL_MOVING_EXPORT =
  /^\s*export\s+(?:async\s+)?(?:function|const|let)\s+generate(?:Sitemaps|ImageMetadata)\b/m;

/** The last URL segment each modeled code metadata file serves. */
const METADATA_URL: Record<string, string> = {
  "opengraph-image": "opengraph-image",
  sitemap: "sitemap.xml",
  robots: "robots.txt",
};

/** Every URL pattern a file under src/app serves: `page`/`route`, `opengraph-image`, `sitemap` and
 * `robots` in any of Next's four code extensions (`[jt]sx?`), plus `favicon.ico`. THROWS, naming
 * the file, on every other route or metadata file convention (`UNMODELED_FILE`), on a code
 * metadata file carrying a URL-moving export, and on a private, route-group, parallel, catch-all
 * or optional catch-all folder -- so a new convention is a red test rather than a route this
 * agreement silently cannot see. Any other file (`layout`, `not-found`, tests, helpers) serves no
 * URL of its own. */
function servedRoutePatterns(dir: string = APP_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.relative(APP_DIR, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      if (/^[(@_]|^\[\[?\.\.\./.test(entry.name)) {
        throw new Error(`servedRoutePatterns does not model the folder convention '${file}'`);
      }
      const segment = entry.name.replace(/^\[(.+)\]$/, ":$1");
      out.push(...servedRoutePatterns(path.join(dir, entry.name), `${prefix}/${segment}`));
      continue;
    }
    if (UNMODELED_FILE.some((re) => re.test(entry.name))) {
      throw new Error(`servedRoutePatterns does not model the file convention '${file}'`);
    }
    const metadata = /^(opengraph-image|sitemap|robots)\.[jt]sx?$/.exec(entry.name)?.[1];
    if (metadata !== undefined) {
      if (URL_MOVING_EXPORT.test(readFileSync(path.join(dir, entry.name), "utf8"))) {
        throw new Error(`servedRoutePatterns does not model the URL-moving export in '${file}'`);
      }
      out.push(`${prefix}/${METADATA_URL[metadata]}`);
    } else if (/^(page|route)\.[jt]sx?$/.test(entry.name)) {
      out.push(prefix === "" ? "/" : prefix);
    } else if (entry.name === "favicon.ico") {
      out.push(`${prefix}/favicon.ico`);
    }
  }
  return out;
}

/** Routes this app serves that the proxy deliberately treats as not its own. PINNED: growing
 * this is how a page loses its cache header and its canonical-query gate while the diff looks
 * like tidying, so each name carries its reason and the set is asserted exactly. */
const NOT_OURS: Record<string, string> = {
  "/api/health":
    "must never be cached; the handler sets its own no-store, it takes no query and has no not-found path",
  "/favicon.ico": "a static metadata file; nothing to canonicalize or cache-decide",
};

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
    // proxy(), which has no try/catch around it, as a 500 on every gated path. Measured on a
    // served build at d109845: `/watch?x=1` 307, `/watch??x=1` 500. A leading `?` is a
    // non-canonical spelling, and this module already has an answer for those.
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

  // #106. `/carrier/:code` and `/aircraft/:name` stopped being `NO_KEYS` rows: each reads ONE
  // map-filter key. This file decides only the KEY set -- whether `B737-8` names anything is a
  // fact about the warehouse, which is why `lib/map/mapFilter.ts` owns the VALUE and this module
  // still inspects none.
  it.each([
    ["/carrier/DL", "type=B737-8"],
    ["/aircraft/B737-8", "carrier=DL"],
    // The value is never inspected here, so a value naming nothing is still a canonical KEY set.
    // It is refused by `mapFilter.ts` and answered `no-store` by proxy.ts -- not redirected.
    ["/carrier/DL", "type=NOPE-1"],
    ["/aircraft/B737-8", "carrier=%44L"],
  ])("leaves %s's own filter key alone: %s", (pathname, rawQuery) => {
    expect(canonicalize(pathname, rawQuery)).toEqual({ kind: "clean" });
  });

  it.each([
    ["/carrier/DL", "carrier=DL", "/carrier/DL"],
    ["/aircraft/B737-8", "type=B737-8", "/aircraft/B737-8"],
  ])("strips %s's SIBLING's key, which it does not read: %s", (pathname, rawQuery, location) => {
    // The two keys are not interchangeable and each row declares only its own. A shared key set
    // across both rows would make `/carrier/DL?carrier=DL` a cacheable 200 for a key the page
    // never reads -- one more distinct CDN entry per spelling.
    expect(canonicalize(pathname, rawQuery)).toEqual({ kind: "strip", location });
  });

  it.each([
    ["/carrier/DL", "type=B737-8&type=A320-1-2"],
    ["/aircraft/B737-8", "carrier=DL&carrier=AA"],
  ])("rejects a duplicated filter key on %s rather than choosing one", (pathname, rawQuery) => {
    // Neither key is repeatable: two types is a DIFFERENT map, not a second spelling of one, so
    // there is no canonical form to redirect to -- choosing an occurrence renders a query the
    // URL does not encode. `no-store`, no redirect, exactly as a duplicated `d` on /explore.
    const verdict = canonicalize(pathname, rawQuery);
    expect(verdict.kind).toBe("reject");
  });

  it("keeps the filter while stripping a tracking param beside it", () => {
    // The rejoin is byte-for-byte in the ORIGINAL order, so the surviving key keeps its exact
    // spelling -- this is what makes the 307 target itself clean rather than a second redirect.
    expect(canonicalize("/carrier/DL", "utm_source=x&type=B737-8")).toEqual({
      kind: "strip",
      location: "/carrier/DL?type=B737-8",
    });
  });

  it("sends a doubled-'?' filter to the same URL its single-'?' spelling reaches", () => {
    // `GET /carrier/DL??type=x`: proxy.ts's non-global `.replace(/^\?/, "")` strips one `?` of
    // two and hands this module `?type=x`. Rule 0 drops the run, and the strip lands on the URL
    // the single-`?` form is already clean at. Uncovered by any check in this repo before #106
    // -- `app/smoke.sh`'s section-15 loop now carries this row against a served build.
    expect(canonicalize("/carrier/DL", "?type=B737-8")).toEqual({
      kind: "strip",
      location: "/carrier/DL?type=B737-8",
    });
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

  // #8, and the landmine this row exists for. Next appends a KEYLESS content hash to every
  // file-convention `og:image` URL -- measured on the served production build:
  // `<meta property="og:image" content=".../route/JFK-LAX/opengraph-image?083d4242d9090de4"/>`.
  // A keyless chunk is exactly the axis rule 4 was written for (`?&`, `?&&`), so with
  // `keys: NO_KEYS` alone the proxy would 307 the site's OWN card URL on all four entity pages
  // and every share would cost two origin hits with the redirect itself `no-store`.
  //
  // The SHAPE is pinned, never the literal: the hash is `[contenthash]` over the compiled
  // `opengraph-image.tsx`, so it changes on any edit to that file and a pinned literal would be
  // red on a commit that broke nothing.
  it.each([
    ["/route/JFK-LAX/opengraph-image"],
    ["/airport/ORD/opengraph-image"],
    ["/carrier/DL/opengraph-image"],
    ["/aircraft/B737-8/opengraph-image"],
  ])("leaves the framework's own cache-buster on %s alone", (pathname) => {
    expect(canonicalize(pathname, "083d4242d9090de4")).toEqual({ kind: "clean" });
  });

  it("leaves a bare OG path alone too", () => {
    // The control for the pair above: a row that called every OG query canonical would satisfy
    // those four, and this one is what a row that redirected every OG request would fail.
    expect(canonicalize("/route/JFK-LAX/opengraph-image", "")).toEqual({ kind: "clean" });
  });

  it("strips an ordinary key off an OG path, cache-buster or not", () => {
    // The card takes no query of its own. `?y=2019` is the discriminating case for `/airport`:
    // its PAGE reads `y`, its CARD does not, so a row that reused AIRPORT_KEYS here would leave
    // `?y=1..N` an unbounded family of long-cached card renders.
    expect(canonicalize("/airport/ORD/opengraph-image", "y=2019")).toEqual({
      kind: "strip",
      location: "/airport/ORD/opengraph-image",
    });
    expect(canonicalize("/route/JFK-LAX/opengraph-image", "083d4242d9090de4&utm_source=x")).toEqual(
      { kind: "strip", location: "/route/JFK-LAX/opengraph-image?083d4242d9090de4" },
    );
  });

  it.each([
    ["too short", "083d4242d9090de"],
    ["too long", "083d4242d9090de44"],
    ["upper-case hex", "083D4242D9090DE4"],
    ["not hex", "083d4242d9090dez"],
    ["a keyed chunk of the same bytes", "x=083d4242d9090de4"],
  ])("strips a keyless chunk that is %s, rather than admitting any keyless chunk", (_l, q) => {
    // The bound, not just the admission. A rule that kept EVERY keyless chunk on an OG path
    // would pass every test above and re-open the unbounded cache-key family on 23,908 URLs.
    const result = canonicalize("/route/JFK-LAX/opengraph-image", q);
    expect(result).toEqual({ kind: "strip", location: "/route/JFK-LAX/opengraph-image" });
  });

  it("rejects two cache-busters rather than picking one", () => {
    // Bounds the slot to ONE. Admitting a second would make `?<hash>&<hash>&...` a cache-key
    // family multiplied by itself, which is worse than the single-chunk residual, not equal to
    // it. Same answer shape as a duplicated key: there is no canonical form to redirect to.
    expect(
      canonicalize("/route/JFK-LAX/opengraph-image", "083d4242d9090de4&5392b506f6d84764").kind,
    ).toBe("reject");
    expect(
      canonicalize("/route/JFK-LAX/opengraph-image", "083d4242d9090de4&083d4242d9090de4").kind,
    ).toBe("reject");
  });

  it("does not admit a cache-buster on a row that never declared one", () => {
    // The `cacheBuster` field is per-row, not a global loosening of rule 4. A 16-hex keyless
    // chunk on an entity PAGE is just junk.
    expect(canonicalize("/route/JFK-LAX", "083d4242d9090de4")).toEqual({
      kind: "strip",
      location: "/route/JFK-LAX",
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

  it("leaves an undeclared path's query alone rather than stripping it", () => {
    // The safe default. A path no row declares is not one of ours, so its query is not this
    // module's to rewrite -- and a route FILE with no row fails the route-tree agreement below.
    expect(canonicalize("/api/health", "x=1")).toEqual({ kind: "clean" });
  });

  // Totality, asserted rather than claimed. This module runs on the proxy path, where an uncaught
  // throw is a 500 on a request that was only ever going to be a redirect -- and it has thrown
  // for real once, on the first entry below, taking every gated path with it
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
    // #8. The OG rows add a regex to the walk and a new reader to the predicates, on the same
    // no-try/catch path -- so the same corpus, aimed at them. The doubled `?` is the shape that
    // 500ed every gated path at d109845.
    ["/route/JFK-LAX/opengraph-image", "?083d4242d9090de4"],
    ["/route/%zz/opengraph-image", "083d4242d9090de4"],
    ["/aircraft/%/opengraph-image", "?%"],
    ["/opengraph-image", "x=1"],
    ["/airport//opengraph-image", "??"],
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
    // reading every predicate. (Next answers `GET //evil.com` with its own 308 before proxy()
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
    // #8. The OG rows are the first to KEEP a chunk that carries no key, so a location built from
    // them is the first that could fail to reproduce itself under a second walk.
    ["/route/JFK-LAX/opengraph-image", "083d4242d9090de4&utm_source=x"],
    ["/route/JFK-LAX/opengraph-image", "?083d4242d9090de4"],
    ["/airport/ORD/opengraph-image", "y=2019"],
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
  it("declares every route the app serves, except the pinned NOT_OURS set", () => {
    expect(Object.keys(NOT_OURS).sort()).toEqual(["/api/health", "/favicon.ico"]);
    const served = servedRoutePatterns();
    expect(served.length).toBeGreaterThan(Object.keys(NOT_OURS).length); // anti-vacuity
    for (const route of Object.keys(NOT_OURS)) expect(served).toContain(route);
    expect(QUERY_ROWS.map((r) => r.route).sort()).toEqual(
      served.filter((route) => !(route in NOT_OURS)).sort(),
    );
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
    // #8. The four cards, which an entity row claims only under TWO defects together: the OG rows
    // moved BELOW the entity rows in QUERY_ROWS, AND an entity slug reader accepting a `/`, so
    // that `routeSlugFromPath("/route/JFK-LAX/opengraph-image")` is `"JFK-LAX/opengraph-image"`
    // rather than null. Then `/route/:pair` claims every card, answers it with NO_KEYS and no
    // cache-buster, and 307s the URL this site emits in its own `og:image` tag. MUTANTS RUN: the
    // reorder alone and the reader regression alone each leave these cases green; both together
    // turn them red. The reader regression alone is caught by "no OG row claims %s" below.
    ["/route/:pair/opengraph-image", "/route/JFK-LAX/opengraph-image"],
    ["/airport/:code/opengraph-image", "/airport/ORD/opengraph-image"],
    ["/carrier/:code/opengraph-image", "/carrier/DL/opengraph-image"],
    ["/aircraft/:name/opengraph-image", "/aircraft/B737-8/opengraph-image"],
  ])("row %s is the first to claim %s", (route, pathname) => {
    // Agreement on names is not agreement on behaviour: a row could carry the right `route`
    // string and a predicate that never fires, or fire on a path an earlier row should own.
    expect(QUERY_ROWS.find((r) => r.matches(pathname))?.route).toBe(route);
  });

  it.each([
    ["more than one dynamic segment", "/route/JFK-LAX/extra/opengraph-image"],
    ["an empty slug", "/route//opengraph-image"],
    ["the bare suffix", "/opengraph-image"],
    ["the suffix in the middle", "/route/JFK-LAX/opengraph-image/x"],
  ])("no OG row claims %s", (_label, pathname) => {
    // A card is `/<entity>/[param]/opengraph-image` -- exactly ONE dynamic segment. A row claiming
    // more would declare a route the app does not serve, and `proxy.ts`'s OG branch shares this
    // same reader, so it would resolve a slug like `"JFK-LAX/extra"` against the warehouse on
    // every such request. What is asserted here is only that no OG row takes them; whether any
    // row does is `isOurs`'s question.
    const row = QUERY_ROWS.find((r) => r.matches(pathname));
    expect(row?.route.endsWith("/opengraph-image") ?? false).toBe(false);
  });

  it("never declares a repeatable key it does not also allow", () => {
    for (const row of QUERY_ROWS) {
      for (const key of row.repeatable) {
        expect(row.keys.has(key)).toBe(true);
      }
    }
  });
});

describe("isOurs", () => {
  it.each([
    ["/", true],
    ["/carrier/DL", true],
    ["/carrier/D%2FL", true],
    ["/explore/filter/origin_state", true],
    ["/api/pivot", true],
    ["/carrier/DL/x", false],
    ["/explore/filter/origin_state/x", false],
    ["/api/health", false],
    ["/_next/static/chunks/app.js", false],
    ["/nope", false],
  ])("isOurs(%j) is %s", (pathname, expected) => {
    expect(isOurs(pathname)).toBe(expected);
  });

  it.each(["/%zz", "/carrier/%E0%A4%A", "//", "/carrier//x", `/${"a/".repeat(2000)}`, "/ ", "/carrier/%2F%2F"])(
    "never throws on %j -- it runs on every request",
    (pathname) => {
      expect(() => isOurs(pathname)).not.toThrow();
    },
  );
});
