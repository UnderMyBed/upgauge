import { describe, expect, it } from "vitest";
import { resolveSvgTokens } from "./resolveSvgTokens";

describe("resolveSvgTokens", () => {
  it("replaces a colour token with its literal hex", () => {
    expect(resolveSvgTokens('<rect fill="var(--g3)"/>')).toBe('<rect fill="#7E9793"/>');
  });

  it("replaces every occurrence, not just the first", () => {
    const out = resolveSvgTokens('<a fill="var(--ink)"/><b stroke="var(--ink)"/>');
    expect(out).toBe('<a fill="#15181A"/><b stroke="#15181A"/>');
  });

  it("replaces a font token with the family name Satori is given", () => {
    expect(resolveSvgTokens('<text style="font-family: var(--font-mono)">1</text>')).toBe(
      '<text style="font-family: IBM Plex Mono">1</text>',
    );
  });

  it("leaves an SVG with no tokens untouched", () => {
    expect(resolveSvgTokens('<rect fill="#21514A"/>')).toBe('<rect fill="#21514A"/>');
  });

  // THE BUG THIS CATCHES: a token added to the chart and not to the palette. Left to a
  // pass-through, `var(--new)` reaches resvg, which cannot resolve it and paints BLACK --
  // a card that looks plausible and encodes the wrong thing, which is the one failure mode
  // this whole design exists to exclude. It must fail loudly instead.
  it("throws on a token it does not know, rather than passing it through", () => {
    expect(() => resolveSvgTokens('<rect fill="var(--nope)"/>')).toThrow(/--nope/);
  });

  it("names every unknown token it found, not just the first", () => {
    expect(() => resolveSvgTokens('<a fill="var(--x1)"/><b fill="var(--x2)"/>')).toThrow(
      /--x1.*--x2|--x2.*--x1/s,
    );
  });
});
