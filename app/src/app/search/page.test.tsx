// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import SearchPage, { SearchView, metadata } from "@/app/search/page";

/** `redirect()` throws rather than returns -- same helper, same reasoning, as
 * route/[pair]/page.test.tsx's `catchDigest`, but driving the DEFAULT export (which reads
 * `searchParams`) rather than `SearchView` directly, so this also exercises the
 * string/array/undefined folding `SearchPage` does before handing `q` to `SearchView`. */
async function catchDigest(searchParams: { q?: string | string[] }): Promise<string> {
  try {
    await SearchPage({ searchParams: Promise.resolve(searchParams) });
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "digest" in e && typeof e.digest === "string") {
      return e.digest;
    }
    throw e;
  }
  throw new Error(`SearchPage(${JSON.stringify(searchParams)}) did not throw`);
}

describe("/search -- unique exact match redirects (step 1a)", () => {
  it("redirects an airport code, temporarily (307), not permanently", async () => {
    // 307, not 308: unlike /carrier/dl -> /carrier/DL this is not a second spelling of one
    // fixed canonical URL, it's a resolution over live data that could in principle change.
    // Source-verified digest shape, same as route/[pair]/page.test.tsx: next/navigation's
    // redirect() throws `NEXT_REDIRECT;replace;<url>;307;`.
    const digest = await catchDigest({ q: "PDX" });
    expect(digest).toBe("NEXT_REDIRECT;replace;/airport/PDX;307;");
  });

  it("redirects a carrier code", async () => {
    const digest = await catchDigest({ q: "DL" });
    expect(digest).toBe("NEXT_REDIRECT;replace;/carrier/DL;307;");
  });

  it("redirects an aircraft slug", async () => {
    const digest = await catchDigest({ q: "B737-8" });
    expect(digest).toBe("NEXT_REDIRECT;replace;/aircraft/B737-8;307;");
  });

  it("redirects a route pair to the code-alphabetical URL", async () => {
    const digest = await catchDigest({ q: "PDX-AUS" });
    expect(digest).toBe("NEXT_REDIRECT;replace;/route/AUS-PDX;307;");
  });

  it("folds a repeated ?q= to its first value rather than rejecting it", async () => {
    const digest = await catchDigest({ q: ["PDX", "DL"] });
    expect(digest).toBe("NEXT_REDIRECT;replace;/airport/PDX;307;");
  });
});

describe("/search rendering", () => {
  it("shows DATA AS OF, same as every other view", async () => {
    render(await SearchView({ q: "Portland" }));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("renders the search field, since TopBar is the shared chrome (M5 Task 2)", async () => {
    render(await SearchView({ q: "Portland" }));
    expect(screen.getByRole("searchbox")).toBeDefined();
  });
});

describe("/search -- a code in two namespaces does not redirect, and shows both (step 1b)", () => {
  it("LNY lists the airport and the carrier, each linking to its own page", async () => {
    const { container } = render(await SearchView({ q: "LNY" }));
    expect(container.textContent).toContain("Lanai Airport");
    expect(container.textContent).toContain("Western Aircraft, dba Lanai Air");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/airport/LNY");
    expect(hrefs).toContain("/carrier/LNY");
  });
});

describe("/search -- name substring, across states (step 1c)", () => {
  it("Portland lists all four airports, PWM included", async () => {
    const { container } = render(await SearchView({ q: "Portland" }));
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const code of ["HIO", "PDX", "PWM", "TTD"]) {
      expect(hrefs).toContain(`/airport/${code}`);
    }
    expect(container.textContent).toContain("Portland International Jetport");
  });
});

describe("/search -- ranking (step 1d)", () => {
  it("lists AS (Alaska Airlines) before DUT (Unalaska), matching search()'s ranked order", async () => {
    const { container } = render(await SearchView({ q: "Alaska" }));
    const text = container.textContent ?? "";
    const asPos = text.indexOf("Alaska Airlines Inc.");
    const dutPos = text.indexOf("Unalaska Airport");
    expect(asPos).toBeGreaterThan(-1);
    expect(dutPos).toBeGreaterThan(-1);
    expect(asPos).toBeLessThan(dutPos);
  });
});

describe("/search -- states (step 1e)", () => {
  it("empty query renders worked examples, not an error", async () => {
    const { container } = render(await SearchView({ q: "" }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("PDX");
    expect(container.textContent).toContain("B737-8");
  });

  it("no match names the query and offers the Explorer", async () => {
    render(await SearchView({ q: "zzzznotarealthing9999" }));
    expect(screen.getByText(/zzzznotarealthing9999/)).toBeDefined();
    expect(screen.getByRole("link", { name: /known-valid query/i })).toBeDefined();
  });

  it("discloses the cap and the true count when a substring search is truncated", async () => {
    // 'air' returns 423 of the 1,271 fact-present rows (measured), comfortably over
    // SEARCH_RESULT_CAP -- exercises the real disclosure path, not a synthetic fixture.
    const { container } = render(await SearchView({ q: "air" }));
    const foot = container.querySelector(".foot")?.textContent ?? "";
    expect(foot).toMatch(/first 50/);
    expect(foot).toMatch(/423/);
  });

  it("does not disclose truncation under the cap", async () => {
    const { container } = render(await SearchView({ q: "Portland" }));
    expect(container.querySelector(".foot")).toBeNull();
  });
});

describe("/search metadata (step 1f)", () => {
  it("carries robots: noindex", () => {
    // Next.js maps `{ index: false }` to `<meta name="robots" content="noindex">`
    // (node_modules/next/dist/docs/.../generate-metadata.md's own `robots` example) -- Task 8
    // curl-verifies the served tag; this pins the config this codebase owns.
    expect(metadata.robots).toEqual({ index: false });
  });
});
