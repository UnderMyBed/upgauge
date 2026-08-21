import { OG_FONT_FAMILY, OG_PALETTE } from "./palette";

/** The start of a `var(` reference. Only the opening is a fixed pattern -- what closes it
 * isn't, once a fallback can itself contain a nested `var(...)` (or any other parenthesised
 * value) -- so the body is walked by paren depth below, not matched by a second regex. */
const VAR_START = /var\(/g;

/** The token at the front of a `var(...)`'s contents: optional leading whitespace, then
 * `--name`. Anything after it -- a comma-fallback, a nested `var(...)`, more whitespace -- is
 * deliberately not inspected: this is a substitution, not a CSS cascade, so a resolvable
 * token wins outright and an unresolvable one fails the whole reference, fallback included. */
const TOKEN = /^\s*--([\w-]+)/;

/** Resolve every `var(--token)` in an SVG string to a literal, for the rasterizer.
 *
 * THROWS on an unknown token, and on any `var(...)` this function cannot confidently reduce
 * to one -- a CSS fallback (`var(--x, #fff)`), a nested reference (`var(--a, var(--ink))`),
 * or interior whitespace (`var( --ink )`, which IS still resolved -- see TOKEN above -- but
 * only because it reduces to a plain token unambiguously) are all handled by walking the
 * actual `var()` grammar rather than a single flat regex. A flat `var\(--(\w+)\)` regex
 * matches none of the first two shapes at all -- they pass through untouched, not even
 * flagged -- and independently re-matches a NESTED var(...) as if it were its own top-level
 * reference, resolving the inner token while leaving the outer wrapper as malformed CSS.
 * resvg has no CSS-variable resolution and falls back to BLACK on anything it can't parse, so
 * passing an un-parsed form through -- or resolving it partially -- would ship a card that
 * renders successfully with the wrong colours, which is the exact failure this function
 * exists to exclude. Failing loud on a form it doesn't fully understand is the safe
 * direction to err in.
 *
 * Token lookup uses `hasOwnProperty`, not `in`: `in` walks the prototype chain, so
 * `toString`/`constructor`/`valueOf` -- inherited from Object.prototype on any plain object
 * -- would read as KNOWN tokens and get replaced with their own function source instead of
 * throwing.
 *
 * Errors name EVERY unresolved reference, not the first: a chart change that adds three
 * tokens should cost one round trip, not three. */
export function resolveSvgTokens(svg: string): string {
  const unknown = new Set<string>();
  let out = "";
  let cursor = 0;
  VAR_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VAR_START.exec(svg)) !== null) {
    const start = match.index;
    out += svg.slice(cursor, start);

    // Walk paren depth from just after "var(" so a fallback's own parentheses -- most
    // importantly a nested var(...) -- don't close this match early. depth starts at 1 for
    // the "(" the VAR_START match already consumed.
    let depth = 1;
    let i = start + match[0].length;
    for (; i < svg.length && depth > 0; i++) {
      if (svg[i] === "(") depth++;
      else if (svg[i] === ")") depth--;
    }
    if (depth !== 0) {
      throw new Error(`resolveSvgTokens: unterminated var( at offset ${start}`);
    }
    const end = i;
    const whole = svg.slice(start, end);
    const inner = svg.slice(start + match[0].length, end - 1);
    const token = TOKEN.exec(inner)?.[1];

    let literal: string | undefined;
    if (token !== undefined && Object.prototype.hasOwnProperty.call(OG_PALETTE, token)) {
      literal = OG_PALETTE[token];
    } else if (token !== undefined && Object.prototype.hasOwnProperty.call(OG_FONT_FAMILY, token)) {
      literal = OG_FONT_FAMILY[token as keyof typeof OG_FONT_FAMILY];
    }

    if (literal !== undefined) {
      out += literal;
    } else {
      unknown.add(token !== undefined ? `--${token}` : whole);
      out += whole;
    }

    cursor = end;
    VAR_START.lastIndex = end;
  }
  out += svg.slice(cursor);

  if (unknown.size > 0) {
    throw new Error(
      `resolveSvgTokens: no literal for ${[...unknown].join(", ")}. ` +
        "Add it to lib/og/palette.ts (and to globals.css if it is new), or the card " +
        "rasterizes it black.",
    );
  }
  return out;
}
