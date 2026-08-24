import type { ImageResponse } from "next/og";
import { IBM_PLEX_MONO_REGULAR_B64, IBM_PLEX_SANS_SEMIBOLD_B64 } from "./fonts.generated";

/** Satori's own `fonts` array, derived structurally from `ImageResponse`'s constructor.
 *
 * There is no public `next/og` export of these types -- `next/og` re-exports only the
 * `ImageResponse` class, and the `FontOptions`/`Weight` names live behind
 * `next/dist/compiled/@vercel/og`, which is a vendored path this app must not import from. So
 * the derivation goes through the one public thing that mentions them, and cannot disagree with
 * whatever Satori version next/og vendors. */
type CardFonts = NonNullable<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]>;

/** `100 | 200 | ... | 900`, not `number`.
 *
 * The narrowing belongs HERE, where the literals are authored, and not at the `ImageResponse`
 * call site: a `weight: number` widened at the source and re-asserted downstream type-checks a
 * typo'd `550` exactly as happily as `600`, because the union is a subtype of `number` and an
 * assertion to a subtype is always permitted. Only Satori's runtime would have objected, on a
 * card route no unit test rasterizes. */
type FontWeight = NonNullable<CardFonts[number]["weight"]>;

/** Satori accepts ttf/otf/woff ONLY. layout.tsx loads IBM Plex through next/font/google,
 * which yields woff2 -- which Satori rejects -- so the card path carries its own .ttf faces.
 * Two faces, not four: SemiBold sans for the title, regular mono for every numeric, because
 * CLAUDE.md's tabular-figure rule does not lapse at card size.
 *
 * BAKED INTO A GENERATED MODULE, never read from disk. The runtime image copies app/.next and
 * not app/src (Dockerfile:63-72), so a readFileSync under src/ passes every host gate and
 * ENOENTs in the container. Same reason and same shape as lib/map/basemapPaths.generated.ts.
 * Do not "simplify" this back to an fs read. */
function face(b64: string, name: string, weight: FontWeight) {
  const buf = Buffer.from(b64, "base64");
  return {
    name,
    data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    weight,
    style: "normal" as const,
  };
}

/** Return type deliberately INFERRED, not annotated `CardFonts`. Satori types `data` as
 * `Buffer | ArrayBuffer`; annotating would widen it and cost `fonts.test.ts`'s `new
 * DataView(f.data)` its argument type for nothing. The shape is still checked -- `card.tsx`
 * hands this array straight to `ImageResponse` with no assertion, so any drift in `name`,
 * `data` or `style` is a compile error there, and `weight` is a compile error right below. */
export function loadCardFonts() {
  return [
    face(IBM_PLEX_SANS_SEMIBOLD_B64, "IBM Plex Sans", 600),
    face(IBM_PLEX_MONO_REGULAR_B64, "IBM Plex Mono", 400),
  ];
}
