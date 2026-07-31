// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotFoundView } from "@/app/carrier/[code]/not-found";

// No mocks: the view takes the pathname as a prop (from proxy.ts's RAW_PATH_HEADER, see
// lib/rawPath.ts and lib/carrier.ts) and re-runs the REAL resolveCarrier against the REAL
// database, exactly as the /route 404 page does. Next's `not-found.js` convention accepts no
// props and no route params, so the header is the only channel that carries the requested
// code to this render -- and a 404 page that silently stops naming the code, with every gate
// green, is the failure that header exists to make impossible.

describe("/carrier/<code> not-found", () => {
  it("renders the wordmark and DATA AS OF, not Next's bare 404", async () => {
    const { container } = render(await NotFoundView({ pathname: "/carrier/ZZ" }));
    expect(container.querySelector(".mark")?.textContent).toBe("UPGAUGE");
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("names the offending code", async () => {
    render(await NotFoundView({ pathname: "/carrier/ZZ" }));
    expect(screen.getByText(/'ZZ'/)).toBeDefined();
  });

  it("names a DIFFERENT offending code differently", async () => {
    // The failure mode being guarded is a generic sentence that names no code at all, or one
    // that names a hard-coded example. Both satisfy "the page contains a code"; neither
    // survives being asked about two.
    render(await NotFoundView({ pathname: "/carrier/PA" }));
    expect(screen.getByText(/'PA'/)).toBeDefined();
    expect(screen.queryByText(/'ZZ'/)).toBeNull();
  });

  it("says what actually failed, in the resolver's own words", async () => {
    // Not a generic "not found": the sentence a reader needs is that nothing has FILED under
    // this code, which is the true statement for both a typo and a real-but-never-filed
    // carrier like PA.
    render(await NotFoundView({ pathname: "/carrier/PA" }));
    expect(screen.getByText(/has filed a T-100 Segment row/)).toBeDefined();
  });

  it("echoes the slug exactly as requested, not the resolver's canonical form", async () => {
    // Found by mutation, not by reading: a mutant that replaced the DISPLAYED slug with a
    // hard-coded literal survived both tests above. Both of them match `/'ZZ'/`, and the only
    // node in this page whose own text carries straight quotes is the resolver's REASON --
    // the slug sits in its own text node between two typographic quotes, so neither test was
    // ever looking at it.
    //
    // '/carrier/zz' separates the two: the page echoes 'zz' (what was typed) while the reason
    // names 'ZZ' (resolveCarrier uppercases before looking up). A page that reprinted the
    // reason's code, or hard-coded an example, has no lower-case 'zz' anywhere in it.
    const { container } = render(await NotFoundView({ pathname: "/carrier/zz" }));
    const alert = container.querySelector("p[role='alert']")?.textContent ?? "";
    expect(alert).toContain("zz");
    expect(alert).toContain("'ZZ'");
  });

  it("offers a way out", async () => {
    render(await NotFoundView({ pathname: "/carrier/ZZ" }));
    expect(screen.getByRole("link", { name: /DL|Delta/ })).toBeDefined();
  });

  it("degrades to a generic sentence rather than a wrong one for a non-carrier path", async () => {
    // Unreachable in practice (this file renders only because the carrier page threw
    // notFound()), but not asserted away: a pathname this route cannot parse must not produce
    // a sentence with an empty code in it.
    render(await NotFoundView({ pathname: "/explore" }));
    expect(screen.getByText(/don’t recognize this page/)).toBeDefined();
  });
});
