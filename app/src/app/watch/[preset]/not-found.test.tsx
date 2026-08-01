// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotFoundView } from "@/app/watch/[preset]/not-found";

// No mocks: the view takes the pathname as a prop (proxy.ts's RAW_PATH_HEADER, lib/rawPath.ts)
// exactly as every other entity page's not-found does -- Next's `not-found.js` convention
// accepts no props, so the header is the only channel that carries the requested slug here.

describe("/watch/<preset> not-found", () => {
  it("renders the wordmark and DATA AS OF, not Next's bare 404", async () => {
    const { container } = render(await NotFoundView({ pathname: "/watch/nope" }));
    expect(container.querySelector(".mark")?.textContent).toBe("UPGAUGE");
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("names the offending preset slug", async () => {
    // Curly quotes, not straight ones -- this page renders the slug through `&lsquo;…&rsquo;`
    // with no resolver "reason" string to fall back on (unlike the entity pages' not-found
    // views, whose reason text happens to carry straight quotes -- see those tests' own
    // comments). The alert's full text is asserted rather than matched against a literal quote
    // glyph, which is what actually distinguishes "names this slug" from "names some slug".
    render(await NotFoundView({ pathname: "/watch/nope" }));
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("nope");
  });

  it("names a DIFFERENT offending slug differently", async () => {
    render(await NotFoundView({ pathname: "/watch/bogus" }));
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("bogus");
    expect(alert).not.toContain("nope");
  });

  it("lists all four valid presets as a way out", async () => {
    render(await NotFoundView({ pathname: "/watch/nope" }));
    expect(screen.getByRole("link", { name: /Gauge Watch/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Empty Planes/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Route Birth Tracker/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Route Death Watch/ })).toBeDefined();
  });

  it("degrades to a generic sentence for a non-watch path", async () => {
    render(await NotFoundView({ pathname: "/explore" }));
    expect(screen.getByText(/don’t recognize this page/)).toBeDefined();
  });
});
