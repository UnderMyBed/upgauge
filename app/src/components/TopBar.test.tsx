// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopBar } from "@/components/TopBar";

const GLOBALS_CSS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../app/globals.css",
);

const SOURCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "TopBar.tsx");

describe("TopBar", () => {
  it("renders the wordmark's UP/GAUGE split with the accent span", () => {
    // The exact bytes smoke.sh and every entity page's own test already depend on --
    // see task-2-report.md's diff of the ten pre-extraction copies. Selector is `.mark`
    // (class only), not `span.mark`: F5 (final whole-branch review) made the wordmark an
    // `<a>` so there is a link back to the front door from any entity page -- the class and
    // its CSS are unchanged, only the tag.
    const { container } = render(<TopBar asOf="2026-04" />);
    const mark = container.querySelector(".mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("UPGAUGE");
    const accent = mark?.querySelector("span.accent");
    expect(accent).not.toBeNull();
    expect(accent?.textContent).toBe("GAUGE");
  });

  it("renders the DATA AS OF badge with the given month", () => {
    // app/smoke.sh greps every page's served bytes for the literal string 'DATA AS OF' --
    // this is the one place that string is now written.
    render(<TopBar asOf="2026-04" />);
    expect(screen.getByText("DATA AS OF 2026-04")).toBeDefined();
  });

  it("posts the search form to /search over GET", () => {
    // Mutant (task-2 brief, Step 5): drop `action="/search"` and this goes red.
    const { container } = render(<TopBar asOf="2026-04" />);
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(form?.getAttribute("method")).toBe("GET");
    expect(form?.getAttribute("action")).toBe("/search");
  });

  it("carries a named text input the form can submit without JS", () => {
    // Task 4's /search reads `q` off the query string -- the name has to match, and it must
    // be a real submittable field (not type="hidden") for a no-JS GET to carry it at all.
    const { container } = render(<TopBar asOf="2026-04" />);
    const input = container.querySelector('form input[name="q"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute("type")).not.toBe("hidden");
  });

  // Final whole-branch review, F5: once a visitor is on any entity page there was no link
  // back to the front door -- the wordmark rendered as a bare <span>. This makes it an
  // <a href="/">, the same "connect the graph" fix as the route title-block links above.
  it("makes the wordmark a link back to the front door", () => {
    const { container } = render(<TopBar asOf="2026-04" />);
    const link = container.querySelector("a.mark");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/");
    expect(link?.textContent).toBe("UPGAUGE");
  });

  // Final whole-branch review (M6), Important #2: /watch had ZERO inbound internal links --
  // nothing in app/src outside app/watch/, lib/watch.ts, proxy.ts and sitemap.ts referenced it,
  // so it was reachable only by typing the URL or through /sitemap.xml. That is the identical
  // "crawlable but not browsable" island M5's own final review named and fixed for the entity
  // pages (docs/product/features.md), re-created one milestone later. This test is what makes
  // removing the link a red build rather than a silent regression: the top bar is the one
  // surface every page renders, so this single assertion covers all eleven.
  it("links to /watch from every page", () => {
    const { container } = render(<TopBar asOf="2026-04" />);
    const link = container.querySelector('nav.nav a[href="/watch"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("Watch");
  });

  it("does not prefetch /watch", () => {
    // Same reasoning the wordmark's own `prefetch={false}` carries, and the same reason it is
    // load-bearing rather than a micro-optimisation: this link is above the fold on all eleven
    // pages, and `/watch` is `force-dynamic` with a `dataAsOf()` query per request. Next's
    // default (`auto`) would fire one origin request per page view. Read off the SOURCE, not
    // the DOM: `prefetch` is a `Link` prop that leaves no attribute on the rendered <a>.
    const source = readFileSync(SOURCE_PATH, "utf-8");
    expect(source).toMatch(/<Link\s+href="\/watch"\s+prefetch=\{false\}>/);
  });

  it("is a Server Component: no client directive, no onChange, no useState", () => {
    // Every other view in this product works with JS off (app/AGENTS.md). Reading the
    // source rather than the render output is deliberate -- rendering with
    // @testing-library/react can't tell a Server Component from a Client one; only the
    // absence of the directive and the hooks that require it can.
    const source = readFileSync(SOURCE_PATH, "utf-8");
    expect(source).not.toMatch(/^["']use client["'];?$/m);
    // `\bonChange=` / `\buseState\(` -- real usage, not this file's own prose (the header
    // comment names both by their bare identifier while explaining why they're absent).
    expect(source).not.toMatch(/\bonChange=/);
    expect(source).not.toMatch(/\buseState\(/);
  });
});

// Final whole-branch review, M8: at 375px `.top`'s three children (`.mark`, `.search`,
// `.asof`) totalled more than the available width -- `.mark`/`.asof` are both
// `white-space: nowrap` and refuse to shrink, and neither `.top` nor `.top .search button` had
// anything that would make them wrap -- so `.wrap`'s lack of an `overflow` rule let the page
// BODY scroll horizontally, against the stated rule that only a table scrolls in its own
// container. Verified on a served dev build at 375px with headless Chrome (jsdom computes no
// layout, so no unit test could see the overflow itself): `flex-wrap: wrap` alone stopped the
// body scroll but left the search field compressed onto the same line as `.asof`, overlapping
// it -- `.top .search`'s `min-width: 0` let it shrink further than its own children (the
// button has no `min-width: 0`) could actually render, so the "fits" the wrap algorithm
// computed was wrong. A non-zero floor on `.top .search` is what makes the wrap decision
// correct: the form moves to its own line instead of overlapping. Same weak-but-honest
// precedent as DataTable.test.tsx's stylesheet test: jsdom cannot verify layout, only that the
// rule is written.
describe("globals.css keeps .top from forcing the page body to scroll horizontally", () => {
  const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

  it("lets .top wrap onto multiple lines instead of overflowing", () => {
    const rule = css.match(/\.top\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toMatch(/flex-wrap:\s*wrap/);
  });

  it("gives .top .search a real minimum width, not 0, so it wraps rather than overlapping .asof", () => {
    const rule = css.match(/\.top \.search\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    const body = rule![0];
    expect(body).toMatch(/min-width:\s*[1-9]\d*px/);
  });
});
