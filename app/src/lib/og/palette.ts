/** The one token -> literal map for the OG card path.
 *
 * `globals.css` stays the styling source for the BROWSER; the chart emits colour as
 * `var(--token)` in SVG attribute values (AircraftMixChart.tsx:242,249,259) and the browser
 * resolves them. A rasterizer has no CSS-variable resolution, so the card path must resolve
 * them first -- and the only safe way to hold a second copy of a value is to make the two
 * copies disagreeing a RED TEST. palette.test.ts is that test; it parses globals.css's
 * `:root` block and asserts equality, so this map cannot drift from the stylesheet.
 *
 * Keys omit the leading `--`. Values are uppercase, because the test uppercases what it
 * parses and an equality assertion should not turn on casing. */
export const OG_PALETTE: Readonly<Record<string, string>> = {
  panel: "#F0F2F1",
  "panel-2": "#E5E8E6",
  field: "#FAFBFA",
  ink: "#15181A",
  "ink-2": "#5C6367",
  "ink-3": "#666E71",
  rule: "#D6DAD8",
  "rule-2": "#828A8B",
  signal: "#0B6E63",
  limit: "#A8322A",
  // fleet ramp, ordered by seats per departure -- an upgauge darkens the stack
  g0: "#E3E7E6",
  g1: "#C8D3D1",
  g2: "#A6B7B4",
  g3: "#7E9793",
  g4: "#4F736E",
  g5: "#21514A",
} as const;

/** The chart also emits `var(--font-mono)` for its axis labels (AircraftMixChart.tsx:217).
 * Satori is given real font data under these family names (lib/og/fonts.ts), so the resolver
 * substitutes the family NAME here, not a file path. */
export const OG_FONT_FAMILY: Readonly<Record<"font-sans" | "font-mono", string>> = {
  "font-sans": "IBM Plex Sans",
  "font-mono": "IBM Plex Mono",
} as const;
