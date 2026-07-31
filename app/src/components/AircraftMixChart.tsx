import * as Plot from "@observablehq/plot";
import { renderPlotToSvg } from "@/lib/chart/svg";
import { findCrossover } from "@/lib/chart/crossover";
import { toBands, OTHER_TOKEN, type MixRow } from "@/lib/chart/aircraftMix";

/** The project's first chart (docs/design/system.md § Charts, and CLAUDE.md's workflow rule
 * that this one is built before the load-factor chart): a stacked area of monthly seats by
 * aircraft type, shaded along the monochrome `--g*` ramp so that **an upgauge darkens the
 * stack**.
 *
 * Server-rendered to markup, never a client chart. The SVG is in the served HTML and visible
 * with JS off -- the same property `/route` already had for its text, on the page whose
 * permalinks CLAUDE.md calls the entire growth mechanic.
 *
 * It knows nothing about what it is describing. `title` is the subject line and `rows` are
 * already-shaped mix rows, so /route mounts it today and /airport, /carrier and /aircraft
 * mount the identical component in M4d. Nothing here may say "route".
 *
 * Synchronous on purpose: `toBands`, `findCrossover` and `renderPlotToSvg` are all pure and
 * blocking, so this can be used as ordinary JSX from an async Server Component (an async
 * child cannot be, under the renderer this project's page tests use -- see
 * route/[pair]/page.tsx's note on calling `RouteView` directly). */

/** Mirrors docs/design/mockups/entity-route.html's `#mix` block (W=960, H=210). The margins
 * are Plot's, not the mockup's hand-rolled padding: left clears a `~s` seat tick ("1.2M"),
 * bottom clears the year ticks, and top clears the crossover annotation, which sits inside
 * the frame at the top the way the mockup draws it. */
const WIDTH = 960;
const HEIGHT = 230;
const MARGIN = { left: 46, right: 10, top: 18, bottom: 22 };

/** `--panel-2` across 2020-03 -> 2021-06 (docs/design/system.md, "COVID is drawn, not
 * hidden"). The edges land ON those two months' samples rather than bracketing them: every
 * month is plotted at its first day, so 2021-06-01 is where June 2021's seats are drawn, and
 * a band that stopped at 2021-05-31 would visibly fall short of the month it names. */
const COVID_FROM = "2020-03";
const COVID_TO = "2021-06";
const COVID_LABEL = "COVID — in window on purpose.";

/** The z value for the Other bucket. Two leading underscores because the real z values are
 * BTS `AIRCRAFT_TYPE` codes -- zero-padded digit strings ('079'), never anything else -- so
 * this cannot collide with one. Keyed on CODE and not on the display label for the same
 * reason the pivot is (CLAUDE.md: key on ids, display codes): two types sharing a
 * `short_name` would otherwise merge into one band and silently under-count. */
const OTHER_KEY = "__other";

/** Every month is a point at its first day, UTC. UTC and not local: a local-midnight Date
 * shifts a month's sample across the year boundary west of Greenwich, which would move the
 * COVID band and the annotation rule by a whole tick in some timezones and not others. */
function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`);
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Neither Plot nor jsdom offers a `role` option, and the attribute belongs on the SVG
 * element itself, not on a wrapper: `role="img"` is what makes the subtree presentational, so
 * a screen reader announces the one description below instead of reading out every axis tick
 * group Plot labels. Written as a single anchored replacement of Plot's own root tag, which
 * always begins `<svg class="..."` (svg.ts returns `node.outerHTML`). */
function withImgRole(svg: string): string {
  return svg.replace(/^<svg /, '<svg role="img" ');
}

export function AircraftMixChart({ rows, title }: { rows: MixRow[]; title: string }) {
  const months = [...new Set(rows.map((r) => r.month))].sort();

  // A blank frame under a DATA AS OF badge is the failure /explore and /route already refuse
  // (their empty states state the finding in words). Two cases reach it: nothing filed at
  // all, and a single month -- for which a stacked area has a degenerate x domain and
  // serializes to zero width, and which system.md's sparkline rule already calls out as not a
  // trend. Both say so instead.
  if (months.length < 2) {
    return (
      <Frame title={title}>
        <p className="foot">
          {months.length === 0
            ? "No aircraft-type filings in this window."
            : `Only one month of filings in this window (${months[0]}) — a stacked area needs at least two.`}
        </p>
      </Frame>
    );
  }

  const { bands, other } = toBands(rows);
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
            label: `Other · ${plural(other.typeCount, "type")} · ${pct(other.seatShare)} of seats`,
            series: other.series,
          },
        ]
      : []),
    ...bands.map((b) => ({ key: b.code, token: b.token, label: b.label, series: b.series })),
  ];

  const points = stack.flatMap((s) =>
    s.series.map((p) => ({ t: monthStart(p.month), seats: p.seats, k: s.key })),
  );

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
    renderPlotToSvg({
      className: "plot",
      width: WIDTH,
      height: HEIGHT,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      marginTop: MARGIN.top,
      marginBottom: MARGIN.bottom,
      // CLAUDE.md's non-negotiable: all numerics tabular. Plot sets font-variant on its two
      // axis-tick-label groups already; this covers the annotation's year and anything else
      // added to the frame later.
      style: { fontVariantNumeric: "tabular-nums" },
      ariaLabel: describe({ title, first, last, stack, crossover }),
      x: { type: "utc", label: null, ticks: "1 year", tickFormat: "%Y" },
      y: { label: "Seats", grid: true, ticks: 4, tickFormat: "~s" },
      // The tokens go through as-is: Plot passes an ordinal scale's range straight to the
      // `fill` attribute, so `globals.css` stays the single source for the ramp (verified on
      // a served build in Task 1, for this scale path specifically -- see
      // docs/architecture/hosting.md).
      color: {
        type: "ordinal",
        domain: stack.map((s) => s.key),
        range: stack.map((s) => `var(${s.token})`),
      },
      marks: [
        ...(covid === null
          ? []
          : [
              Plot.rect([covid], { x1: "covidFrom", x2: "covidTo", fill: "var(--panel-2)" }),
              // Bottom of the frame, because the crossover annotation owns the top.
              Plot.text([{ t: midpoint(covid.covidFrom, covid.covidTo) }], {
                x: "t",
                text: () => COVID_LABEL,
                frameAnchor: "bottom",
                dy: -4,
                fill: "var(--ink-2)",
              }),
            ]),
        Plot.areaY(points, {
          x: "t",
          y: "seats",
          z: "k",
          fill: "k",
          order: stack.map((s) => s.key),
        }),
        ...(crossover === null || crossoverAt === null
          ? []
          : [
              Plot.ruleX([crossoverAt], { stroke: "var(--ink)", strokeDasharray: "3 2" }),
              Plot.text([{ t: crossoverAt }], {
                x: "t",
                // Derived, never hand-written (system.md): the whole string comes from
                // findCrossover, so it cannot rot the first month the data moves.
                text: () => `${crossover.to} overtakes ${crossover.from} · ${crossover.year}`,
                frameAnchor: "top",
                textAnchor: annotationLate ? "end" : "start",
                dx: annotationLate ? -5 : 5,
                dy: 2,
                fill: "var(--ink)",
                fontWeight: 500,
              }),
            ]),
      ],
    }),
  );

  return (
    <Frame title={title}>
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
        <span className="gnum">← lightest is the smallest metal, by seats per departure</span>
      </div>
    </Frame>
  );
}

/** The chart block's chrome, shared by the drawn and the stated-in-words cases so the two
 * are visually the same object. Mirrors the mockup's `.chart` / `.chead`. */
function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="chart">
      <div className="chead">
        <div className="ctitle">Seats by aircraft type</div>
        <div className="csub">{title} · monthly · shaded by seats per departure</div>
      </div>
      {children}
    </div>
  );
}

/** What the chart shows, for a reader who cannot see it: the subject, the window, the series
 * in shade order, what Other hides, and the annotation. Not the word "chart" -- system.md
 * asks for "a real aria-label describing what the series are", and `role="img"` means this
 * string is the ONLY thing announced. */
function describe({
  title,
  first,
  last,
  stack,
  crossover,
}: {
  title: string;
  first: string;
  last: string;
  stack: { key: string; label: string }[];
  crossover: { year: string; from: string; to: string } | null;
}): string {
  const types = stack.filter((s) => s.key !== OTHER_KEY).map((s) => s.label);
  const other = stack.find((s) => s.key === OTHER_KEY);
  return [
    `Stacked area of monthly seats by aircraft type, ${title}, ${first} to ${last}.`,
    `Bands lightest to darkest by seats per departure: ${types.join(", ")}.`,
    other === undefined ? null : `${other.label}, drawn lightest of all beneath them.`,
    crossover === null
      ? null
      : `${crossover.to} overtakes ${crossover.from} in ${crossover.year}.`,
  ]
    .filter((s) => s !== null)
    .join(" ");
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

function midpoint(a: Date, b: Date): Date {
  return new Date((a.getTime() + b.getTime()) / 2);
}
