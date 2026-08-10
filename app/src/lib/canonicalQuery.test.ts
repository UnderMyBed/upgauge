import { describe, expect, it } from "vitest";
import { canonicalize, QUERY_ROWS } from "@/lib/canonicalQuery";
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

  it("throws on a rawQuery that still carries the leading '?'", () => {
    // rawQuery's contract is proxy.ts:40's output -- `.search.replace(/^\?/, "")` -- never
    // `.search` itself. A caller that hands this function the raw `.search` value would have
    // its first chunk's key parse as "?y", which is absent from every row's `keys`, silently
    // dropping a legitimate key and reporting `strip` instead of `clean`. Throwing turns that
    // wiring bug into a failure at the first request instead of a permalink silently mangled.
    expect(() => canonicalize("/airport/ORD", "?y=2019")).toThrow(/leading '\?'/);
  });

  it("the identical query WITHOUT the '?' is clean -- the guard fires on the spelling, not on the query", () => {
    // Paired with the throw test above: this is what distinguishes "the guard rejects the wrong
    // spelling" from "the guard rejects everything". Same path, same key, same value -- only the
    // leading '?' differs.
    expect(canonicalize("/airport/ORD", "y=2019")).toEqual({ kind: "clean" });
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
});

describe("QUERY_ROWS", () => {
  it("has exactly one row per proxy matcher entry", () => {
    // The third list that must agree with config.matcher and ENTITY_ROUTES. A row missing here
    // ships a path with no query protection; a matcher entry missing there ships a page with no
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
