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

  // A real emitted token combining a hyphen AND a digit (AircraftMixChart.tsx:242) -- distinct
  // from every other case here, which uses a single-word or single-letter token and so could
  // pass against a token pattern narrower than what the chart actually emits.
  it("resolves a real chart token combining a hyphen and a digit", () => {
    expect(resolveSvgTokens('<rect fill="var(--panel-2)"/>')).toBe('<rect fill="#E5E8E6"/>');
  });

  // THE BUG THIS CATCHES: a token added to the chart and not to the palette. Left to a
  // pass-through, `var(--new)` reaches resvg, which cannot resolve it and paints BLACK --
  // a card that looks plausible and encodes the wrong thing, which is the one failure mode
  // this whole design exists to exclude. It must fail loudly instead.
  it("throws on a token it does not know, rather than passing it through", () => {
    expect(() => resolveSvgTokens('<rect fill="var(--nope)"/>')).toThrow(/--nope/);
  });

  it("names every unknown token it found, not just the first", () => {
    let message = "";
    try {
      resolveSvgTokens('<a fill="var(--x1)"/><b fill="var(--x2)"/>');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Order isn't the contract, coverage of both is -- so two `toContain` checks, not one
    // regex spanning both (a `.` without the `s`/dotAll flag doesn't match newlines, and this
    // repo's tsconfig targets ES2017, which cannot use that flag at all: TS1501).
    expect(message).toContain("--x1");
    expect(message).toContain("--x2");
  });

  // THE BUG THIS CATCHES (finding 1): CSS var() allows a fallback after a comma --
  // `var(--x, #fff)` -- and a regex requiring `)` immediately after the token's characters
  // never matches this shape at all, so it reaches resvg as literal, unresolved CSS instead
  // of being caught.
  it("throws on a var() with a CSS fallback, rather than passing it through", () => {
    expect(() => resolveSvgTokens('<rect fill="var(--x, #fff)"/>')).toThrow(/--x/);
  });

  // THE BUG THIS CATCHES (finding 2): matching each `var(...)` independently resolves the
  // INNER `var(--ink)` on its own and leaves the OUTER wrapper -- `var(--a, ...)` -- as
  // malformed CSS that still reaches resvg, unresolved and unflagged. The outer token must be
  // inspected, and if it is unknown the whole nested reference must fail together, not just
  // the inner one that happened to look like a simple case.
  it("throws on a nested var() naming the outer token, not just resolving the inner one", () => {
    expect(() => resolveSvgTokens('<rect fill="var(--a, var(--ink))"/>')).toThrow(/--a\b/);
  });

  // THE BUG THIS CATCHES (finding 3): `token in OG_PALETTE` walks the prototype chain, so
  // `toString`/`constructor`/`valueOf` -- inherited from Object.prototype on any plain object
  // literal -- read as KNOWN tokens and get substituted with their own function source
  // instead of throwing.
  it("throws on a token that collides with an inherited Object.prototype name", () => {
    expect(() => resolveSvgTokens('<rect fill="var(--toString)"/>')).toThrow(/--toString/);
  });

  // THE BUG THIS CATCHES (finding 4): `var( --ink )` (whitespace inside the parens) is valid
  // CSS. A pattern anchored tightly on `var(--token)` doesn't match it, so it passes through
  // unresolved; the resolver must still find and resolve the token.
  it("resolves a var() with whitespace inside the parens", () => {
    expect(resolveSvgTokens('<rect fill="var( --ink )"/>')).toBe('<rect fill="#15181A"/>');
  });
});
