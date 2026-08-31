import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MAX_LIMIT, checkBounds, checkSpelling, decodeRequest } from "@/lib/pivot/bounds";
import { decode, UrlStateError } from "@/lib/pivot/urlstate";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";
import { EARLIEST_YEAR, maxValidYear } from "@/lib/year";
import { normalizeQuery, type PivotQuery } from "@/lib/pivot/types";

/** A query that is admissible on every axis, so each test below varies exactly ONE thing and
 * the verdict it gets can only be about that thing. */
function q(over: Partial<PivotQuery> = {}): PivotQuery {
  return normalizeQuery({
    grain: "segment",
    dimensions: ["op_airline_id"],
    measures: ["seats"],
    timeFrom: "2015-01",
    timeTo: "2015-12",
    filters: [],
    sort: null,
    sortDesc: true,
    limit: 100,
    grouping: "operating",
    ...over,
  });
}

const LATEST_MONTH = `${maxValidYear()}-12`;
const EARLIEST_MONTH = `${EARLIEST_YEAR}-01`;

/** Asserts the error TYPE as well as the message, matching urlstate.test.ts's own
 * `expectUrlStateError`: the whole contract of `decodeRequest` is that a caller need catch
 * only `UrlStateError`, exactly as it does for `decode`. A bare `.toThrow(/re/)` is satisfied
 * by any throw at all. */
function expectUrlStateError(fn: () => unknown, msgPattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(UrlStateError);
  expect((caught as Error).message).toMatch(msgPattern);
}

describe("checkBounds -- the time window", () => {
  it("rejects a month before the data window", () => {
    // Catches: dropping the LOWER bound, which re-opens MONTH_RE's full 10,000-year range
    // downward -- ?t=0001-01:2015-12 and friends, each a distinct cacheable 200.
    const v = checkBounds(q({ timeFrom: `${EARLIEST_YEAR - 1}-12`, timeTo: "2015-12" }));
    expect(v.kind).toBe("rejected");
  });

  it("rejects a month past the current calendar year", () => {
    // The OTHER half, and it must be its own test: a mutant that drops only the upper bound
    // still passes the lower-bound test above. BTS files after the fact, so no month past the
    // real calendar can be in this dataset.
    const v = checkBounds(q({ timeFrom: "2015-01", timeTo: "9999-12" }));
    expect(v.kind).toBe("rejected");
  });

  it("accepts the first and last month of the window, exactly at the boundary", () => {
    // The anti-vacuity control for the two tests above: a checkBounds that rejected
    // EVERYTHING would pass both of them. This is the half that has to redden for a
    // blanket-reject mutant, and it pins the boundary itself rather than a magnitude.
    expect(checkBounds(q({ timeFrom: EARLIEST_MONTH, timeTo: LATEST_MONTH }))).toEqual({
      kind: "ok",
    });
  });

  it("rejects a reversed range whose two months are BOTH inside the window", () => {
    // Catches: omitting the from <= to check. Both months are in-window, so neither range
    // test above can account for this verdict -- a fixture using an out-of-window month would
    // pass against an implementation that has no ordering rule at all.
    const v = checkBounds(q({ timeFrom: "2015-12", timeTo: "2015-01" }));
    expect(v.kind).toBe("rejected");
  });

  it("accepts a single-month range, where from equals to", () => {
    // Catches: writing `from < to` for `from <= to`. A one-month query is legitimate and
    // encode() emits it, so a strict comparison would break a permalink this app can mint.
    expect(checkBounds(q({ timeFrom: "2015-06", timeTo: "2015-06" }))).toEqual({ kind: "ok" });
  });

  it("names the offending value and the valid range, per the invalid-permalink contract", () => {
    const v = checkBounds(q({ timeFrom: "1999-01", timeTo: "1999-12" }));
    expect(v.kind === "rejected" && v.message).toContain("1999-01:1999-12");
    expect(v.kind === "rejected" && v.message).toContain(EARLIEST_MONTH);
    expect(v.kind === "rejected" && v.message).toContain(LATEST_MONTH);
  });
});

describe("checkBounds -- the limit", () => {
  it("rejects a limit above MAX_LIMIT", () => {
    // Catches: dropping the upper bound, which leaves `n` an unbounded family of distinct
    // cacheable 200s, each a full DuckDB render.
    expect(checkBounds(q({ limit: MAX_LIMIT + 1 })).kind).toBe("rejected");
  });

  it("accepts MAX_LIMIT itself", () => {
    // The boundary's other side: catches `>=` written for `>`, which would make the
    // documented ceiling unreachable and is invisible to the test above.
    expect(checkBounds(q({ limit: MAX_LIMIT }))).toEqual({ kind: "ok" });
  });

  it("does NOT restate the positive-integer rule that renderPivot already owns", () => {
    // render.ts:80-81 rejects limit <= 0 and decode() runs renderPivot before returning, so a
    // second check here would be the drifting-duplicate-validator this repo forbids. Pinning
    // the boundary: checkBounds is silent about 0 and about a negative.
    expect(checkBounds(q({ limit: 0 }))).toEqual({ kind: "ok" });
    expect(checkBounds(q({ limit: -5 }))).toEqual({ kind: "ok" });
  });
});

/** The family a spelling rule structurally cannot see, because every repeat is spelled exactly
 * one way: `d` and `m` are split on `,` and nothing downstream dedupes -- not normalizeQuery
 * (types.ts:31, which mirrors PivotQuery.__post_init__ and dedupes nothing there either) and not
 * renderPivot. Measured on a served build: `m=seats` x200 rendered a 661,824-byte 200 under
 * HTML_CACHE, and `d=op_airline_id` x50 a 431,790-byte one. */
describe("checkBounds -- repeated dimensions and measures", () => {
  it("rejects a repeated measure", () => {
    // Catches: no dedupe rule at all, which leaves `m` unbounded in the NUMBER of tokens for a
    // query that is in-window, under the ceiling, and canonically spelled on every byte.
    expect(checkBounds(q({ measures: ["seats", "seats"] })).kind).toBe("rejected");
  });

  it("rejects a repeated dimension", () => {
    // Its own test: a rule written over `q.measures` only passes the one above and leaves the
    // identical family open on `d`.
    expect(checkBounds(q({ dimensions: ["op_airline_id", "op_airline_id"] })).kind)
      .toBe("rejected");
  });

  it("rejects a repeat that is not adjacent", () => {
    // Catches: a cheap `tokens[i] === tokens[i-1]` neighbour comparison, which `a,b,a` walks
    // straight past. The set-based form is what makes the rule about the LIST, not the order.
    expect(checkBounds(q({ measures: ["seats", "load_factor", "seats"] })).kind).toBe("rejected");
  });

  it("accepts a multi-token d and m whose tokens are all distinct", () => {
    // The anti-vacuity control, and a real shipped shape: golden case 1 is
    // `d=year_month,op_airline_id&m=seats,load_factor`. A rule that rejected any list longer
    // than one would pass all three tests above and break that permalink.
    expect(
      checkBounds(
        q({ dimensions: ["year_month", "op_airline_id"], measures: ["seats", "load_factor"] }),
      ),
    ).toEqual({ kind: "ok" });
  });

  it("says which token repeated, per the invalid-permalink contract", () => {
    const v = checkBounds(q({ measures: ["seats", "load_factor", "seats"] }));
    expect(v.kind === "rejected" && v.message).toContain("seats");
    expect(v.kind === "rejected" && v.message).toContain("'m'");
  });
});

describe("checkSpelling -- one value, one spelling", () => {
  const BASE = "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&g=op";

  it("accepts the one spelling encode() emits", () => {
    expect(checkSpelling(`${BASE}&n=25`)).toEqual({ kind: "ok" });
  });

  it("rejects leading zeros on n", () => {
    // Catches: bounding n's VALUE while leaving its SPELLING unbounded. n=0...025 decodes to
    // 25 for any number of leading zeros -- an unbounded cache-key family on its own, which
    // no value-range check can see.
    expect(checkSpelling(`${BASE}&n=00000025`).kind).toBe("rejected");
  });

  it("rejects percent-encoded digits, a sign, an underscore and leading whitespace on n", () => {
    // Every one of these decodes to 25 today: pyUnquote turns %32%35 into "25", and
    // PY_INT_RE permits a sign, `_` separators and surrounding whitespace. The check must run
    // on the RAW bytes, before pyUnquote, or the first of these sails through.
    expect(checkSpelling(`${BASE}&n=%32%35`).kind).toBe("rejected");
    expect(checkSpelling(`${BASE}&n=%2B25`).kind).toBe("rejected");
    expect(checkSpelling(`${BASE}&n=2_5`).kind).toBe("rejected");
    expect(checkSpelling(`${BASE}&n=%2025`).kind).toBe("rejected");
  });

  it("rejects leading zeros on v, which has the identical hole", () => {
    expect(checkSpelling("v=0001&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12").kind)
      .toBe("rejected");
  });

  it("does not apply the NUMERAL rule to a textual key", () => {
    // Catches a check that rejects by scanning the whole query rather than dispatching per key:
    // `d`, `m`, `f` and `s` carry text that is not a numeral by design, so CANONICAL_NUMERAL
    // must never be reached for them.
    expect(checkSpelling(`${BASE}&f=origin_state:OR&n=25`)).toEqual({ kind: "ok" });
  });

  // The percent-encoding half. `decode()` calls pyUnquote at urlstate.ts:179 and only checks the
  // SHAPE afterwards -- MONTH_RE at urlstate.ts:214 -- so every one of these decoded to exactly
  // the BASE query above and rendered a distinct, in-bounds, HTML_CACHE'd 200. Measured against
  // the real codec with the window and ceiling rules already in place.

  it("rejects a percent-encoded digit in t, which is in-window and correctly ordered", () => {
    // `t=%32015-01:2015-12` decodes to `t=2015-01:2015-12`, so checkBounds sees a perfectly
    // admissible query and says ok -- a range check structurally cannot catch this. Catches:
    // `t` missing from LITERAL_KEYS, i.e. reasoning that MONTH_RE's four-digit shape leaves `t`
    // no spelling freedom. It runs AFTER pyUnquote (urlstate.ts:214 vs :179), so it constrains
    // the decoded value and says nothing at all about the bytes.
    expect(checkSpelling(`${BASE.replace("t=2015-01", "t=%32015-01")}&n=25`).kind).toBe("rejected");
  });

  it("rejects a percent-encoded STRUCTURAL colon in t", () => {
    // The separator, not a digit: `t=2015-01%3A2015-12` is found by indexOf(":") only because
    // pyUnquote already ran. Its own test because a rule keyed on digits alone would pass the
    // one above and fail here.
    expect(checkSpelling(`${BASE.replace(":2015-12", "%3A2015-12")}&n=25`).kind).toBe("rejected");
  });

  it("rejects LOWERCASE hex, which doubles the family again per encoded byte", () => {
    // Catches: a check written as a case-sensitive scan for `%XX` uppercase escapes. `%3a` and
    // `%3A` both unquote to `:` (pyUnquote's own /^[0-9A-Fa-f]{2}$/), so a rule that saw only
    // one of them would leave every letter-bearing escape with two spellings instead of one.
    expect(checkSpelling(`${BASE.replace(":2015-12", "%3a2015-12")}&n=25`).kind).toBe("rejected");
  });

  // One test per key rather than one test looping five keys: a mutant that drops a single key
  // from LITERAL_KEYS must redden exactly one NAMED test. Each string below was confirmed
  // against the real codec to decode to the same query as BASE.
  const ENCODED: [string, string][] = [
    ["k", "v=1&k=%73eg&d=op_airline_id&m=seats&t=2015-01:2015-12&g=op&n=25"],
    ["d", "v=1&k=seg&d=op%5Fairline%5Fid&m=seats&t=2015-01:2015-12&g=op&n=25"],
    ["m", "v=1&k=seg&d=op_airline_id&m=%73eats&t=2015-01:2015-12&g=op&n=25"],
    ["g", "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&g=%6Fp&n=25"],
    ["s", "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&g=op&s=%2Dseats&n=25"],
  ];
  for (const [key, qs] of ENCODED) {
    it(`rejects a percent-encoded ${key}`, () => {
      expect(checkSpelling(qs).kind, qs).toBe("rejected");
    });
  }

  it("rejects a percent-encoded structural COMMA in d, which separates two dimensions", () => {
    // `d=op_airline_id%2Cyear_month` decodes to two dimensions, because single.d is split on `,`
    // AFTER pyUnquote (urlstate.ts:179 then :235). So the separator has the same two spellings
    // the colon in `t` does, on a key whose token list is otherwise allowlisted.
    expect(
      checkSpelling("v=1&k=seg&d=op_airline_id%2Cyear_month&m=seats&t=2015-01:2015-12&g=op&n=25")
        .kind,
    ).toBe("rejected");
  });

  it("leaves f alone, because percent-encoding is that key's own escape mechanism", () => {
    // The anti-vacuity control for every percent test above, and the one that would break real
    // shipped permalinks if it failed: golden case 8 is
    // `f=op_airline_id:2T%20%281%29,O%27Hare,...` -- a filter value legitimately carries `,`,
    // `:`, `&`, `=` and spaces, so `quote()` MUST encode them. Catches: adding `f` to
    // LITERAL_KEYS, which a blanket "no % anywhere" rule would do.
    expect(checkSpelling(`${BASE}&f=op_airline_id:2T%20%281%29,O%27Hare&n=25`)).toEqual({
      kind: "ok",
    });
  });

  it("accepts the literal spelling of every key it guards", () => {
    // The other anti-vacuity control: a checkSpelling that rejected everything would pass all
    // eight percent tests above. This is the half that has to stay green.
    expect(checkSpelling(`${BASE}&s=-seats&n=25`)).toEqual({ kind: "ok" });
  });

  it("is silent about a non-positive n, leaving that message to renderPivot", () => {
    // n=0 and n=-5 must keep renderPivot's "limit must be a positive integer" message rather
    // than being re-diagnosed here as a spelling problem.
    expect(checkSpelling(`${BASE}&n=0`)).toEqual({ kind: "ok" });
  });

  it("never throws, on any input, because it runs on the proxy path", () => {
    // canonicalize() threw on a leading `?` once and 500ed all twelve matcher paths. Anything
    // reachable from proxy.ts is total or it is that bug again.
    for (const hostile of ["", "?", "??n=1", "&&", "n", "n=", "=25", "%", "n=%", "n=%zz"]) {
      expect(() => checkSpelling(hostile)).not.toThrow();
    }
  });
});

describe("decodeRequest -- the wiring, which is a separate thing from the rules", () => {
  const BASE = "v=1&k=seg&d=op_airline_id&m=seats&g=op";

  it("rejects an out-of-window t as an UrlStateError", () => {
    // Catches: bounds.ts being correct and never called. bounds.test.ts's own cases all stay
    // green under that mutant; only this one goes red.
    expectUrlStateError(
      () => decodeRequest(`${BASE}&t=1999-01:1999-12&n=25`, FIXTURE),
      /time range/i,
    );
  });

  it("rejects a limit above MAX_LIMIT as an UrlStateError", () => {
    expectUrlStateError(
      () => decodeRequest(`${BASE}&t=2015-01:2015-12&n=${MAX_LIMIT + 1}`, FIXTURE),
      /limit/i,
    );
  });

  it("rejects a non-canonically-spelled n as an UrlStateError", () => {
    expectUrlStateError(
      () => decodeRequest(`${BASE}&t=2015-01:2015-12&n=00000025`, FIXTURE),
      /decimal/i,
    );
  });

  it("rejects a non-canonically-spelled v as an UrlStateError", () => {
    expectUrlStateError(
      () => decodeRequest(`v=0001&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&n=25&g=op`, FIXTURE),
      /decimal/i,
    );
  });

  it("rejects a percent-encoded t as an UrlStateError", () => {
    // The wiring half of the headline bug: checkSpelling can be entirely correct about `t` and
    // never consulted. Catches a decodeRequest that composes checkBounds only.
    expectUrlStateError(
      () => decodeRequest(`${BASE}&t=%32015-01:2015-12&n=25`, FIXTURE),
      /percent-encoding/i,
    );
  });

  it("rejects a repeated measure as an UrlStateError", () => {
    expectUrlStateError(
      () => decodeRequest(`v=1&k=seg&d=op_airline_id&m=seats,seats&t=2015-01:2015-12&n=25&g=op`, FIXTURE),
      /must appear once/i,
    );
  });

  it("keeps renderPivot's own message for a non-positive limit", () => {
    // The ordering that makes test "does NOT restate the positive-integer rule" true end to
    // end: decode() runs first, so n=0 is diagnosed by the one validator that owns it.
    expectUrlStateError(
      () => decodeRequest(`${BASE}&t=2015-01:2015-12&n=0`, FIXTURE),
      /limit must be a positive integer/i,
    );
  });

  it("returns the same query decode() does when everything is admissible", () => {
    const qs = `${BASE}&t=2015-01:2015-12&n=25`;
    expect(decodeRequest(qs, FIXTURE)).toEqual(decode(qs, FIXTURE));
  });
});

describe("bare decode() is untouched -- the port stays an exact port", () => {
  // docs/product/features.md: "Reference implementation: pipeline/urlstate.py; the TypeScript
  // port must match it exactly", and pipeline/urlstate.py:64-68 records the reversed range as
  // a deliberately accepted gap. The bound is a SERVER ADMISSION policy, not a codec rule --
  // this test is what pins that boundary, and it goes red the moment someone "simplifies" by
  // moving the check into decode().
  const BASE = "v=1&k=seg&d=op_airline_id&m=seats&g=op";

  it("still accepts an out-of-window t", () => {
    expect(decode(`${BASE}&t=9999-12:0000-01&n=25`, FIXTURE).timeFrom).toBe("9999-12");
  });

  it("still accepts a limit above MAX_LIMIT", () => {
    expect(decode(`${BASE}&t=2015-01:2015-12&n=${MAX_LIMIT + 1}`, FIXTURE).limit).toBe(
      MAX_LIMIT + 1,
    );
  });

  it("still accepts a non-canonically-spelled n", () => {
    expect(decode(`${BASE}&t=2015-01:2015-12&n=00000025`, FIXTURE).limit).toBe(25);
  });

  it("still accepts a percent-encoded t, colon and all", () => {
    // pyUnquote before MONTH_RE is the codec's own documented behaviour, matching
    // urllib.parse.unquote in pipeline/urlstate.py. The SERVER declines these; the codec must
    // not, or the port has drifted from the reference in the other direction.
    const q = decode(`${BASE}&t=%32015-01%3A2015-12&n=25`, FIXTURE);
    expect([q.timeFrom, q.timeTo]).toEqual(["2015-01", "2015-12"]);
  });

  it("still accepts a repeated measure", () => {
    expect(decode(`${BASE}&t=2015-01:2015-12&n=25`.replace("m=seats", "m=seats,seats"), FIXTURE)
      .measures).toEqual(["seats", "seats"]);
  });
});

/** The regression guard that matters most: a bound that refuses a permalink this product has
 * already SHIPPED would break links that are, by this project's own framing, the entire growth
 * mechanic and are already sitting in forum posts.
 *
 * Two corpora, both derived rather than restated. The goldens are the frozen codec contract; the
 * scan below is what the app actually spells by hand today -- found by walking the source, not by
 * copying strings into this file, because a copy rots silently the moment someone edits a page. */
describe("no permalink this app has shipped becomes unreadable", () => {
  const REPO = path.resolve(__dirname, "../../../..");
  const urlstateGoldens = JSON.parse(
    readFileSync(path.join(REPO, "sql/03_queries/goldens/urlstate.json"), "utf8"),
  );

  it("accepts every one of the 9 golden URLs", () => {
    expect(urlstateGoldens.cases).toHaveLength(9);
    for (const c of urlstateGoldens.cases) {
      expect(() => decodeRequest(c.url, FIXTURE)).not.toThrow();
    }
  });

  /** Every hand-spelled `/explore?` permalink literal under `app/src`, as `<file> => <qs>`.
   *
   *  WHAT THIS CATCHES THAT NOTHING ELSE CAN: a NEW one appearing, anywhere. `recovery.test.ts`,
   *  `page.test.tsx` and `recoveryLink.callsites.test.tsx` each pin a KNOWN permalink; not one of
   *  them can see a tenth literal added to some file tomorrow. That is the exact mechanism that
   *  produced #145's own frozen-window defect, so the scan outlives the literals it was written
   *  for: it is an emptiness assertion, and an empty exact-set pin is falsifiable (add a literal
   *  and it fails), the same shape `prefetchPolicy.test.ts`'s KNOWN_PREFETCHING and
   *  `entityFacts.test.ts`'s declaration pin already use.
   *
   *  THE ROOT IS `app/src`, NOT `app/src/app`, and the difference is not hypothetical. #145's own
   *  three hand-spelled builders were `lib/watch.ts`, `lib/topn.ts` and one page -- two of the
   *  three live under `lib/`, so a scan rooted at `app/src/app` cannot see a regression in the
   *  very files this issue exists to fix. `entityFacts.test.ts` scans all of `app/src` for the
   *  same reason.
   *
   *  THE ANCHOR IS THE QUOTE DELIMITER PLUS AN `=`, and it is deliberately NOT a `v=1` prefix.
   *  `v` first is one SPELLING, not the format: CLAUDE.md's rule is "one canonical KEY SET, never
   *  'one spelling' -- key order survives", so `...&g=op&v=1` is a working, server-admitted,
   *  cacheable permalink that a `v=1`-anchored scan waves through -- and it would freeze exactly
   *  the way the front door's SAMPLE did. Requiring the opening quote instead catches every way a
   *  literal is actually written: `href="..."`, `href={"..."}`, single quotes, a template literal
   *  with no interpolation, and adjacent-string concatenation (rejoined below), in either key
   *  order.
   *
   *  The second half of the anchor is that the query must BEGIN like one -- `/^[a-z]+=/` -- which
   *  is a shape requirement, not an order one, so it holds for any key order. That is what keeps
   *  prose out without narrowing the format: `canonicalQuery.ts` really does document a measured
   *  finding as `` `/explore?...&bogus=1` ``, which carries an `=` and is emphatically not a
   *  permalink. An ELIDED query cannot start with a key; a real one always does.
   *
   *  So what it excludes, precisely: an UNQUOTED mention in prose, and a quoted one that does not
   *  open with a key. A docstring that quotes a FULL working query IS a subject, and that is
   *  correct rather than a false positive: a quoted, complete, admissible permalink sitting in
   *  this tree is one copy-paste from being a call site, which is how the eight #140 closed got
   *  there.
   *
   *  Anything carrying a brace is INTERPOLATED, not a literal: a template-literal href
   *  (`/explore?${encode(query)}`) is built from a PivotQuery this app just constructed, so its
   *  admissibility is a property of the builder rather than of a string, and `encode()`
   *  round-trips through `decode()` by contract. The JSX permalink bar (`/explore?{permalink}`)
   *  is the same case, and is additionally unquoted. Only hand-written literals need this scan. */
  function scanPermalinks(): { hits: string[]; filesScanned: number } {
    const dir = path.join(REPO, "app/src");
    const hits: string[] = [];
    let filesScanned = 0;
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          filesScanned += 1;
          // Adjacent-string concatenation (`"a" + "b"`, which the front door's SAMPLE used)
          // rejoined first, across a newline too -- without it the scan silently truncates such a
          // literal to its first half and "passes" against a URL it never tested.
          const src = readFileSync(full, "utf8").replace(/"\s*\+\s*"/g, "");
          for (const m of src.matchAll(/["'`]\/explore\?([^"'`\s]*)/g)) {
            const qs = m[1];
            if (!qs.includes("{") && /^[a-z]+=/.test(qs)) {
              hits.push(`${path.relative(REPO, full)} => ${qs}`);
            }
          }
        }
      }
    };
    walk(dir);
    return { hits, filesScanned };
  }

  // BOTH HALVES ARE LOAD-BEARING, exactly as in `prefetchPolicy.test.ts`. Without the
  // `filesScanned` guard, a walker that silently found nothing -- a moved directory, a changed
  // extension -- would satisfy the emptiness assertion having read nothing at all.
  it("walks real files, so an empty result means empty and not broken", () => {
    expect(scanPermalinks().filesScanned).toBeGreaterThan(50);
  });

  // ZERO, as an EXACT SET so the failure names the offender and its query string.
  //
  // #140 took this from nine literals to one; #145 took the last one -- the front door's SAMPLE,
  // which froze `t=2025-05:2026-04` under prose calling it "the trailing 12 months". The pin stays
  // at zero rather than being deleted with its subjects: the assertion is about what may appear,
  // not about what is there, and a tenth literal is a real regression this repo would otherwise
  // ship blind. The ADMISSIBILITY loop that used to sit beside it is gone -- over an empty corpus
  // it iterated nothing, and `recovery.test.ts` and `page.test.tsx` now assert `decodeRequest`
  // admits the two queries that corpus used to hold, across a range of `asOf`.
  it("finds no hand-spelled /explore permalink anywhere under app/src", () => {
    expect(scanPermalinks().hits).toEqual([]);
  });
});
