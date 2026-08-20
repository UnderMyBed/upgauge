import { OG_FONT_FAMILY, OG_PALETTE } from "./palette";

/** `var(--token)`, capturing the token name. Global: an SVG carries many. */
const VAR = /var\(--([\w-]+)\)/g;

/** Resolve every `var(--token)` in an SVG string to a literal, for the rasterizer.
 *
 * THROWS on an unknown token, deliberately. resvg cannot resolve a CSS variable and falls
 * back to BLACK, so a pass-through would ship a card that renders -- successfully, with the
 * wrong colours -- rather than one that fails. A silently-wrong data view is the failure this
 * design exists to exclude; a loud one is recoverable.
 *
 * Errors name EVERY unknown token, not the first: a chart change that adds three tokens
 * should cost one round trip, not three. */
export function resolveSvgTokens(svg: string): string {
  const unknown = new Set<string>();
  const out = svg.replace(VAR, (whole, token: string) => {
    if (token in OG_PALETTE) return OG_PALETTE[token];
    if (token in OG_FONT_FAMILY) {
      return OG_FONT_FAMILY[token as keyof typeof OG_FONT_FAMILY];
    }
    unknown.add(`--${token}`);
    return whole;
  });
  if (unknown.size > 0) {
    throw new Error(
      `resolveSvgTokens: no literal for ${[...unknown].join(", ")}. ` +
        "Add it to lib/og/palette.ts (and to globals.css if it is new), or the card " +
        "rasterizes it black.",
    );
  }
  return out;
}
