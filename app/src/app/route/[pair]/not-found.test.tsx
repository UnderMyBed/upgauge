// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// not-found-pair.tsx's usePathname() needs an App Router context this test harness doesn't
// mount (this codebase has no mocks elsewhere -- lib/resolve.ts's header comment -- but
// next/navigation's hooks are a framework seam, not application logic, and Next's own docs
// point at client-side data fetching for exactly this file's situation: there is nothing to
// verify by NOT stubbing it, only an "invariant expected app router to be mounted" throw).
vi.mock("next/navigation", () => ({
  usePathname: () => "/route/ZZZZ-LAX",
}));

import NotFound from "@/app/route/[pair]/not-found";

// Important 2, final whole-branch review: before this file existed, notFound() (page.tsx)
// fell through to Next's stock 404 UI -- no wordmark, no DATA AS OF, no hint of what
// routePair.ts already worked out (its `reason`, pinned by routePair.test.ts, never reached
// the reader). This is the branded replacement Next's not-found.js convention picks up
// automatically for every notFound() thrown in this route segment.
describe("/route/<pair> not-found", () => {
  it("renders the wordmark and DATA AS OF, not Next's bare 404", async () => {
    const { container } = render(await NotFound());
    // Fails if the wordmark markup regresses or is dropped -- getByText can't see "UPGAUGE"
    // as one string (the "GAUGE" half lives in a nested span; explore/page.test.tsx's own
    // header comment documents why getByText only reads a node's OWN text), so this checks
    // the DOM directly instead of guessing at a text match that would silently never fire.
    expect(container.querySelector(".mark")?.textContent).toBe("UPGAUGE");
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("names the failing pair, derived from the URL", async () => {
    render(await NotFound());
    // Fails if not-found-pair.tsx stops reading usePathname(), or the regex stops stripping
    // the "/route/" prefix (the pair would then never appear standalone in the text).
    expect(screen.getByText(/ZZZZ-LAX/)).toBeDefined();
  });

  it("offers a way back into a working page", async () => {
    render(await NotFound());
    expect(screen.getByRole("link", { name: /JFK.LAX/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Explorer/i })).toBeDefined();
  });
});
