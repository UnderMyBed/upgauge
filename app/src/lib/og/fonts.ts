import { IBM_PLEX_MONO_REGULAR_B64, IBM_PLEX_SANS_SEMIBOLD_B64 } from "./fonts.generated";

/** Satori accepts ttf/otf/woff ONLY. layout.tsx loads IBM Plex through next/font/google,
 * which yields woff2 -- which Satori rejects -- so the card path carries its own .ttf faces.
 * Two faces, not four: SemiBold sans for the title, regular mono for every numeric, because
 * CLAUDE.md's tabular-figure rule does not lapse at card size.
 *
 * BAKED INTO A GENERATED MODULE, never read from disk. The runtime image copies app/.next and
 * not app/src (Dockerfile:63-72), so a readFileSync under src/ passes every host gate and
 * ENOENTs in the container. Same reason and same shape as lib/map/basemapPaths.generated.ts.
 * Do not "simplify" this back to an fs read. */
function face(b64: string, name: string, weight: number) {
  const buf = Buffer.from(b64, "base64");
  return {
    name,
    data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    weight,
    style: "normal" as const,
  };
}

export function loadCardFonts() {
  return [
    face(IBM_PLEX_SANS_SEMIBOLD_B64, "IBM Plex Sans", 600),
    face(IBM_PLEX_MONO_REGULAR_B64, "IBM Plex Mono", 400),
  ];
}
