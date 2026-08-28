import * as Plot from "@observablehq/plot";
import { findCrossover, type Crossover } from "@/lib/chart/crossover";
import {
  toBands,
  OTHER_TOKEN,
  type MixDimension,
  type MixRow,
  type MonthAxis,
  type SeriesPoint,
} from "@/lib/chart/aircraftMix";

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
const OTHER_KEY = "__other";

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

/** THE SECOND CAUSE, AND IT IS NOT THE FIRST ONE (#121). A month that WAS filed and whose every
 * filing failed an invariant is a hole in the chart for a different reason, and folding it into
 * `gapNote`'s count puts a false sentence -- "with no filings" -- on the one line a sighted
 * reader gets. That is the compound-claim-with-one-false-clause shape this project has shipped
 * before: `/watch/new-routes` told every visitor its rows were service nobody flew last year
 * while 521 of 688 had another carrier on the pair.
 *
 * Same geometry as a gap, different sentence. Both are stated, separately, on the key AND in the
 * aria-label -- `/airport`'s foot already sets the precedent that the CAUSE of an absence is
 * named per page, and a rasterized card has no other channel at all. */
export function unknowableNote(months: number): string {
  return (
    `${plural(months, "month")} filed but wholly quarantined — every filing failed an ` +
    `invariant, so the stack cannot be drawn there and the month is left as a gap.`
  );
}

/** THE THIRD SENTENCE, for months that ARE drawn but understate themselves. Unlike the two
 * above this is not a hole: at least one band is stateable, so the month is drawn from what can
 * be stated. The shortfall is real and unbounded -- 26 of the 606 rows behind these cells are
 * `load_factor_gt_1` carrying 19,870 filed seats, not the `zero_seats` the rest are -- so
 * leaving it unsaid would let a reader take the stack height as the month's total.
 *
 * Erasing the month instead was measured and rejected: 407 such months hold 11,687,092 stateable
 * seats, the worst (LAS-LAX 2024-11) 297,295 across 12 cells with ONE unknowable. Showing the
 * dirt is a trust feature; erasing a filing is the same dishonesty as inventing one.
 *
 * IT SAYS "DRAWN AT ZERO HEIGHT" BECAUSE THAT IS WHAT HAPPENS. 420 of the 768 null cells sit
 * inside a month the chart can still draw, and 249 of those belong to a top-five MEMBER band
 * across 87 route pairs -- a NAMED band visibly dropping to the floor for one month. A reader
 * watching the ATR-72 flatten on HNL-OGG 2020-07 can only recover that from this sentence, so it
 * describes the mark rather than gesturing at a total.
 *
 * WHY NOT HOLE THE ONE BAND, and the honest answer is not the one an earlier revision of this
 * comment gave. It claimed a stacked area's cumulative y leaves every band ABOVE an omitted datum
 * with no computable y. That is FALSE, and measured false: three bands over three months, the
 * middle band's middle datum zero-filled against omitted, through this file's own `area()` mark
 * and `renderPlotToSvg` -- 19 paths emitted, 18 byte-IDENTICAL, and the only one that moves is
 * the holed band's own. d3's stack treats a missing row at an x exactly as a zero for every other
 * series, so neighbours are untouched.
 *
 * What omission actually costs is the holed band's OWN path: `M40,90L350,160L640,90...` (six
 * points, dipping to the floor) collapses to `M40,90L640,90...` (four points, a straight edge
 * across the gap). That is interpolation -- drawing seats for a month whose seats cannot be
 * stated -- which is the same dishonesty the whole-month treatment refuses, so it is not an
 * improvement on zero-filling but a different way of inventing.
 *
 * Holing it HONESTLY would mean breaking that band's area into runs of its own, and this
 * codebase tracks exactly one run map per AXIS (`MonthAxis.run`, keyed by month and shared by
 * every band) rather than one per band. That is an engineering cost deliberately not spent here,
 * not an impossibility -- stated as the constraint it is, so the next reader weighing it has the
 * real trade in front of them. */
export function understatedNote(months: number): string {
  return (
    `${plural(months, "month")} understated — a quarantined filing is drawn at zero height ` +
    `there, so its band flattens and the stack is lower than the real total by an amount that ` +
    `cannot be stated.`
  );
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
  unknowable,
  understated,
}: {
  title: string;
  dimension: MixDimension;
  first: string;
  last: string;
  stack: { key: string; label: string }[];
  crossover: { year: string; from: string; to: string } | null;
  gaps: number;
  unknowable: number;
  understated: number;
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
    // SEPARATE SENTENCES, never one merged count (#121). A reader who cannot see the holes is
    // told how many there are AND which cause each set has; merging them would name the wrong
    // cause for whichever set is not "no filings".
    unknowable === 0 ? null : unknowableNote(unknowable),
    understated === 0 ? null : understatedNote(understated),
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
      unknowable: axis.unknowable.length,
      understated: axis.understated.length,
    }),
    // THE DOMAIN IS THE STATED WINDOW, PINNED -- not whatever the marks happen to span.
    //
    // Plot infers a domain from the data, and the marks carry only the months that can be DRAWN.
    // Every sentence around the chart names first->last FILED month instead: the page's own
    // `chart: A → B` line, `describe()`'s aria-label, and both absence counts. Those were the
    // same range until #121 stopped plotting a wholly-quarantined month -- after which
    // /route/LIT-MOB said `chart: 2017-05 → 2024-08` over an axis whose last tick was 2021, with
    // 38 of its 85 claimed gap months and its one wholly-quarantined month falling outside the
    // frame entirely. 43 of 16,694 drawn route pairs and 7 of 917 airports diverged that way.
    //
    // Pinning it is what makes a gap appear WHERE THE SENTENCE SAYS IT IS, and it restores two
    // things that silently depended on the two ranges agreeing: the COVID rect's clamp (six pairs
    // drew the band past their last drawn month, the exact failure `covid`'s own comment says the
    // clamp prevents -- and the rect was itself stretching the axis) and `annotationLate`, whose
    // midpoint is computed from the same `first`/`last`.
    x: {
      type: "utc",
      label: null,
      ticks: "1 year",
      tickFormat: "%Y",
      domain: [monthStart(first), monthStart(last)],
    },
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

/** THE WHOLE CHART, from mix rows to a `MixPlotArgs`, in one place.
 *
 * `AircraftMixChart` and every entity page's `opengraph-image` route both call this, and that
 * is the point: the two honesty rules this chart is built around -- gaps drawn as gaps, and
 * band MEMBERSHIP by seats against band SHADE by gauge -- are decided here, once. A card that
 * re-derived either from the same rows would be a second implementation free to drift from the
 * page it previews, which is exactly the failure `buildMixPlotConfig`'s own header refuses one
 * level down.
 *
 * `plot` is null when a stacked area cannot honestly be drawn: fewer than two filed months. Two
 * cases reach it -- nothing filed at all, and a single month, for which a stacked area has a
 * degenerate x domain and serializes to zero width. `months` is returned either way so the
 * caller can say WHICH of the two it is; a blank frame under a DATA AS OF badge is the failure
 * /explore and /route already refuse. */
export interface PreparedMix {
  /** Every distinct filed month, ascending. Zero-padded YYYY-MM, so lexical order IS
   * chronological. */
  months: string[];
  /** The subset of `months` carrying at least one summable cell -- what the chart can actually
   * draw, and what the `< 2` gate is taken on. Returned beside `months` so a caller stating the
   * absence in words can tell "nothing was filed" from "everything filed was quarantined". */
  stateable: string[];
  plot: {
    args: MixPlotArgs;
    /** Bottom-of-stack first, which is shade order -- the caller's legend reverses it. */
    stack: StackEntry[];
    /** Unfiled months inside the drawn window. Stated on the chart AND in its aria-label. */
    gaps: number;
    /** Filed-but-wholly-quarantined months inside the drawn window. A HOLE like a gap, and a
     * DIFFERENT sentence -- see `unknowableNote`. Counted apart from `gaps` so neither
     * sentence names the other's cause. */
    unknowable: number;
    /** Drawn months that a quarantined filing understates -- see `understatedNote`. Not a
     * hole: these months are drawn from the bands that can be stated. */
    understated: number;
  } | null;
}

/** Every month is a point at its first day, UTC. UTC and not local: a local-midnight Date
 * shifts a month's sample across the year boundary west of Greenwich, which would move the
 * COVID band and the annotation rule by a whole tick in some timezones and not others. */
function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`);
}

/** The em dash, never `0.0%`, when the share cannot be stated: `lib/format.ts`'s opening rule
 * reaches the legend too. Where every type in the Other bucket was wholly quarantined its seats
 * are unknowable, and a rail reading `Other · 1 type · 0.0% of seats` states a measurement
 * nobody has -- live on /route/SEA-YAK before this. `lib/format.ts` is not reused here because
 * this is a percentage to one decimal, which none of its four formatters produce. */
function pct(share: number | null): string {
  return share === null ? "\u2014" : `${(share * 100).toFixed(1)}%`;
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

/** WHY THERE IS NO CHART, in the one wording every surface that lacks one must use.
 *
 * `prepareMixPlot` returns `plot: null` for findings that are NOT the same, and the card is the
 * surface where getting that wrong is unrecoverable: it printed a flat "No filings in this
 * window." over data the page described as one filed month, which on `/airport/A18` claimed
 * nothing was ever filed about an airport whose entire window is a single quarantined filing.
 *
 * A THIRD FINDING, and it is the one this chart's whole absence vocabulary exists for: months
 * were filed and NOT ONE of them can be stated. `Only one month of filings` is false of it (there
 * may be several) and `No filings` is false of it too (there were filings; every one failed an
 * invariant). Three route pairs are in that state with two or more filed months -- BGR-DAB,
 * BHB-MCO and HSV-SUX -- and 28 more with exactly one. Before this branch existed they rendered
 * a frame carrying a COVID band, zero paths, and an `aria-label` naming a band drawn nowhere.
 *
 * One function rather than two that agree today -- the same rule `lib/og/entityCard.ts` opens
 * with for the stats and the chart itself.
 *
 * `stateable` is the subset of `months` carrying at least one summable cell. Passing both, rather
 * than deriving one, is what keeps this function's answer tied to the same set `prepareMixPlot`
 * gates on -- the two disagreeing about which months they meant is exactly the defect above. */
export function mixAbsenceNote(
  months: string[],
  dimension: MixDimension,
  stateable: string[] = months,
): string {
  if (months.length === 0) return `No ${dimension.absent} filings in this window.`;
  if (stateable.length === 0) {
    const every = months.length === 1 ? "" : "every one ";
    return (
      `${plural(months.length, "month")} of filings in this window, ${every}wholly quarantined ` +
      `\u2014 every filing failed an invariant, so no ${dimension.absent} seats can be stated ` +
      `and there is nothing to draw.`
    );
  }
  // Unchanged bytes for the ordinary one-month case, which is most of them and which several
  // fixtures pin verbatim.
  if (stateable.length === months.length) {
    return `Only one month of filings in this window (${months[0]}) \u2014 a stacked area needs at least two.`;
  }
  return (
    `Only one month of filings in this window can be stated (${stateable[0]}) \u2014 a stacked ` +
    `area needs at least two, and the other ${plural(months.length - stateable.length, "month")} ` +
    `filed but wholly quarantined.`
  );
}

/**
 * WHETHER THE CHART DRAWS ANYTHING -- the predicate a SURFACE has to ask, and the reason it is
 * exported rather than left inline below (#123).
 *
 * "Mix rows exist" and "a chart was drawn" are different questions, and every page that gated
 * on the first one asked the wrong one. A subject with a single filed month has rows and draws
 * NOTHING: a stacked area over one month has a degenerate x domain and serializes to zero
 * width, so `prepareMixPlot` returns `plot: null` and `AircraftMixChart` renders
 * `mixAbsenceNote` instead. On `/airport/A18` and `/airport/OQZ` the legend rail therefore
 * explained a monochrome gauge ramp, and named the COVID shading window, beside a line of text
 * -- the exact stale "how to read this" `docs/design/system.md` says the rail exists to replace.
 * (#123 also names `/airport/JZM`; re-derived against the warehouse, JZM files TWO months and
 * has always drawn its chart. Naming it here would be a third copy of a claim the issue got
 * wrong, in the file that owns the predicate.)
 *
 * `prepareMixPlot` is routed THROUGH this rather than repeating the test, so a page and the
 * chart beside it cannot disagree about whether there is a chart. Two functions that agree
 * today is what produced the defect.
 */
export function mixChartDraws(rows: MixRow[]): boolean {
  return new Set(rows.filter((r) => r.seats !== null).map((r) => r.month)).size >= 2;
}

export function prepareMixPlot(
  rows: MixRow[],
  title: string,
  dimension: MixDimension,
): PreparedMix {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  // THE GATE AND THE AXIS MUST MEAN THE SAME SET OF MONTHS. This counted every FILED month while
  // `toBands` builds its axis from the STATEABLE ones, so a subject whose every month is wholly
  // quarantined passed a `>= 2` gate and then produced an axis with no runs, no span and all
  // three absence counts at zero -- a frame with a COVID band, zero paths, and an `aria-label`
  // naming a band drawn nowhere, on the one page where the sentence this module exists to print
  // is the entire finding. Reachable on BGR-DAB, BHB-MCO and HSV-SUX. `mixAbsenceNote` above
  // takes both sets for the same reason.
  // `mixChartDraws` reads the same subset, so a page routed through it and this gate cannot
  // disagree about whether there is a chart.
  const stateable = [...new Set(rows.filter((r) => r.seats !== null).map((r) => r.month))].sort();
  if (!mixChartDraws(rows)) return { months, stateable, plot: null };

  const { bands, other, axis } = toBands(rows);
  const crossover = findCrossover(rows);

  // BOTTOM FIRST. `bands` already arrives in shade order (`--g1` first), which is stack order
  // -- lightest at the bottom, darkest on top, so the ramp reads as one gradient rather than
  // six unrelated greys. Other is lighter still (`--g0`) and therefore sits under everything.
  // Nothing here re-sorts: shade is assigned by gauge inside toBands, and seat rank decides
  // only which five types get a band at all. Re-deriving either here is the two-orderings bug
  // the spec's § Encoding exists to prevent.
  const stack: StackEntry[] = [
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
  const points: AreaPoint[] = stack.flatMap((s, rank) =>
    s.series.map((p) => ({
      t: monthStart(p.month),
      seats: p.seats,
      k: s.key,
      z: `${s.key}@${axis.run.get(p.month)}`,
      rank,
      solo: axis.solo.has(axis.run.get(p.month)!),
    })),
  );

  const first = months[0];
  const last = months[months.length - 1];

  // Clamped to the window, and dropped when the two do not overlap: an unconditional rect
  // would put a --panel-2 slab at a meaningless x on any chart that starts after 2021.
  const covidFrom = maxDate(monthStart(COVID_FROM), monthStart(first));
  const covidTo = minDate(monthStart(COVID_TO), monthStart(last));

  const crossoverAt = crossover === null ? null : monthStart(`${crossover.year}-01`);
  // Past the halfway point the label would run off the right edge -- ~30 characters against
  // the ~10% of the frame a 2025 crossover leaves. Flip the anchor rather than clip the text.
  const annotationLate =
    crossoverAt !== null &&
    crossoverAt.getTime() - monthStart(first).getTime() >
      (monthStart(last).getTime() - monthStart(first).getTime()) / 2;

  return {
    months,
    stateable,
    plot: {
      stack,
      gaps: axis.gaps.length,
      unknowable: axis.unknowable.length,
      understated: axis.understated.length,
      args: {
        title,
        dimension,
        first,
        last,
        stack,
        axis,
        crossover,
        covid: covidFrom < covidTo ? { covidFrom, covidTo } : null,
        // A one-month run has no width: filled, it serializes to a degenerate path and
        // disappears. 41% of route pairs have at least one isolated month (aircraftMix.ts §
        // MonthAxis), and erasing a filing is the same dishonesty as inventing one, so these
        // are STROKED by the caller -- a hairline column in the band's own shade, at the
        // band's own height in the stack.
        runPoints: points.filter((p) => !p.solo),
        soloPoints: points.filter((p) => p.solo),
        crossoverAt,
        annotationLate,
      },
    },
  };
}
