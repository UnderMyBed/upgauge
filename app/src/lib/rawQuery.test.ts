import { describe, expect, it } from "vitest";
import { MissingRawQueryError, RAW_QUERY_HEADER, rawQueryFromHeaders } from "@/lib/rawQuery";

// A real Headers object, not a mock: rawQueryFromHeaders is deliberately pure and takes the
// `get`-shaped interface so the header contract can be pinned without mocking next/headers.
describe("rawQueryFromHeaders", () => {
  it("returns the raw query string verbatim, percent-encoding intact", () => {
    const raw = "v=1&f=origin_airport_id:14%2C771,13%26487&n=100";
    const headers = new Headers({ [RAW_QUERY_HEADER]: raw });
    expect(rawQueryFromHeaders(headers)).toBe(raw);
  });

  it("treats an empty query string as a value, not as absence", () => {
    // /explore with no params is a real request; it must reach decode() and get a named
    // error about the missing `v`, not the deploy-misconfiguration error.
    const headers = new Headers({ [RAW_QUERY_HEADER]: "" });
    expect(rawQueryFromHeaders(headers)).toBe("");
  });

  it("throws rather than guessing when proxy.ts did not run", () => {
    expect(() => rawQueryFromHeaders(new Headers())).toThrow(MissingRawQueryError);
  });

  it("names the header and the file to check in the error", () => {
    // This error only ever surfaces to an operator mid-deploy, so it has to say what to fix.
    expect(() => rawQueryFromHeaders(new Headers())).toThrow(/proxy\.ts/);
    expect(() => rawQueryFromHeaders(new Headers())).toThrow(new RegExp(RAW_QUERY_HEADER));
  });
});
