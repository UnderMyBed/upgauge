// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

// Final whole-branch review, M4: aircraftExactHits' AmbiguousCodeError path (lib/search.ts)
// gives CE-180's two hits the SAME `href` ("/aircraft/CE-180" -- code 030 CESSNA 180 and code
// 031 CESSNA 180A/B share one short name), and ResultsBody keyed its <li> on `h.href` alone --
// `<li key={h.href}>` -- so /search?q=CE-180 rendered two React list items under one duplicate
// key. React logs this to console.error in development; production behaviour is silently
// undefined on updates (a reconciliation keyed on a colliding key can drop or misapply state
// to the wrong element). Spies on console.error rather than inspecting the DOM directly,
// because a duplicate key does not necessarily change what is PAINTED on first mount -- it is
// exactly the class of bug @testing-library's assertions cannot see without this.
describe("/search -- ambiguous single-namespace code (CE-180 shape)", () => {
  it("renders both CE-180 candidates without a duplicate-key warning", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = render(await SearchView({ q: "CE-180" }));
      expect(container.textContent).toContain("BTS aircraft type 030");
      expect(container.textContent).toContain("BTS aircraft type 031");
      const keyWarning = spy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("same key")),
      );
      expect(keyWarning).toBe(false);
    } finally {
      spy.mockRestore();
    }
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

// Final whole-branch review, F2: `.search-results` / `.search-group` have no rule anywhere in
// globals.css. Tailwind's preflight resets `a { color: inherit; text-decoration: inherit }`
// and `h1..h6 { font-size: inherit; font-weight: inherit }`, so every link on /search --
// including the ones Task 3 already fixed on .data-table -- was rendering as plain 16px text
// indistinguishable from its neighbours. `.foot a` (the "Open in the Explorer" links on all
// four entity pages, and /search's own truncation footer) had the identical gap and predates
// M5.
//
// Same precedent, same limits, as DataTable.test.tsx's ".data-table td.id a" test just above
// this comment's sibling file: jsdom computes no styles (no layout engine), so this only
// proves the selector and a non-colour channel are IN THE STYLESHEET, not that a browser
// paints them as intended -- deliberately weak, stated here rather than implied. It cannot
// catch a specificity fight with a later rule, and it cannot catch anything about paint.
describe("globals.css styles /search's and .foot's links with a non-colour channel", () => {
  const globalsCssPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../globals.css",
  );
  const css = readFileSync(globalsCssPath, "utf8");

  it("styles a .search-results link", () => {
    const rule = css.match(/\.search-results[^{},]*a\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    const body = rule![0];
    expect(body).toMatch(/color:\s*var\(--signal\)/);
    // Colour is never the sole channel (docs/design/system.md, Quality floor).
    expect(body).toMatch(/text-decoration:\s*underline/);
  });

  it("styles a .foot link (the four entity pages' 'Open in the Explorer' links too)", () => {
    const rule = css.match(/\.foot a\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    const body = rule![0];
    expect(body).toMatch(/color:\s*var\(--signal\)/);
    expect(body).toMatch(/text-decoration:\s*underline/);
  });
});
