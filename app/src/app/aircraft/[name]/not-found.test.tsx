// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
// No mocks: the page is a Server Component taking the pathname as a prop (from proxy.ts's
// RAW_PATH_HEADER, see lib/rawPath.ts) and re-running the REAL resolveAircraftSlug against the
// REAL database, exactly as route/[pair]/not-found.test.tsx does.
import { NotFoundView } from "@/app/aircraft/[name]/not-found";
import { decode } from "@/lib/pivot/urlstate";
import { loadAllowlist } from "@/lib/db";

describe("/aircraft/<slug> not-found", () => {
  it("renders the wordmark and DATA AS OF, not Next's bare 404", async () => {
    const { container } = render(await NotFoundView({ pathname: "/aircraft/NOPE-1" }));
    expect(container.querySelector(".mark")?.textContent).toBe("UPGAUGE");
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("names the short name it could not resolve", async () => {
    render(await NotFoundView({ pathname: "/aircraft/NOPE-1" }));
    expect(screen.getByText(/unknown aircraft type 'NOPE-1'/)).toBeDefined();
  });

  it("names an over-separated slug as such rather than as an unknown type", async () => {
    // A different resolveAircraftSlug reason, so a regression that special-cased only the
    // unknown-type message would still be caught. Also the branch that must NOT reach the
    // database: 3^n candidates.
    render(await NotFoundView({ pathname: "/aircraft/A-B-C-D-E-F" }));
    expect(screen.getByText(/more than 4 separators/)).toBeDefined();
    expect(screen.queryByText(/unknown aircraft type/)).toBeNull();
  });

  it("names BOTH airframes for a slug that identifies two, and links to each", async () => {
    // THE case Task 1 built AmbiguousCodeError's structured `ids` for. CE-180 is the short name
    // of BTS code 030 (CESSNA 180) and code 031 (CESSNA 180A/B); both really flew and no scoping
    // resolves it. Rendering one of them would be the AUS bug -- an entity page confidently
    // displaying whichever row the driver happened to return last.
    const { container } = render(await NotFoundView({ pathname: "/aircraft/CE-180" }));
    const text = container.textContent ?? "";
    expect(text).toContain("CESSNA 180A/B");
    // The full designations are what distinguish them; the codes are what the Explorer needs.
    expect(text).toContain("030");
    expect(text).toContain("031");

    // Each candidate carries a WORKING permalink to its own rows -- the Explorer is keyed on
    // the BTS code, so it can show what this page cannot. Round-tripped through the real
    // decode(), so a link that lost the filter, or int-parsed the code, fails here.
    // Scoped to the candidate list: the recovery paragraph at the foot of every 404 also links
    // into the Explorer, and an unscoped selector would count it as a third candidate.
    const links = [...container.querySelectorAll('ul a[href^="/explore?"]')];
    expect(links).toHaveLength(2);
    const filters = await Promise.all(
      links.map(
        async (a) =>
          decode(a.getAttribute("href")!.slice("/explore?".length), await loadAllowlist()).filters,
      ),
    );
    // In code order, not in the order the driver returned the rows in: the page sorts, so the
    // same URL lists the two airframes the same way every time.
    expect(filters).toEqual([[["aircraft_type", ["030"]]], [["aircraft_type", ["031"]]]]);
  });

  it("does not offer a resolution it does not have", async () => {
    // Falsifiable against the failure this whole branch exists to avoid: a page that picked one
    // of the two and linked to it as though it were the answer.
    render(await NotFoundView({ pathname: "/aircraft/CE-180" }));
    expect(screen.getByText(/names more than one aircraft type/i)).toBeDefined();
    expect(screen.queryByRole("link", { name: /^\/aircraft\/CE-180$/ })).toBeNull();
  });

  it("echoes the slug exactly as requested, not the resolver's canonical form", async () => {
    // Task 3's finding, closed on this page. Every OTHER assertion in this file reads the
    // resolver's REASON sentence, which carries `slugFor(trimmed)` -- the UPPERCASED slug -- so
    // a mutant that replaced the displayed slug with the canonical form, or with a hard-coded
    // literal, survived all of them.
    //
    // '/aircraft/nope-1' is the input that separates the two: the page must echo 'nope-1' (what
    // was typed) while the reason names 'NOPE-1' (what the resolver looked up). Both are asserted
    // inside the alert's own textContent -- an unscoped query would find 'NOPE-1' in the h1 or
    // the recovery link and pass for the wrong reason.
    const { container } = render(await NotFoundView({ pathname: "/aircraft/nope-1" }));
    const alert = container.querySelector("p[role='alert']")?.textContent ?? "";
    expect(alert).toContain("nope-1");
    expect(alert).toContain("'NOPE-1'");
  });

  it("offers a way back into a working page", async () => {
    render(await NotFoundView({ pathname: "/aircraft/NOPE-1" }));
    expect(screen.getByRole("link", { name: /B737-8/ })).toBeDefined();
  });

  it("falls back to a generic message when the path is not an aircraft page", async () => {
    // Must degrade to a page that still renders, never throw a 500 out of a 404 -- the last
    // line of defence if proxy.ts's matcher ever sends something else here.
    render(await NotFoundView({ pathname: "/somewhere/else" }));
    expect(screen.getByRole("alert").textContent).toBe("We don’t recognize this page.");
    expect(screen.queryByText(/unknown aircraft type/)).toBeNull();
  });
});
