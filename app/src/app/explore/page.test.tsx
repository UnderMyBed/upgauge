// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ExplorePage from "@/app/explore/page";

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

describe("/explore", () => {
  it("renders a table from a valid permalink", async () => {
    render(await ExplorePage({ searchParams: Promise.resolve(OK) }));
    expect(screen.getByText("Seats")).toBeDefined();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

  it("shows DATA AS OF", async () => {
    render(await ExplorePage({ searchParams: Promise.resolve(OK) }));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("shows the encoded permalink", async () => {
    render(await ExplorePage({ searchParams: Promise.resolve(OK) }));
    expect(screen.getByText(/\/explore\?v=1/)).toBeDefined();
  });

  it("shows the legend rail alongside a populated result", async () => {
    render(await ExplorePage({ searchParams: Promise.resolve(OK) }));
    expect(screen.getByText("Chart legend")).toBeDefined();
    expect(screen.getByText(/operating carrier is the grain/i)).toBeDefined();
  });

  it("names the offending key on an invalid permalink instead of falling back", async () => {
    render(await ExplorePage({ searchParams: Promise.resolve({ ...OK, d: "nope" }) }));
    expect(screen.getByText(/unknown dimension/i)).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });

  it("states the query and offers a broader window for a valid query matching nothing", async () => {
    render(await ExplorePage({ searchParams: Promise.resolve(NO_SUCH_CARRIER) }));
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
