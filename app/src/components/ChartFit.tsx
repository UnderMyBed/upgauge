import type { Fit } from "@/lib/chart/fit";

/** One chart, drawn once per width band, inside the container `globals.css` queries.
 *
 * A chart SVG scales its text with the column (lib/chart/fit.ts), so no single viewBox reads at
 * every width. `render` is called once per fit from data the caller has ALREADY prepared, so the
 * renders differ only in geometry -- never in rows. The `@container` rules on `.chart-fit` show
 * exactly one child and `display: none` the others, which also removes them from the
 * accessibility tree: one chart is announced, never three.
 *
 * Only the SVG goes in here. A chart's HTML key and notes sit outside, once.
 *
 * The three classes are literal, not `fit-${f}`, so globals.test.ts's class-coverage gate sees
 * each of them. Wide is first in the document. */
export function ChartFit({ render }: { render: (fit: Fit) => React.ReactNode }) {
  return (
    <div className="chart-fit">
      <div className="fit-wide">{render("wide")}</div>
      <div className="fit-mid">{render("mid")}</div>
      <div className="fit-narrow">{render("narrow")}</div>
    </div>
  );
}
