import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { encode, decode, quote } from "@/lib/pivot/urlstate";
import { queryFromJsonable } from "@/lib/pivot/types";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";

const REPO = path.resolve(__dirname, "../../../..");
const goldens = JSON.parse(
  readFileSync(path.join(REPO, "sql/03_queries/goldens/urlstate.json"), "utf8"),
);

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

describe("decode is total -- it rejects rather than guessing", () => {
  it("rejects an unknown key", () => {
    expect(() => decode("v=1&k=seg&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=op&zz=1", FIXTURE))
      .toThrow(/unknown/i);
  });

  it("rejects a duplicated non-f key rather than taking last-wins", () => {
    expect(() => decode("v=1&k=seg&k=route&d=year_month&m=seats&t=2015-01:2015-12&n=5&g=op", FIXTURE))
      .toThrow(/duplicate/i);
  });

  it("rejects a malformed month", () => {
    expect(() => decode("v=1&k=seg&d=year_month&m=seats&t=2015-13:2015-12&n=5&g=op", FIXTURE))
      .toThrow(/time range/i);
  });
});
