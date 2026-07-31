// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

// No mocks: the page is a Server Component taking the pathname as a prop (from proxy.ts's
// RAW_PATH_HEADER, lib/rawPath.ts) and re-running the REAL resolveAirportCode against the
// REAL database -- the same shape, and the same reasoning, as route/[pair]/not-found.test.tsx.
import { NotFoundView } from "@/app/airport/[code]/not-found";
import { airportSlugFromPath } from "@/app/airport/[code]/resolveAirport";

describe("/airport/<code> not-found", () => {
  it("renders the wordmark and DATA AS OF, not Next's bare 404", async () => {
    const { container } = render(await NotFoundView({ pathname: "/airport/ZZZZ" }));
    expect(container.querySelector(".mark")?.textContent).toBe("UPGAUGE");
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  // Each case asserts the discriminating phrase AND the absence of a sibling's, because the
  // failure being guarded is a fallback to one generic sentence listing every cause -- which
  // would satisfy any single positive assertion.
  it("names the unknown code", async () => {
    render(await NotFoundView({ pathname: "/airport/ZZZZ" }));
    expect(screen.getByText(/unknown airport code 'ZZZZ'/)).toBeDefined();
    expect(screen.queryByText(/domestic-only/)).toBeNull();
  });

  it("distinguishes a real airport this domestic-only dataset has no rows for", async () => {
    render(await NotFoundView({ pathname: "/airport/LHR" }));
    expect(screen.getByText(/'LHR' is a recognized airport code/)).toBeDefined();
    expect(screen.getByText(/domestic-only/)).toBeDefined();
    expect(screen.queryByText(/unknown airport code/)).toBeNull();
  });

  it("offers a way back into a working page", async () => {
    render(await NotFoundView({ pathname: "/airport/ZZZZ" }));
    expect(screen.getByRole("link", { name: /SEA/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Explorer/i })).toBeDefined();
  });

  it("falls back to a generic message when the path is not an airport page", async () => {
    // Asserts the alert's exact TEXT, not merely that an alert exists: the component renders
    // `<p role="alert">` unconditionally, so a getByRole("alert") alone could not fail.
    render(await NotFoundView({ pathname: "/somewhere/else" }));
    expect(screen.getByRole("alert").textContent).toBe("We don’t recognize this page.");
    expect(screen.queryByText(/unknown airport code/)).toBeNull();
  });
});

describe("airportSlugFromPath", () => {
  it("reads the code out of an /airport/ pathname", () => {
    expect(airportSlugFromPath("/airport/SEA")).toBe("SEA");
  });

  it("returns null for any other pathname, including the prefix alone", () => {
    expect(airportSlugFromPath("/route/JFK-LAX")).toBeNull();
    expect(airportSlugFromPath("/airport")).toBeNull();
    // The prefix with nothing after it is not a slug: Next would not route it to [code] at
    // all, and returning "" would send an empty IN-list into the lookup.
    expect(airportSlugFromPath("/airport/")).toBeNull();
  });

  it("percent-decodes, and survives a malformed escape rather than throwing", () => {
    // The page receives `params.code` already decoded, so this must decode too or the two
    // disagree. `decodeURIComponent` THROWS on '%zz' -- bug #2 on smoke.sh's list of
    // production-only failures -- so a malformed escape falls back to the raw text, which
    // resolveAirportCode then rejects as an unknown code.
    expect(airportSlugFromPath("/airport/%53EA")).toBe("SEA");
    expect(airportSlugFromPath("/airport/%zz")).toBe("%zz");
  });
});
