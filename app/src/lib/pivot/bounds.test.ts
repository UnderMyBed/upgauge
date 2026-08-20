import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MAX_LIMIT, checkBounds, checkNumeralSpelling, decodeRequest } from "@/lib/pivot/bounds";
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

describe("checkNumeralSpelling", () => {
  const BASE = "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12&g=op";

  it("accepts the one spelling encode() emits", () => {
    expect(checkNumeralSpelling(`${BASE}&n=25`)).toEqual({ kind: "ok" });
  });

  it("rejects leading zeros on n", () => {
    // Catches: bounding n's VALUE while leaving its SPELLING unbounded. n=0...025 decodes to
    // 25 for any number of leading zeros -- an unbounded cache-key family on its own, which
    // no value-range check can see.
    expect(checkNumeralSpelling(`${BASE}&n=00000025`).kind).toBe("rejected");
  });

  it("rejects percent-encoded digits, a sign, an underscore and leading whitespace on n", () => {
    // Every one of these decodes to 25 today: pyUnquote turns %32%35 into "25", and
    // PY_INT_RE permits a sign, `_` separators and surrounding whitespace. The check must run
    // on the RAW bytes, before pyUnquote, or the first of these sails through.
    expect(checkNumeralSpelling(`${BASE}&n=%32%35`).kind).toBe("rejected");
    expect(checkNumeralSpelling(`${BASE}&n=%2B25`).kind).toBe("rejected");
    expect(checkNumeralSpelling(`${BASE}&n=2_5`).kind).toBe("rejected");
    expect(checkNumeralSpelling(`${BASE}&n=%2025`).kind).toBe("rejected");
  });

  it("rejects leading zeros on v, which has the identical hole", () => {
    expect(checkNumeralSpelling("v=0001&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12").kind)
      .toBe("rejected");
  });

  it("is silent about a key it does not own", () => {
    // Catches a check that rejects by scanning the whole query rather than the two numeric
    // keys: `d`, `m`, `f` and `s` carry text that is not a numeral by design.
    expect(checkNumeralSpelling(`${BASE}&f=origin_state:OR&n=25`)).toEqual({ kind: "ok" });
  });

  it("is silent about a non-positive n, leaving that message to renderPivot", () => {
    // n=0 and n=-5 must keep renderPivot's "limit must be a positive integer" message rather
    // than being re-diagnosed here as a spelling problem.
    expect(checkNumeralSpelling(`${BASE}&n=0`)).toEqual({ kind: "ok" });
  });

  it("never throws, on any input, because it runs on the proxy path", () => {
    // canonicalize() threw on a leading `?` once and 500ed all twelve matcher paths. Anything
    // reachable from proxy.ts is total or it is that bug again.
    for (const hostile of ["", "?", "??n=1", "&&", "n", "n=", "=25", "%", "n=%", "n=%zz"]) {
      expect(() => checkNumeralSpelling(hostile)).not.toThrow();
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
});

/** The regression guard that matters most: a bound that refuses a permalink this product has
 * already SHIPPED would break links that are, by this project's own framing, the entire growth
 * mechanic and are already sitting in forum posts.
 *
 * Two corpora, both derived rather than restated. The goldens are the frozen codec contract;
 * the hardcoded hrefs are what the app actually serves to a reader today -- found by scanning
 * the source, not by copying eight strings into this file, because a copy rots silently the
 * moment someone edits a page and this test would then guard a URL nobody serves. */
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

  /** Every `/explore?...` literal in a page or component, with adjacent-string concatenation
   * (`"a" + "b"`, which the front door's SAMPLE uses) rejoined first -- without that the scan
   * silently truncates that one to its first half and "passes" against a URL it never tested. */
  function hardcodedPermalinks(): string[] {
    const dir = path.join(REPO, "app/src/app");
    const found: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          const src = readFileSync(full, "utf8").replace(/"\s*\+\s*"/g, "");
          for (const m of src.matchAll(/\/explore\?([^"'`\s]+)/g)) {
            // Anything carrying a brace is INTERPOLATED, not a literal: a template-literal
            // href (`/explore?${encode(query)}`) is built from a PivotQuery this app just
            // constructed, so its admissibility is a property of the builder rather than of a
            // string -- and `encode()` round-trips through `decode()` by contract. The JSX
            // permalink bar (`/explore?{permalink}`) is the same case. Only hand-written
            // literals need this scan.
            if (!m[1].includes("{")) found.push(m[1]);
          }
        }
      }
    };
    walk(dir);
    return found;
  }

  it("finds the hardcoded permalinks at all -- a scan matching nothing passes vacuously", () => {
    // Pinned so a refactor that moves these hrefs out of reach of the scan fails HERE, loudly,
    // rather than turning the test below into an empty loop that reports ok.
    expect(hardcodedPermalinks().length).toBe(8);
  });

  it("accepts every hardcoded /explore permalink the app serves", () => {
    for (const qs of hardcodedPermalinks()) {
      expect(() => decodeRequest(qs, FIXTURE), `hardcoded permalink: ${qs}`).not.toThrow();
    }
  });
});
