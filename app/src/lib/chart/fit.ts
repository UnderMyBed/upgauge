/** The width bands every server-rendered chart is drawn for (docs/design/system.md § Charts,
 * "One render per width band").
 *
 * A chart SVG is `width: 100%` over a fixed viewBox, so its text scales with the column: a
 * 10-unit label renders at `10 * column / viewBoxWidth` CSS px. One 960-unit render put the
 * labels at ~3.5px on a 375px phone. Each chart is therefore drawn once per fit, and the
 * `@container` rules on `.chart-fit` in globals.css display exactly one -- the one whose
 * viewBox width keeps 10-unit labels near 9-16px across its band of column widths.
 *
 * Document order is wide first: the first chart SVG on a page is the desktop render.
 *
 * `FIT_BREAKPOINTS` are the container (column) widths, in CSS px, at which the shown render
 * changes. globals.css states them as literals -- CSS cannot import -- and globals.test.ts binds
 * the two together. */
export type Fit = "wide" | "mid" | "narrow";

export const FITS: readonly Fit[] = ["wide", "mid", "narrow"];

export const FIT_VIEW_W: Record<Fit, number> = { wide: 960, mid: 540, narrow: 300 };

/** narrow below `mid`, mid below `wide`, wide at or above it. */
export const FIT_BREAKPOINTS = { mid: 480, wide: 860 } as const;
