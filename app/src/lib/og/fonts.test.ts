import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCardFonts } from "./fonts";

describe("loadCardFonts", () => {
  // THE BUG THIS CATCHES: a font file missing, renamed, or saved as an HTML 404 page. Satori
  // given a bad buffer fails at RENDER time, in production, on a path no unit test walks.
  it("returns both faces with real TrueType data", () => {
    const fonts = loadCardFonts();
    expect(fonts.map((f) => f.name).sort()).toEqual(["IBM Plex Mono", "IBM Plex Sans"]);
    for (const f of fonts) {
      expect(f.data.byteLength).toBeGreaterThan(10_000);
      // TrueType magic: 0x00010000, or "true"/"ttcf"/"OTTO".
      const tag = new DataView(f.data).getUint32(0);
      expect([0x00010000, 0x74727565, 0x74746366, 0x4f54544f]).toContain(tag);
    }
  });

  it("stays inside Satori's 500KB bundle ceiling", () => {
    const total = loadCardFonts().reduce((n, f) => n + f.data.byteLength, 0);
    expect(total).toBeLessThan(400_000);
  });

  it("does not read the font from disk", () => {
    // ROOT is the REPO root (vitest.config.ts:19 sets UPGAUGE_ROOT), hence the "app" segment.
    const ROOT = process.env.UPGAUGE_ROOT ?? process.cwd();
    const src = readFileSync(path.join(ROOT, "app", "src", "lib", "og", "fonts.ts"), "utf8");
    // THE BUG THIS CATCHES: a "simplification" back to readFileSync. app/src does not ship in
    // the runtime image (Dockerfile:63-72), so a disk read passes every host gate and ENOENTs
    // in the container -- caught only by make image-smoke, and only if its needle exists.
    expect(src).not.toMatch(/from\s+["']node:fs["']|require\(["']fs["']\)/);
  });
});
