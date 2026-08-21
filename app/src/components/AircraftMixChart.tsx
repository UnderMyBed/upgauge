import { renderPlotToSvg } from "@/lib/chart/svg";
import { BY_AIRCRAFT_TYPE, type MixDimension, type MixRow } from "@/lib/chart/aircraftMix";
import { buildMixPlotConfig, gapNote, prepareMixPlot } from "@/lib/chart/mixPlotConfig";

/** The project's first chart (docs/design/system.md § Charts, and CLAUDE.md's workflow rule
 * that this one is built before the load-factor chart): a stacked area of monthly seats,
 * shaded along the monochrome `--g*` ramp so that **an upgauge darkens the stack**.
 *
 * Server-rendered to markup, never a client chart. The SVG is in the served HTML and visible
 * with JS off -- the same property `/route` already had for its text, on the page whose
 * permalinks CLAUDE.md calls the entire growth mechanic.
 *
 * It knows nothing about what it is describing. `title` is the subject line and `rows` are
 * already-shaped mix rows, so /route mounts it today and /airport, /carrier and /aircraft
 * mount the identical component in M4d. Nothing here may say "route".
 *
 * `dimension` is what M4d added and is the ONLY thing this component knows about the breakdown:
 * the pivot key never reaches here, only the words that describe the stack (MixDimension). It
 * defaults to the aircraft-type stack, so /route, /airport and /carrier mount it exactly as
 * M4c did; /aircraft passes BY_CARRIER, because a page that IS one aircraft type would
 * otherwise draw a single band whose gauge ordering encodes nothing. The file keeps its M4c
 * name: three pages import it, and a rename buys nothing a comment cannot say.
 *
 * Synchronous on purpose: `prepareMixPlot`, `buildMixPlotConfig` and `renderPlotToSvg` are all
 * pure and blocking, so this can be used as ordinary JSX from an async Server Component (an async
 * child cannot be, under the renderer this project's page tests use -- see
 * route/[pair]/page.tsx's note on calling `RouteView` directly). */

/** Neither Plot nor jsdom offers a `role` option, and the attribute belongs on the SVG
 * element itself, not on a wrapper: `role="img"` is what makes the subtree presentational, so
 * a screen reader announces the one description below instead of reading out every axis tick
 * group Plot labels. Written as a single anchored replacement of Plot's own root tag, which
 * always begins `<svg class="..."` (svg.ts returns `node.outerHTML`). */
function withImgRole(svg: string): string {
  return svg.replace(/^<svg /, '<svg role="img" ');
}

export function AircraftMixChart({
  rows,
  title,
  dimension = BY_AIRCRAFT_TYPE,
}: {
  rows: MixRow[];
  title: string;
  dimension?: MixDimension;
}) {
  // ONE implementation of the chart, shared with every entity page's `opengraph-image` route
  // (lib/chart/mixPlotConfig.ts). Nothing about gaps, band membership or band shade is decided
  // here any more -- a second copy of that reasoning is what would let a social card and the
  // page it previews draw two different charts from the same rows.
  const { months, plot } = prepareMixPlot(rows, title, dimension);

  // A blank frame under a DATA AS OF badge is the failure /explore and /route already refuse
  // (their empty states state the finding in words). Two cases reach it: nothing filed at
  // all, and a single month -- for which a stacked area has a degenerate x domain and
  // serializes to zero width, and which system.md's sparkline rule already calls out as not a
  // trend. Both say so instead.
  if (plot === null) {
    return (
      <Frame title={title} dimension={dimension}>
        <p className="foot">
          {months.length === 0
            ? `No ${dimension.absent} filings in this window.`
            : `Only one month of filings in this window (${months[0]}) — a stacked area needs at least two.`}
        </p>
      </Frame>
    );
  }

  const { args, stack, gaps } = plot;
  const svg = withImgRole(renderPlotToSvg(buildMixPlotConfig(args)));

  return (
    <Frame title={title} dimension={dimension}>
      {/* The markup is Plot's own serialization of our warehouse data -- no user input
          reaches it, and every string that does (the title, the aircraft short_names) is
          written through the DOM by Plot and escaped by jsdom's serializer, not concatenated
          into the markup here. It is the only way to land a server-rendered SVG in a Server
          Component. */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="ckey">
        {/* Darkest first, so the key reads top-of-stack down, the order the eye meets the
            bands in. Mirrors the mockup's own `ser.slice().reverse()`. */}
        {[...stack].reverse().map((s) => (
          <span key={s.key} data-token={s.token}>
            <i aria-hidden="true" style={{ background: `var(${s.token})` }} />
            {s.label}
          </span>
        ))}
        {/* What the ramp MEANS, and it is not the same claim on both stacks: across aircraft
            types a darker band is bigger metal, across carriers of one type it is the same
            metal fitted denser (F9 230.0 seats in the A321 to B6's 172.3, measured). The
            sentence therefore comes from the dimension, never from here. */}
        <span className="gnum">{dimension.rampNote}</span>
        {/* Stated on the chart, not only in the aria-label: a hole in a stacked area is easy
            to read as "flat and small" rather than "not filed", and the count is per-subject
            so the static legend rail cannot carry it. */}
        {gaps > 0 ? <span className="gnum">{gapNote(gaps)}</span> : null}
      </div>
    </Frame>
  );
}

/** The chart block's chrome, shared by the drawn and the stated-in-words cases so the two
 * are visually the same object. Mirrors the mockup's `.chart` / `.chead`. */
function Frame({
  title,
  dimension,
  children,
}: {
  title: string;
  dimension: MixDimension;
  children: React.ReactNode;
}) {
  return (
    <div className="chart">
      <div className="chead">
        {/* ONE template string, not `Seats by {dimension.title}`. React's SSR emits an HTML
            comment between adjacent text nodes so it can find the boundaries again when
            hydrating, so the two-node form serves `Seats by <!-- -->aircraft type` -- invisible
            to `textContent` and therefore to every unit test here, and fatal to a raw-bytes
            grep in app/smoke.sh. The same trap as route/[pair]/page.tsx's `chartWindow`. */}
        <div className="ctitle">{`Seats by ${dimension.title}`}</div>
        <div className="csub">{title} · monthly · shaded by seats per departure</div>
      </div>
      {children}
    </div>
  );
}
