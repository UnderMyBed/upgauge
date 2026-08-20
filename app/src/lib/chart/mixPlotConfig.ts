import * as Plot from "@observablehq/plot";
import type { Crossover } from "@/lib/chart/crossover";
import type { MixDimension, MonthAxis, SeriesPoint } from "@/lib/chart/aircraftMix";

/** The mix chart's Plot config: everything `renderPlotToSvg` (lib/chart/svg.ts) needs to draw
 * the stacked area, and nothing else. `AircraftMixChart` calls this to render the chart it
 * mounts; the OG card embeds the identical svg by calling the same function, so the honesty
 * rules -- gaps drawn as gaps, band membership by seats vs. shade by gauge -- stay ONE
 * implementation instead of two that can drift apart. Every field on `MixPlotArgs` is data the
 * caller already has; nothing here reaches back into a pivot row or a warehouse id. */

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
export const COVID_FROM = "2020-03";
export const COVID_TO = "2021-06";
const COVID_LABEL = "COVID — in window on purpose.";

/** The z value for the Other bucket. Two leading underscores because the real z values are
 * warehouse ids -- zero-padded BTS `AIRCRAFT_TYPE` digit strings ('079') under the default
 * stack, `AIRLINE_ID` integers under the carrier one, never anything else -- so this cannot
 * collide with one under either. Keyed on CODE and not on the display label for the same
 * reason the pivot is (CLAUDE.md: key on ids, display codes): two types sharing a
 * `short_name` -- CE-180 names two, measured -- would otherwise merge into one band and
 * silently under-count. */
export const OTHER_KEY = "__other";

export function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** One sentence, written once, used on the key AND in the aria-label -- the number is
 * per-subject and two copies of one measurement drift (the same reasoning as Other's share).
 * "no filings", not "no seats": T-100 is a filing, and nobody filing is not the same claim as
 * nobody flying. */
export function gapNote(gaps: number): string {
  return `${plural(gaps, "month")} with no filings, drawn as gaps rather than interpolated.`;
}

function midpoint(a: Date, b: Date): Date {
  return new Date((a.getTime() + b.getTime()) / 2);
}

/** One (band, run) sample, ready for Plot.areaY. `z` keys the contiguous run a point belongs
 * to (see MonthAxis), so an absent month leaves a HOLE rather than an edge, and `rank` is the
 * band's position in the stack -- see `order` in `area()` below. `solo` distinguishes a
 * one-month run, which the caller draws stroked rather than filled. */
export type AreaPoint = {
  t: Date;
  seats: number;
  k: string;
  z: string;
  rank: number;
  solo: boolean;
};

const area = (data: AreaPoint[], extra: Record<string, unknown>) =>
  Plot.areaY(data, {
    x: "t",
    y: "seats",
    z: "z",
    fill: "k",
    order: (d: { rank: number }) => d.rank,
    ...extra,
  });

/** One band in stack order: `token` is a `--g*` CSS custom property name, `series` its monthly
 * seats. Built by the caller from `toBands` (aircraftMix.ts) plus the Other bucket. */
export type StackEntry = {
  key: string;
  token: string;
  label: string;
  series: SeriesPoint[];
};

/** The COVID band's extent, already clamped to the chart's own window and dropped entirely
 * when the two do not overlap -- `null` means don't draw it. */
export type CovidBand = {
  covidFrom: Date;
  covidTo: Date;
};

export interface MixPlotArgs {
  title: string;
  dimension: MixDimension;
  first: string;
  last: string;
  stack: StackEntry[];
  axis: MonthAxis;
  crossover: Crossover | null;
  covid: CovidBand | null;
  runPoints: AreaPoint[];
  soloPoints: AreaPoint[];
  crossoverAt: Date | null;
  annotationLate: boolean;
}

/** What the chart shows, for a reader who cannot see it: the subject, the window, the series
 * in shade order, what Other hides, and the annotation. Not the word "chart" -- system.md
 * asks for "a real aria-label describing what the series are", and `role="img"` means this
 * string is the ONLY thing announced. */
function describe({
  title,
  dimension,
  first,
  last,
  stack,
  crossover,
  gaps,
}: {
  title: string;
  dimension: MixDimension;
  first: string;
  last: string;
  stack: { key: string; label: string }[];
  crossover: { year: string; from: string; to: string } | null;
  gaps: number;
}): string {
  const types = stack.filter((s) => s.key !== OTHER_KEY).map((s) => s.label);
  const other = stack.find((s) => s.key === OTHER_KEY);
  return [
    `Stacked area of monthly seats by ${dimension.title}, ${title}, ${first} to ${last}.`,
    `Bands lightest to darkest by seats per departure: ${types.join(", ")}.`,
    other === undefined ? null : `${other.label}, drawn lightest of all beneath them.`,
    // A reader who cannot see the holes has to be told they are there, or the label describes
    // a continuous series the chart deliberately does not draw.
    gaps === 0 ? null : `${gapNote(gaps)}`,
    crossover === null
      ? null
      : `${crossover.to} overtakes ${crossover.from} in ${crossover.year}.`,
  ]
    .filter((s) => s !== null)
    .join(" ");
}

/** The exact Plot config `renderPlotToSvg` draws the mix chart from. `AircraftMixChart` builds
 * `args` from its own props and calls this directly; a future caller that only has the same
 * shape of data -- never a pivot row, a warehouse id, or a React prop -- gets the identical
 * chart back. */
export function buildMixPlotConfig(args: MixPlotArgs): Plot.PlotOptions {
  const {
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
  } = args;

  return {
    className: "plot",
    width: WIDTH,
    height: HEIGHT,
    marginLeft: MARGIN.left,
    marginRight: MARGIN.right,
    marginTop: MARGIN.top,
    marginBottom: MARGIN.bottom,
    // CLAUDE.md's non-negotiable: all numerics MONOSPACED and tabular. Plot sets
    // font-variant on its two axis-tick-label groups already, but its root style hardcodes
    // `font-family: system-ui, sans-serif`, so without the family here the y ticks ("1.2M"),
    // the year ticks and the annotation's year rendered in the sans face while every other
    // numeric on the page was Plex Mono -- the mockup has a dedicated `.axl` class doing
    // exactly this (docs/design/mockups/entity-route.html). `var(--font-mono)` and not a
    // literal family name: globals.css stays the single source, the same rule the `--g*`
    // ramp follows.
    style: { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" },
    ariaLabel: describe({
      title,
      dimension,
      first,
      last,
      stack,
      crossover,
      gaps: axis.gaps.length,
    }),
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
      area(runPoints, {}),
      ...(soloPoints.length === 0 ? [] : [area(soloPoints, { stroke: "k", strokeWidth: 1.5 })]),
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
  };
}
