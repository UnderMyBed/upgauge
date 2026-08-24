import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OG_PALETTE } from "./palette";

/** Parse the `:root { ... }` block of globals.css into token -> value.
 * Deliberately a dumb regex over the FIRST :root block: globals.css is ours, its shape is
 * stable, and a parser that silently tolerated a shape change would defeat the point. */
function rootTokens(): Record<string, string> {
  // ROOT is the REPO root, not app/ -- vitest.config.ts:19 sets UPGAUGE_ROOT to
  // path.resolve(__dirname, ".."), and every existing consumer anchors the same way
  // (lib/db.ts:18, lib/sitemap.ts:12, lib/watch.ts:11). Hence the "app" segment.
  const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
  const css = readFileSync(
    path.join(ROOT, "app", "src", "app", "globals.css"),
    "utf8",
  );
  const block = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (block === null) throw new Error("globals.css has no :root block");
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) {
    out[m[1]] = m[2].toUpperCase();
  }
  return out;
}

describe("OG_PALETTE", () => {
  // THE BUG THIS CATCHES: a colour changed in globals.css and not in the map (or the
  // reverse), so the card and the page render the same series in different colours. No
  // other test can see this -- the browser resolves one, the rasterizer the other.
  it("has exactly the colour tokens globals.css declares, with the same values", () => {
    expect(OG_PALETTE).toEqual(rootTokens());
  });

  it("covers every ramp token the chart can emit", () => {
    for (const t of ["g0", "g1", "g2", "g3", "g4", "g5"]) {
      expect(OG_PALETTE).toHaveProperty(t);
    }
  });
});
