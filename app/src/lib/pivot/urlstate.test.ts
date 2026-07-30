import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decode, encode, pyUnquote, quote, UrlStateError } from "@/lib/pivot/urlstate";
import { queryFromJsonable } from "@/lib/pivot/types";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";

const REPO = path.resolve(__dirname, "../../../..");
const goldens = JSON.parse(
  readFileSync(path.join(REPO, "sql/03_queries/goldens/urlstate.json"), "utf8"),
);

/** Asserts BOTH the error type and the message. A bare `.toThrow(/regex/)` is satisfied by
 * ANY throw -- that gap is exactly how a `URIError` escaping through `decode` (fix round 1,
 * critical 1) went unnoticed: the message-only assertions all still matched. The module's
 * whole contract is that callers need catch only `UrlStateError` from this module (Task 7's
 * route handler branches on `instanceof UrlStateError`), so the type IS the contract. */
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

describe("golden fixture sanity", () => {
  it("has exactly 8 cases -- a reshaped fixture must not silently emit zero tests", () => {
    expect(goldens.cases).toHaveLength(8);
  });
});

describe("encode reproduces every pinned URL byte-for-byte", () => {
  for (const c of goldens.cases) {
    it(c.name, () => {
      expect(encode(queryFromJsonable(c.query))).toBe(c.url);
    });
  }
});

describe("decode round-trips every pinned URL", () => {
  for (const c of goldens.cases) {
    it(c.name, () => {
      expect(decode(c.url, FIXTURE)).toEqual(queryFromJsonable(c.query));
    });
  }
});

describe("quote matches Python's quote(safe=''), not encodeURIComponent", () => {
  it("encodes the five characters encodeURIComponent leaves literal", () => {
    expect(quote("!")).toBe("%21");
    expect(quote("*")).toBe("%2A");
    expect(quote("'")).toBe("%27");
    expect(quote("(")).toBe("%28");
    expect(quote(")")).toBe("%29");
  });

  it("leaves the unreserved set alone", () => {
    expect(quote("aZ0-_.~")).toBe("aZ0-_.~");
  });
});

describe("pyUnquote matches Python's unquote() -- decodes valid escapes, passes malformed ones through, never throws", () => {
  it("decodes a run of valid escapes", () => {
    expect(pyUnquote("a%2Cb")).toBe("a,b");
  });

  it("passes a malformed escape through literally instead of throwing", () => {
    expect(pyUnquote("%ZZ")).toBe("%ZZ");
    expect(pyUnquote("%2")).toBe("%2");
    expect(pyUnquote("%")).toBe("%");
  });

  it("decodes the valid escape and passes the invalid one through in the same string -- unquote is per-escape, not all-or-nothing", () => {
    expect(pyUnquote("a%2Cb%ZZ")).toBe("a,b%ZZ");
  });

  it("decodes a multi-byte UTF-8 escape run to the correct character", () => {
    expect(pyUnquote("%e2%82%ac")).toBe("€"); // Euro sign
  });

  it("round-trips quote() output, including the five encodeURIComponent-divergent characters", () => {
    const raw = "2T (1) O'Hare a!b c*d";
    expect(pyUnquote(quote(raw))).toBe(raw);
  });
});

describe("decode is total -- it rejects rather than guessing", () => {
  it("rejects an unknown key", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=op&zz=1", FIXTURE),
      /unknown/i,
    );
  });

  it("rejects a duplicated non-f key rather than taking last-wins", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&k=route&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE),
      /duplicate/i,
    );
  });

  it("rejects a malformed month", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=year_month&m=seats&t=2015-13:2015-12&n=5&g=op", FIXTURE),
      /time range/i,
    );
  });

  it("rejects a missing v", () => {
    expectUrlStateError(
      () => decode("k=seg&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE),
      /missing required key 'v'/i,
    );
  });

  it("rejects a wrong v", () => {
    expectUrlStateError(
      () => decode("v=2&k=seg&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE),
      /unrecognised url version/i,
    );
  });

  it.each(["k", "d", "m", "t"])("rejects a missing required key '%s'", (missing) => {
    const all: Record<string, string> = {
      v: "1",
      k: "seg",
      d: "year_month",
      m: "seats",
      t: "2015-01:2015-12",
      n: "5",
      g: "op",
    };
    delete all[missing];
    const qs = Object.entries(all)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    expectUrlStateError(() => decode(qs, FIXTURE), new RegExp(`missing required key '${missing}'`, "i"));
  });

  it("rejects a non-integer n", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&n=abc&g=op", FIXTURE),
      /limit.*integer/i,
    );
  });

  it("rejects a malformed filter with no colon", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&f=nocolonhere&n=5&g=op", FIXTURE),
      /malformed filter/i,
    );
  });

  it("rejects a malformed filter with no values", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&f=origin_airport_id:&n=5&g=op", FIXTURE),
      /malformed filter/i,
    );
  });

  it("rejects an unknown grain token", () => {
    expectUrlStateError(
      () => decode("v=1&k=bogus&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE),
      /unknown grain token/i,
    );
  });

  it("rejects an unknown grouping token", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=bogus", FIXTURE),
      /unknown grouping token/i,
    );
  });

  describe("delegates identifier/structural validation to renderPivot -- one allowlist, not two", () => {
    it("rejects an off-allowlist dimension", () => {
      expectUrlStateError(
        () => decode("v=1&k=seg&d=not_a_real_dimension&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE),
        /unknown dimension/i,
      );
    });

    it("rejects an off-allowlist sort key", () => {
      expectUrlStateError(
        () =>
          decode(
            "v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&s=not_a_real_sort_key&n=5&g=op",
            FIXTURE,
          ),
        /unknown sort key/i,
      );
    });

    it("rejects an empty dimension list ('d=')", () => {
      expectUrlStateError(
        () => decode("v=1&k=seg&d=&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE),
        /at least one dimension/i,
      );
    });
  });
});

describe("n and g are optional, defaulting per pipeline/urlstate.py -- resolved fix-round-1 item 2", () => {
  it("defaults limit to 100 and grouping to 'operating' when n and g are absent", () => {
    const q = decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12", FIXTURE);
    expect(q.limit).toBe(100);
    expect(q.grouping).toBe("operating");
  });
});

describe("critical fix round 1: decodeURIComponent threw where Python's unquote passes through", () => {
  it("accepts a malformed percent-escape in a non-f value ('d=%ZZ') and reports it via the allowlist, not a URIError", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=%ZZ&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE),
      /unknown dimension/i,
    );
  });

  it("ACCEPTS a malformed percent-escape inside a filter value -- filter values are never allowlisted, so it decodes to the literal string and the query is valid (zero rows, not an error)", () => {
    const q = decode(
      "v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&f=origin_airport_id:%ZZ&n=5&g=op",
      FIXTURE,
    );
    expect(q.filters).toEqual([["origin_airport_id", ["%ZZ"]]]);
  });

  it("rejects a malformed percent-escape in the sort key ('s=%') via the allowlist, not a URIError", () => {
    expectUrlStateError(
      () => decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&s=%&n=5&g=op", FIXTURE),
      /unknown sort key/i,
    );
  });

  it("decodes a percent-encoded non-f value (important 3: the decodeURIComponent -> pyUnquote path)", () => {
    // v=%31 is version '1' percent-encoded; s=%2Dseats is sort '-seats' percent-encoded.
    const q = decode("v=%31&k=seg&d=year_month&m=seats&t=2015-01:2015-12&s=%2Dseats&n=5&g=op", FIXTURE);
    expect(q.sort).toBe("seats");
    expect(q.sortDesc).toBe(true);
  });
});
