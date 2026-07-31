// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

// No mocks. Fix wave 2, Important 2: the previous version of this file mocked
// `next/navigation` wholesale (`usePathname: () => "/route/ZZZZ-LAX"`), which stubbed out the
// single mechanism the page's message depended on -- so `usePathname()` returning null in a
// real `not-found.js` render would have degraded the page to a generic sentence with this
// suite still green. The page is now a Server Component that takes the pathname as a prop
// (from proxy.ts's RAW_PATH_HEADER, see lib/rawPath.ts) and re-runs the REAL resolveRoutePair
// against the REAL database, exactly as db.test.ts and page.test.tsx do.
import { NotFoundView } from "@/app/route/[pair]/not-found";

describe("/route/<pair> not-found", () => {
  it("renders the wordmark and DATA AS OF, not Next's bare 404", async () => {
    const { container } = render(await NotFoundView({ pathname: "/route/ZZZZ-LAX" }));
    // Fails if the wordmark markup regresses or is dropped -- getByText can't see "UPGAUGE"
    // as one string (the "GAUGE" half lives in a nested span; explore/page.test.tsx's own
    // header comment documents why getByText only reads a node's OWN text), so this checks
    // the DOM directly instead of guessing at a text match that would silently never fire.
    expect(container.querySelector(".mark")?.textContent).toBe("UPGAUGE");
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  // The promise four doc sites make is "404s naming the offending CODE", not the pair. For
  // ZZZZ-LAX a reader must be told that ZZZZ is the problem -- naming the whole pair leaves
  // them to guess which half. Each case below asserts the discriminating phrase AND the
  // absence of a sibling case's phrase, because the failure mode being guarded is a fallback
  // to one generic sentence that enumerates all three causes for every 404: that sentence
  // would satisfy any single positive assertion here.
  it("names the unknown half of the pair, not the pair", async () => {
    render(await NotFoundView({ pathname: "/route/ZZZZ-LAX" }));
    // Fails if resolveRoutePair's `reason` stops reaching the page (the previous version
    // discarded it), or if the page renders the pair generically instead.
    expect(screen.getByText(/unknown airport code 'ZZZZ'/)).toBeDefined();
    expect(screen.queryByText(/domestic-only/)).toBeNull();
  });

  it("distinguishes a real airport this domestic-only dataset has no rows for", async () => {
    // LHR resolves in dim_airport's global master roster but carries no fct_segment_month
    // row (CLAUDE.md's "Segment only" rule). airportCodesExist() is what tells this apart
    // from a typo, and until this fix nothing rendered the distinction it computed.
    render(await NotFoundView({ pathname: "/route/JFK-LHR" }));
    expect(screen.getByText(/'LHR' is a recognized airport code/)).toBeDefined();
    expect(screen.getByText(/domestic-only/)).toBeDefined();
    expect(screen.queryByText(/unknown airport code/)).toBeNull();
  });

  it("names a self-route as such rather than as an unknown code", async () => {
    render(await NotFoundView({ pathname: "/route/LAX-LAX" }));
    expect(screen.getByText(/'LAX' to itself is not a route/)).toBeDefined();
    expect(screen.queryByText(/unknown airport code/)).toBeNull();
  });

  it("names a malformed slug as malformed", async () => {
    render(await NotFoundView({ pathname: "/route/JFK" }));
    expect(screen.getByText(/expected two airport codes joined by/)).toBeDefined();
  });

  it("still shows the requested slug alongside the reason", async () => {
    render(await NotFoundView({ pathname: "/route/ZZZZ-LAX" }));
    expect(screen.getByText(/ZZZZ-LAX/)).toBeDefined();
  });

  it("offers a way back into a working page", async () => {
    render(await NotFoundView({ pathname: "/route/ZZZZ-LAX" }));
    expect(screen.getByRole("link", { name: /JFK.LAX/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Explorer/i })).toBeDefined();
  });

  // The last line of defence for the case this file's previous version could not see: a
  // pathname that is not a /route/ page at all (or a proxy that starts sending something
  // else). Must degrade to a page that still renders, never throw a 500 out of a 404.
  //
  // Fix wave 3, item 6: the first line used to be `getByRole("alert")` alone, which the
  // component's own unconditional `<p role="alert">` guarantees -- it could not fail, so the
  // negative half was carrying the whole test. It now asserts the alert's exact TEXT, which
  // is the branch's actual output. That fails if the ternary in not-found.tsx grows a
  // fallback (rendering the raw pathname, or an empty sentence, for a non-/route path), if
  // `reasonFor` stops returning null when `routeSlugFromPath` finds no slug, or if the
  // generic sentence is reworded without anyone revisiting this case.
  it("falls back to a generic message when the path is not a route page", async () => {
    render(await NotFoundView({ pathname: "/somewhere/else" }));
    expect(screen.getByRole("alert").textContent).toBe("We don’t recognize this page.");
    expect(screen.queryByText(/unknown airport code/)).toBeNull();
  });
});
