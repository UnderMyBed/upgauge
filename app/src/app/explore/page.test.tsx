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

  it("names the offending key on an invalid permalink instead of falling back", async () => {
    render(await ExplorePage({ searchParams: Promise.resolve({ ...OK, d: "nope" }) }));
    expect(screen.getByText(/unknown dimension/i)).toBeDefined();
    expect(screen.queryAllByRole("row").length).toBe(0);
  });
});
