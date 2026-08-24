import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every bespoke class name a component renders has a rule in globals.css.
 *
 * This gate exists because the gap has now shipped THREE times, each caught by a person
 * looking at the page rather than by anything in CI:
 *
 *   1. `.search-results` -- see its own comment in globals.css.
 *   2. `.frame` and `.watch-list` in M6 -- globals.css:469 records that Tailwind's preflight
 *      collapsed them to 16px body text and a default bulleted <ul>, so "the only place on
 *      the site with a voice" rendered less distinguished than the .foot notes beneath it.
 *   3. `.map` and `.year-track` in M7 -- the airport network map's landmass fell back to
 *      SVG's initial `fill`, which is BLACK, and the year track rendered as one run-on
 *      string ("Trailing 12 months201520162017...") because 13 adjacent <a> elements are
 *      emitted with no whitespace between them and nothing supplied a gap.
 *
 * Tailwind's own utilities are generated, not written here, so they are allow-listed by name
 * rather than by pattern -- a pattern would also excuse a typo'd bespoke name.
 *
 * SCOPE, stated so it is not mistaken for more than it is: this scans literal
 * `className="..."` attributes only. A class name assembled in an expression is invisible
 * to it. That covers every bespoke name this app uses today; if that changes, this gate
 * needs widening rather than trusting.
 */
const TAILWIND_UTILITIES = new Set(["flex", "flex-col", "font-sans", "font-mono", "min-h-full"]);

const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
const SRC = path.join(ROOT, "app", "src");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith(".tsx") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

function definedClasses(): Set<string> {
  const css = readFileSync(path.join(SRC, "app", "globals.css"), "utf8");
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

function usedClasses(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const file of tsxFiles(SRC)) {
    const rel = path.relative(SRC, file);
    for (const m of readFileSync(file, "utf8").matchAll(/className="([^"{]+)"/g)) {
      for (const name of m[1].split(/\s+/).filter(Boolean)) {
        if (!used.has(name)) used.set(name, new Set());
        used.get(name)!.add(rel);
      }
    }
  }
  return used;
}

describe("globals.css covers every bespoke class a component renders", () => {
  it("leaves no class name without a rule", () => {
    const defined = definedClasses();
    const missing = [...usedClasses()]
      .filter(([name]) => !TAILWIND_UTILITIES.has(name) && !defined.has(name))
      .map(([name, files]) => `.${name} (${[...files].sort().join(", ")})`)
      .sort();
    expect(missing).toEqual([]);
  });

  it("styles the basemap, so the landmass never falls back to SVG's black default", () => {
    // The specific regression: `<path data-panel="us" ...>` carries NO presentation
    // attributes, and the <svg> root sets no fill either, so without a rule here every state
    // polygon renders solid #000 with near-black arcs stroked on top of it.
    const css = readFileSync(path.join(SRC, "app", "globals.css"), "utf8");
    expect(css).toMatch(/path\[data-panel\]/);
  });

  it("gives the year track a gap, since the anchors are emitted with no whitespace", () => {
    const css = readFileSync(path.join(SRC, "app", "globals.css"), "utf8");
    const rule = /\.year-track\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/gap\s*:/);
  });
});
