import { renderPlotToSvg } from "@/lib/chart/svg";
import { findCrossover } from "@/lib/chart/crossover";
import {
  toBands,
  OTHER_TOKEN,
  BY_AIRCRAFT_TYPE,
  type MixDimension,
  type MixRow,
} from "@/lib/chart/aircraftMix";
import {
  buildMixPlotConfig,
  gapNote,
  plural,
  COVID_FROM,
  COVID_TO,
  OTHER_KEY,
} from "@/lib/chart/mixPlotConfig";

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
 * Synchronous on purpose: `toBands`, `findCrossover` and `renderPlotToSvg` are all pure and
 * blocking, so this can be used as ordinary JSX from an async Server Component (an async
 * child cannot be, under the renderer this project's page tests use -- see
 * route/[pair]/page.tsx's note on calling `RouteView` directly). */

/** Every month is a point at its first day, UTC. UTC and not local: a local-midnight Date
 * shifts a month's sample across the year boundary west of Greenwich, which would move the
 * COVID band and the annotation rule by a whole tick in some timezones and not others. */
function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`);
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

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
  const months = [...new Set(rows.map((r) => r.month))].sort();

  // A blank frame under a DATA AS OF badge is the failure /explore and /route already refuse
  // (their empty states state the finding in words). Two cases reach it: nothing filed at
  // all, and a single month -- for which a stacked area has a degenerate x domain and
  // serializes to zero width, and which system.md's sparkline rule already calls out as not a
  // trend. Both say so instead.
  if (months.length < 2) {
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

  const { bands, other, axis } = toBands(rows);
  const crossover = findCrossover(rows);

  // BOTTOM FIRST. `bands` already arrives in shade order (`--g1` first), which is stack order
  // -- lightest at the bottom, darkest on top, so the ramp reads as one gradient rather than
  // six unrelated greys. Other is lighter still (`--g0`) and therefore sits under everything.
  // Nothing here re-sorts: shade is assigned by gauge inside toBands, and seat rank decides
  // only which five types get a band at all. Re-deriving either here is the two-orderings bug
  // the spec's § Encoding exists to prevent.
  const stack = [
    ...(other.typeCount > 0
      ? [
          {
            key: OTHER_KEY,
            token: OTHER_TOKEN,
            // Stated on the swatch, not buried: top-5 + Other is a median 94.7% of seats, but
            // 1,571 of 4,618 multi-type routes fall below 90% and the worst is 48.2%
            // (measured, spec § "The Other band is not a rounding error"). A chart where half
            // the area is in the lightest band has to admit it.
            label: `Other · ${plural(other.typeCount, dimension.unit)} · ${pct(other.seatShare)} of seats`,
            series: other.series,
          },
        ]
      : []),
    ...bands.map((b) => ({ key: b.code, token: b.token, label: b.label, series: b.series })),
  ];

  // GAPS ARE GAPS (docs/design/system.md § Charts). A month the subject did not file has no
  // point here at all, and each contiguous run of filed months gets its own `z` value, so
  // Plot emits one path per (band, run) and an absent month leaves a HOLE. `fill` stays keyed
  // on the band, not on `z`, so a broken band keeps one shade across all its pieces.
  //
  // `order` has to be the rank FUNCTION rather than the array of keys it was: the array form
  // orders the stack by z values, and z is now per-run. Rank is the band's index in `stack`,
  // which is shade order, so the stack order is unchanged -- lightest at the bottom.
  const points = stack.flatMap((s, rank) =>
    s.series.map((p) => ({
      t: monthStart(p.month),
      seats: p.seats,
      k: s.key,
      z: `${s.key}@${axis.run.get(p.month)}`,
      rank,
      solo: axis.solo.has(axis.run.get(p.month)!),
    })),
  );
  const runPoints = points.filter((p) => !p.solo);
  // A one-month run has no width: filled, it serializes to a degenerate path and disappears.
  // 41% of route pairs have at least one isolated month (aircraftMix.ts § MonthAxis), and
  // erasing a filing is the same dishonesty as inventing one, so these are STROKED -- a
  // hairline column in the band's own shade, at the band's own height in the stack.
  const soloPoints = points.filter((p) => p.solo);

  const first = months[0];
  const last = months[months.length - 1];

  // Clamped to the window, and dropped when the two do not overlap: an unconditional rect
  // would put a --panel-2 slab at a meaningless x on any chart that starts after 2021.
  const covidFrom = maxDate(monthStart(COVID_FROM), monthStart(first));
  const covidTo = minDate(monthStart(COVID_TO), monthStart(last));
  const covid = covidFrom < covidTo ? { covidFrom, covidTo } : null;

  const crossoverAt = crossover === null ? null : monthStart(`${crossover.year}-01`);
  // Past the halfway point the label would run off the right edge -- ~30 characters against
  // the ~10% of the frame a 2025 crossover leaves. Flip the anchor rather than clip the text.
  const annotationLate =
    crossoverAt !== null &&
    crossoverAt.getTime() - monthStart(first).getTime() >
      (monthStart(last).getTime() - monthStart(first).getTime()) / 2;

  const svg = withImgRole(
    renderPlotToSvg(
      buildMixPlotConfig({
        title,
        dimension,
        first,
        last,
        stack,
        axis,
        crossover,
        covid,
        runPoints,
        soloPoints,
        crossoverAt,
        annotationLate,
      }),
    ),
  );

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
        {axis.gaps.length > 0 ? <span className="gnum">{gapNote(axis.gaps.length)}</span> : null}
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

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}
