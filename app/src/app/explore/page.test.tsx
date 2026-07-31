// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExploreView } from "@/app/explore/page";

const OK = {
  v: "1",
  k: "seg",
  d: "op_airline_id",
  m: "seats",
  t: "2025-05:2026-04",
  s: "-seats",
  n: "5",
  g: "op",
};

// No real op_airline_id is anywhere near this value (BTS AIRLINE_IDs top out in the
// low-20000s over 2015-2026), so filtering on it is a valid query -- op_airline_id is a
// real, allowlisted dimension -- that genuinely matches zero rows, distinct from an invalid
// permalink.
const NO_SUCH_CARRIER = { ...OK, f: "op_airline_id:999999999" };

/** ExploreView takes the RAW query string, which is what a permalink actually is. None of
 * the values in these fixtures contain a character the format uses structurally, so a plain
 * join is an exact encoding of them -- the cases where that is NOT true are the point of the
 * second describe block below, and they are written as raw strings directly. */
function qs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

describe("/explore", () => {
  it("renders a table from a valid permalink", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText("Seats")).toBeDefined();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

  it("shows DATA AS OF", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("shows the encoded permalink", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText(/\/explore\?v=1/)).toBeDefined();
  });

  it("shows the legend rail alongside a populated result", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.getByText("Chart legend")).toBeDefined();
    expect(screen.getByText(/operating carrier is the grain/i)).toBeDefined();
  });

  it("names the offending key on an invalid permalink instead of falling back", async () => {
    render(await ExploreView({ rawQuery: qs({ ...OK, d: "nope" }) }));
    expect(screen.getByText(/unknown dimension/i)).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });

  it("states the query and offers a broader window for a valid query matching nothing", async () => {
    render(await ExploreView({ rawQuery: qs(NO_SUCH_CARRIER) }));
    // Empty is not an error: header, stat strip and legend rail all stay.
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
    expect(screen.getByText("Chart legend")).toBeDefined();
    // The query is stated in words, including the filter that produced the empty result.
    expect(screen.getByText(/no rows match/i)).toBeDefined();
    // Appears both in the stated-query message and the still-visible permalink bar.
    expect(screen.getAllByText(/999999999/).length).toBeGreaterThan(0);
    // A widened-window permalink is offered, never a blank panel.
    expect(screen.getByRole("link", { name: /same query over 2015-01/i })).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });
});

// Whole-branch review, CRITICAL 1: the page used to take Next's `searchParams` and rebuild a
// query string from it. Next percent-DECODES those before a page sees them -- parse-url.js
// builds `query` via searchParamsToUrlQuery(parsedURL.searchParams), i.e. URLSearchParams
// semantics -- so the rebuild re-emitted decoded values raw and splitPairs then re-split on
// delimiters no longer distinguishable from data. `/api/pivot` never had the bug because it
// reads the raw `new URL(request.url).search`.
//
// The fix is structural rather than defensive: ExploreView now takes the raw string as its
// only input, so there is no decoded object anywhere in the page for a future change to
// reconstruct from. proxy.ts supplies it. These cases would be unfixable under the old
// signature -- a `,` that was inside a value is, once decoded, indistinguishable from a `,`
// that separated two, so no amount of re-encoding could recover them.

// The values are the project's own pinned golden `filter_value_reserved_characters`
// (sql/03_queries/goldens/urlstate.json): every character the URL format uses structurally.
// docs/product/features.md:47 states the contract they encode.
//
// The golden puts them on `origin_airport_id`, which pins the CODEC round-trip only -- these
// tests execute a real query, and origin_airport_id is INT32, so DuckDB rejects '14,771' on
// type before fidelity can be observed. `origin_state` is the allowlisted segment-grain
// VARCHAR dimension, so the same values are type-valid there and simply match no rows --
// which is what puts them in the empty state's stated query, where they can be asserted on.
const RESERVED_RAW =
  "v=1&k=seg&d=op_airline_id&m=seats&t=2015-01:2015-12" +
  "&f=origin_state:14%2C771,13%26487,9%255,12%3A34,a%3Db,a%2Bb,a%20b" +
  "&n=100&g=op";

describe("/explore permalink fidelity across the Next request boundary", () => {
  it("preserves filter values containing the format's own delimiters", async () => {
    render(await ExploreView({ rawQuery: RESERVED_RAW }));

    // No real airport carries these IDs, so this is a valid query matching zero rows -- the
    // empty state states the query in words, which is where the filter values surface.
    expect(screen.queryByText(/can’t be read|can't be read/i)).toBeNull();
    expect(screen.getByText(/no rows match/i)).toBeDefined();

    // Each value must survive as ONE value. Re-splitting turned "14,771" into 14 and 771 --
    // a different query than the permalink encodes, rendered under a DATA AS OF badge.
    const stated = screen.getByText(/no rows match/i).textContent ?? "";
    for (const value of ["14,771", "13&487", "9%5", "12:34", "a=b", "a+b", "a b"]) {
      expect(stated).toContain(value);
    }
  });

  it("does not silently re-split a single filter value on an encoded comma", async () => {
    const raw = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&f=origin_state:14%2C771&n=5&g=op";
    render(await ExploreView({ rawQuery: raw }));
    // The silent case: no error, just the wrong query. The permalink the page echoes back
    // must re-encode the comma, proving it stayed one value rather than becoming 14 and 771.
    expect(screen.getByText(/14%2C771/)).toBeDefined();
  });
});

describe("/explore displays codes, not ids", () => {
  it("renders a carrier code and no bare airline id", async () => {
    render(await ExploreView({ rawQuery: qs(OK) }));
    expect(screen.queryByText("19790")).toBeNull();
    expect(screen.getAllByText(/^[A-Z0-9]{2}$/).length).toBeGreaterThan(0);
  });

  it("renders a route as two codes joined by an en dash", async () => {
    const raw = "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&s=-seats&n=5&g=op";
    render(await ExploreView({ rawQuery: raw }));
    expect(screen.getAllByText(/^[A-Z]{3}–[A-Z]{3}$/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Route key low")).toBeNull();
  });
});
