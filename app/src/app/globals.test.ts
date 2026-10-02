import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIT_BREAKPOINTS, FIT_VIEW_W, FITS, type Fit } from "@/lib/chart/fit";

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

/**
 * Every grid track is bounded: a fixed length, a percentage, or `minmax(0, ...)`.
 *
 * `1fr` is shorthand for `minmax(auto, 1fr)`, and that `auto` is a CONTENT-BASED minimum --
 * a grid item whose `overflow` is `visible` contributes its own min-content width as the
 * track's floor. So a bare `1fr` column holding a wide table cannot shrink below that table:
 * the track inflates to the table, `.wrap` inflates to the track, and the PAGE BODY is what
 * scrolls -- which docs/design/system.md's Quality floor forbids. `.table-scroll` is handed
 * exactly its own content width and so never scrolls at all.
 *
 * That shipped (#125). `.body`'s desktop rule wrote `minmax(0, 1fr) 214px` and its own
 * `max-width: 920px` override rewrote the track list as a bare `1fr`, dropping the guard the
 * desktop rule exists to carry.
 *
 * THE MEASUREMENTS LIVE IN ONE PLACE: docs/design/system.md, "Layout and density". The sweep,
 * the widths and the residual floor are stated there and deliberately not restated here -- a
 * second copy goes stale on its own and nothing binds it back. What matters at THIS site is the
 * SHAPE of the finding: the failure width is not a constant. It is the widest RENDERED table's
 * min-content, so it moves with the query string, and no media query can bound a threshold the
 * URL chooses. That is why this is a rule about tracks and not a breakpoint.
 *
 * WHAT THIS ASSERTS AND WHAT IT DOES NOT. It asserts the MECHANISM in the stylesheet, not the
 * rendered layout. The property that actually matters -- `document.body.scrollWidth <=
 * document.body.clientWidth` at every width -- cannot be asserted by this harness: the app's
 * only DOM is jsdom, which implements no layout, so `scrollWidth` is always 0. There is no
 * browser in app/package.json, and adding one would change every `npm ci` for every developer
 * and every CI job that installs, which is a cost this project does not carry. `make
 * app-smoke` carries the other half -- that this guard survives Tailwind + Lightning CSS
 * minification and reaches the browser -- but that is a byte assertion too.
 *
 * In exchange it prevents the CLASS rather than the instance: it is red for a bare `1fr` or
 * `auto` track on any selector in this file, including grids nobody has written yet.
 *
 * SCOPE. `grid-template-columns` only, since the defect is horizontal. TWO shorthands also set
 * that property -- `grid-template` and the strictly more general `grid` -- so both are refused
 * outright rather than parsed. Naming one and leaving its superset open is a gap in the CLAIM
 * and not only in coverage, which is the whole point of a gate that says it prevents the class:
 * `grid: auto-flow / auto 1fr` passed this test until it was closed. `grid-auto-columns` sizes
 * IMPLICIT tracks and is the same class at lower risk -- nothing here creates implicit columns
 * today; give it the same treatment if that changes.
 *
 * The gate is DELIBERATELY STRICT and rejects shapes that would be perfectly safe:
 * `repeat(2, minmax(0, 1fr))`, `[line-name]` syntax, `calc()`, `var()`, `minmax(200px, 1fr)`.
 * None is recognised, each is fine, and the right response to needing one is to widen the
 * classifier -- not to relax it. An expression it cannot classify FAILS rather than passing
 * quietly, because a gate that waves through what it does not understand is not a gate.
 *
 * All of it runs on the stylesheet with COMMENTS STRIPPED -- see `withoutComments` for why a
 * correct file otherwise fails.
 */

/** Comments in this file QUOTE rules as prose -- globals.css's own `.body` block opens by
 *  citing docs/design/system.md: `Main grid: minmax(0,1fr) 214px with a 24px gap`. That reads
 *  as a `grid:` declaration to any regex, and it is not one. Strip comments before asserting
 *  anything, which also stops the track parser below being fed a quoted rule as if it were
 *  live. Found by this assertion going red against a correct stylesheet. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Split a track list on top-level whitespace, so `minmax(0, 1fr)` stays a single track. */
function splitTracks(value: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) tracks.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) tracks.push(cur);
  return tracks;
}

/** No content-based minimum: a fixed length, a percentage, or an explicit `minmax(0, ...)`. */
const BOUNDED_TRACK =
  /^(?:\d*\.?\d+(?:px|rem|em|ch|vw|vh)|\d*\.?\d+%|minmax\(\s*0(?:px)?\s*,[^)]+\))$/;

/** Minimum is the item's own content -- the thing that pushes the track past the viewport. */
const CONTENT_MINIMUM =
  /^(?:\d*\.?\d+fr|auto|min-content|max-content|fit-content\(.*\)|minmax\(\s*(?:auto|min-content|max-content)\s*,.*\))$/;

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

  it("gives the builder chip rows a gap, since the chips are emitted with no whitespace", () => {
    const css = readFileSync(path.join(SRC, "app", "globals.css"), "utf8");
    for (const selector of [/\.chip-row\s*\{([^}]*)\}/, /\.chip-set\s*\{([^}]*)\}/]) {
      const rule = selector.exec(css);
      expect(rule).not.toBeNull();
      expect(rule![1]).toMatch(/gap\s*:/);
    }
  });

  it("gives chips tabular figures, since LimitControl and the year track render numerics", () => {
    // CLAUDE.md: all numerics monospaced AND tabular-figure. `.chip` set the mono family and
    // stopped there, while LimitControl renders 25/50/100/250/1000 and WindowControl a year
    // track -- proportional digits inside a mono family, so the track shifts as the year moves.
    // Asserted on the `.chip` rule specifically: a page-wide search for the property would be
    // satisfied by any of the five other blocks that already set it.
    const css = withoutComments(readFileSync(path.join(SRC, "app", "globals.css"), "utf8"));
    const rule = /\.chip\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/font-variant-numeric\s*:[^;]*\btabular-nums\b/);
  });

  it("distinguishes an unreachable chip by more than colour", () => {
    // COMMENTS STRIPPED, like the grid gate two tests below and for the same reason: this file's
    // rules are quoted as prose in its own comments, so a `.chip-off { ... }` block described in
    // a comment satisfies the regex while the live rule carries nothing. A stylesheet gate that
    // a comment can spoof is not a gate.
    const css = withoutComments(readFileSync(path.join(SRC, "app", "globals.css"), "utf8"));
    const rule = /\.chip-off\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    // Asserts the VALUE, not merely that the property is declared: `text-decoration: none` still
    // matches a bare `text-decoration\s*:` and would remove the only non-colour channel this rule
    // exists to guarantee, which is exactly what this test's own name forbids.
    //
    // `text-decoration-line` is accepted too. The longhand is the identical guarantee, and a gate
    // that fails a correct refactor teaches people to delete the gate -- the strictness that is
    // worth keeping is on the VALUE (`line-through`), not on which of two spellings sets it.
    expect(rule![1]).toMatch(/text-decoration(-line)?\s*:[^;]*\bline-through\b/);
  });

  it("bounds every grid track, so a wide table can never widen the page body", () => {
    const css = withoutComments(readFileSync(path.join(SRC, "app", "globals.css"), "utf8"));

    // Both shorthands set grid-template-columns and would carry a track list straight past the
    // parser below. `[^-\w]` is what keeps the second off `grid-template-columns:`,
    // `grid-auto-columns:` and `display: grid;` -- this file contains all three.
    expect(css).not.toMatch(/grid-template\s*:/);
    expect(css).not.toMatch(/[^-\w]grid\s*:/);

    const offenders: string[] = [];
    for (const m of css.matchAll(/grid-template-columns\s*:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      for (const track of splitTracks(value)) {
        if (BOUNDED_TRACK.test(track)) continue;
        if (CONTENT_MINIMUM.test(track)) {
          offenders.push(
            `\`${track}\` in \`grid-template-columns: ${value}\` takes its minimum from the ` +
              "item's content, so the track cannot shrink below the widest thing in it. " +
              "Write `minmax(0, <track>)`.",
          );
        } else {
          // Fail loud rather than pass quietly: an expression this gate cannot classify is a
          // gate that needs widening, not a track that has been cleared.
          offenders.push(
            `\`${track}\` in \`grid-template-columns: ${value}\` is not a track shape this ` +
              "gate recognises. Widen it rather than trusting it.",
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * One chart render per width band (docs/design/system.md § Charts; lib/chart/fit.ts).
 *
 * Every chart is drawn three times, and the stylesheet alone decides which one a reader sees:
 * `.chart-fit` is an inline-size container, and its `@container` rules display exactly one of
 * `.fit-wide` / `.fit-mid` / `.fit-narrow`. Two visible is a doubled chart; none is a blank frame.
 *
 * jsdom evaluates no container query, so this reads the cascade itself: top-level `.fit-*`
 * display declarations, then each `@container (width < Npx)` block in source order, applied
 * at a set of column widths on both sides of every breakpoint. Equal specificity throughout, so
 * later wins -- the same rule the browser applies. A condition shape it cannot read FAILS.
 */
type Block = { cond: number | null; body: string };

/** Top-level statements in order: plain rules (cond null) and `@container (width < N)` blocks. */
function topLevel(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (depth > 0 && j < css.length) {
      if (css[j] === "{") depth += 1;
      if (css[j] === "}") depth -= 1;
      j += 1;
    }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith("@container")) {
      const m = /^@container\s*\(\s*width\s*<\s*([\d.]+)px\s*\)$/.exec(head);
      if (m === null) throw new Error(`unreadable container condition: ${head}`);
      out.push({ cond: Number(m[1]), body });
    } else if (head.startsWith("@")) {
      // Any other at-rule is skipped by this evaluator, so a `.fit-*` rule inside one (an
      // @media override, say) would change what the browser shows without this test seeing it.
      if (/\.fit-/.test(body)) throw new Error(`.fit-* rule inside an unevaluated block: ${head}`);
    } else {
      out.push({ cond: null, body: `${head}{${body}}` });
    }
    i = j;
  }
  return out;
}

function shownAt(css: string, width: number): Fit[] {
  const display = new Map<Fit, string>();
  for (const { cond, body } of topLevel(css)) {
    if (cond !== null && !(width < cond)) continue;
    for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const value = /display\s*:\s*([\w-]+)/.exec(m[2])?.[1];
      if (value === undefined) continue;
      for (const sel of m[1].split(",").map((x) => x.trim())) {
        const fit = /^\.fit-(wide|mid|narrow)$/.exec(sel)?.[1] as Fit | undefined;
        if (fit !== undefined) display.set(fit, value);
      }
    }
  }
  return FITS.filter((f) => (display.get(f) ?? "block") !== "none");
}

describe("globals.css shows exactly one chart render per width band", () => {
  const css = () => withoutComments(readFileSync(path.join(SRC, "app", "globals.css"), "utf8"));

  it("makes .chart-fit an inline-size container", () => {
    // Mutant: drop container-type -- every @container rule then matches nothing and all widths
    // show the wide render.
    const rule = /\.chart-fit\s*\{([^}]*)\}/.exec(css());
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/container-type\s*:\s*inline-size/);
  });

  // Mutant: delete any one `display: none` -- two renders show in that band.
  it("shows one render on each side of each breakpoint, switching AT FIT_BREAKPOINTS", () => {
    const { mid, wide } = FIT_BREAKPOINTS;
    const expected: [number, Fit][] = [
      [320, "narrow"],
      [mid - 0.5, "narrow"],
      [mid, "mid"],
      [wide - 0.5, "mid"],
      [wide, "wide"],
      [1160, "wide"],
    ];
    for (const [width, fit] of expected) expect([width, shownAt(css(), width)]).toEqual([width, [fit]]);
  });

  // Mutant: move a breakpoint or a viewBox width so a band's labels leave the range.
  it("keeps 10-unit labels within ~9-16 CSS px across each fit's band of column widths", () => {
    // A 10-unit label renders at 10 * column / viewBoxWidth. Bands: 320px (a 375px phone's
    // column is wider) to the mid breakpoint, the mid band, and the wide breakpoint to 922px --
    // the desktop column (1200 - 2*20 gutter - 24 gap - 214 rail).
    const bands: [Fit, number, number][] = [
      ["narrow", 320, FIT_BREAKPOINTS.mid],
      ["mid", FIT_BREAKPOINTS.mid, FIT_BREAKPOINTS.wide],
      ["wide", FIT_BREAKPOINTS.wide, 922],
    ];
    for (const [fit, lo, hi] of bands) {
      const px = (col: number) => (10 * col) / FIT_VIEW_W[fit];
      expect([fit, px(lo) >= 8.85]).toEqual([fit, true]);
      expect([fit, px(hi) <= 16.05]).toEqual([fit, true]);
    }
  });
});
