#!/usr/bin/env node
/**
 * Generates `app/src/lib/og/fonts.generated.ts` from the two committed TrueType sources in
 * `app/src/lib/og/fonts/` -- IBM Plex Sans SemiBold (the card title) and IBM Plex Mono
 * Regular (every numeric on the card, per CLAUDE.md's tabular-figure rule).
 *
 * WHY BAKED IN, NOT READ FROM DISK AT REQUEST TIME: the runtime image's `runtime` stage
 * copies only `app/package.json`, `app/package-lock.json`, `app/next.config.ts`, `app/.next`,
 * `sql/` and the warehouse outputs (Dockerfile:63-72) -- `app/src/` never ships. A
 * `readFileSync` against a path under `src/` would pass every host gate (`make app-check`,
 * `make app-smoke`) and ENOENT in the container, caught only by `make image-smoke`, and only
 * if that gate happens to carry a needle for it. Baking the bytes into a module Turbopack
 * bundles into `.next` (which DOES ship) removes the failure mode entirely, mirroring
 * `app/scripts/build-basemap.mjs` / `basemapPaths.generated.ts` -- read that pair first if
 * you are about to "simplify" this back to a disk read.
 *
 * SOURCE FONTS: IBM Plex (https://github.com/IBM/plex), SIL Open Font License 1.1. The
 * licence travels with the sources at `app/src/lib/og/fonts/OFL.txt` (OFL clause 2). The
 * committed `.ttf` files are SUBSETTED (pyftsubset, Latin + digits + '-·—',
 * i.e. U+0020-007E, U+00B7 middle dot, U+2013 en dash, U+2014 em dash) from IBM/plex's
 * `packages/plex-sans/fonts/complete/ttf/IBMPlexSans-SemiBold.ttf` and
 * `packages/plex-mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf` -- the raw faces are
 * ~376KB combined, over Satori's ~350KB-of-budget guidance once JSX/CSS are added; the
 * subset pair is ~75KB combined. Re-subset with:
 *   pyftsubset <source>.ttf --output-file=<dest>.ttf \
 *     --unicodes="U+0020-007E,U+00B7,U+2013,U+2014" --layout-features='*' \
 *     --glyph-names --recalc-bounds --recalc-timestamp
 *
 * DETERMINISM (mirrors this project's Parquet-writer and basemap discipline): output is a
 * pure function of the two committed `.ttf` files' bytes -- no `Date`, no `Math.random`,
 * nothing environment-dependent. `make card-fonts` run twice must produce a byte-identical
 * `fonts.generated.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FONTS_DIR = path.join(REPO_ROOT, "app", "src", "lib", "og", "fonts");
const SANS_PATH = path.join(FONTS_DIR, "IBMPlexSans-SemiBold.ttf");
const MONO_PATH = path.join(FONTS_DIR, "IBMPlexMono-Regular.ttf");
const OUT_PATH = path.join(REPO_ROOT, "app", "src", "lib", "og", "fonts.generated.ts");

function main() {
  const sansB64 = readFileSync(SANS_PATH).toString("base64");
  const monoB64 = readFileSync(MONO_PATH).toString("base64");

  const out = `/** GENERATED -- do not edit. Regenerate with \`make card-fonts\`.
 * Source: app/src/lib/og/fonts/*.ttf (IBM Plex, OFL 1.1; licence beside the sources). */
export const IBM_PLEX_SANS_SEMIBOLD_B64 = "${sansB64}";
export const IBM_PLEX_MONO_REGULAR_B64 = "${monoB64}";
`;

  writeFileSync(OUT_PATH, out);
  console.log(`wrote ${OUT_PATH} (${Buffer.byteLength(out, "utf8")} bytes)`);
}

// Run only when executed directly (`node build-card-fonts.mjs`, what `make card-fonts` does)
// -- see build-basemap.mjs's own guard comment for why this must be a URL-to-URL comparison
// (`pathToFileURL`, not a raw string compare against argv[1]) rather than something a space
// in the checkout path can silently defeat.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
