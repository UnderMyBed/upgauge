// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopBar } from "@/components/TopBar";

const SOURCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "TopBar.tsx");

describe("TopBar", () => {
  it("renders the wordmark's UP/GAUGE split with the accent span", () => {
    // The exact bytes smoke.sh and every entity page's own test already depend on --
    // see task-2-report.md's diff of the ten pre-extraction copies.
    const { container } = render(<TopBar asOf="2026-04" />);
    const mark = container.querySelector("span.mark");
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
