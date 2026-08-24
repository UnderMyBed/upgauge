import { runPivot } from "@/lib/db";
import { displayValue, resolutionKey } from "@/lib/resolve";
import type { PivotQuery } from "@/lib/pivot/types";

/** One (month, band) cell of the mix, with the band's id already resolved for display.
 *
 * `code` is the raw warehouse id of whatever the stack is broken down by -- a zero-padded BTS
 * AIRCRAFT_TYPE VARCHAR ('079') under the default stack, an AIRLINE_ID under the carrier stack.
 * Never a number (CLAUDE.md: int-parsing '079' breaks the join silently), and never the display
 * form: it is the identity the pivot, and any drill-down permalink, is keyed on. `label` is what
 * a reader sees ('A321nXLR', 'WN'), and the two must not be confused: '612' is the 737-700, not
 * the A321.
 *
 * `departures` is here for one reason: the chart's shade ordering is by gauge
 * (seats / departures), which is a different ordering from band membership (total seats).
 * See toBands, and docs/superpowers/specs/2026-07-31-m4c-aircraft-mix-chart-design.md
 * § Encoding. */
export interface MixRow {
  month: string;
  code: string;
  label: string;
  seats: number;
  departures: number;
}

/** WHAT THE STACK IS BROKEN DOWN BY, and everything a reader has to be told about that choice.
 *
 * M4c hard-coded `aircraft_type`. M4d needs a second answer, because `/aircraft/<slug>` is a
 * page that IS one aircraft type: stacking it by type draws a single band whose gauge ordering
 * encodes nothing at all. Stacking by OPERATING CARRIER answers the better question -- who
 * adopted this type, and when -- and, critically, the ramp keeps meaning something, which is
 * measured rather than assumed (see BY_CARRIER).
 *
 * The prose fields are here, next to `key`, and not spread across the component: a dimension
 * and the sentences that describe its ramp are one decision. Splitting them is how a chart ends
 * up stacked by carrier under a title and a legend that both say "aircraft type" -- the failure
 * this whole type exists to make unrepresentable. */
export interface MixDimension {
  /** The pivot dimension key. Also the result column and the resolution key: every dimension in
   * `meta_pivot_dimensions` whose `column_expr` is a single column has all three equal, which
   * both of these are (`route`, the one composite, is not stackable here for that reason). */
  key: string;
  /** In the chart's own title: "Seats by aircraft type". */
  title: string;
  /** One band, singular, for the Other swatch's count: "2 types" / "2 carriers". */
  unit: string;
  /** The empty-frame sentence: "No aircraft-type filings in this window." */
  absent: string;
  /** What the two ends of the ramp MEAN for this stack, and they are not the same claim.
   * Across aircraft types, a darker band is bigger metal. Across carriers of ONE type it is
   * the same metal fitted denser -- Frontier's A321 carries 230.0 seats to JetBlue's 172.3 --
   * so a rail saying "larger metal" on `/aircraft` would be describing an encoding the chart
   * is not drawing. */
  rampLight: string;
  rampDark: string;
  /** The one-line note under the colour key, in the chart's own voice. */
  rampNote: string;
}

/** The M4c stack, and the default: seats by aircraft type. `/route`, `/airport` and `/carrier`
 * all take it, which is why it is a default rather than a required argument -- their three-
 * argument calls mean in M4d exactly what they meant in M4c. */
export const BY_AIRCRAFT_TYPE: MixDimension = {
  key: "aircraft_type",
  title: "aircraft type",
  unit: "type",
  absent: "aircraft-type",
  rampLight: "smaller metal",
  rampDark: "larger metal",
  rampNote: "← lightest is the smallest metal, by seats per departure",
};

/** The `/aircraft` stack: seats by operating carrier.
 *
 * THE RAMP STILL ENCODES SOMETHING, MEASURED -- and every figure below names its WINDOW,
 * because they differ and this page draws the full one. Over 2015-01..2026-04, which is what
 * /aircraft fetches: the A321nXLR spans B6 176.0 -> F9 230.0 (54.0 seats, 31%, on identical
 * metal), the A320-1/2 spans MX 129.3 -> G4 181.7, and the B737-8 spans AS 159.8 -> XP 187.7.
 * Over the trailing 12 months alone the same three read B6 172.3 -> F9 230.0 (57.7, 33%),
 * AA 150.0 -> F9 184.1, and AS 159.5 -> SY 186.0 -- the source of the 172.3/230.0 pair quoted
 * in prose elsewhere in this repo, and the reason this comment used to name SY as the densest
 * B737-8 operator on a chart that draws a window in which XP is. The spread survives either
 * window, which is the claim; the unlabelled figure was not evidence for it. On this page the
 * ramp isolates CONFIGURATION choice from FLEET choice, which `/route` cannot separate.
 *
 * `op_airline_id` and not a mainline rollup: the query keeps `grouping: "operating"` (CLAUDE.md
 * -- the operating carrier is the grain and the truth), because rolling Endeavor into Delta
 * would rewrite who "adopted" a type, which is precisely the question this chart answers. */
export const BY_CARRIER: MixDimension = {
  key: "op_airline_id",
  title: "operating carrier",
  unit: "carrier",
  absent: "carrier",
  rampLight: "less dense cabin",
  rampDark: "denser cabin",
  rampNote: "← lightest is the least dense cabin, by seats per departure",
};

/** High enough that the chart is never silently truncated, and low enough to stay a bound.
 *
 * Measured against the built warehouse over the full 2015-01..2026-04 window: the worst-case
 * route produces 1,908 (month, type) groups, and the most aircraft types any one route
 * carries is 36 over 136 months (a 4,896-row absolute ceiling). JFK-LAX -- the flagship
 * example -- returns 996. 10,000 clears the measured worst case 5x and the structural ceiling
 * 2x. A truncated chart would not look broken, it would look like an airline stopped flying,
 * which is precisely the failure this headroom exists to avoid; aircraftMix.test.ts pins the
 * returned count strictly below this bound rather than trusting the arithmetic.
 *
 * M4d re-measured it for the CARRIER stack rather than assuming the type figure covered it,
 * since the bound is now shared: the worst-case aircraft type produces 1,915 (month, carrier)
 * groups (type 035, the CESSNA 172) and the most carriers any one type carries is 25 (type
 * 416) -- 3,400 absolute. The 737-800 this page's tests use returns 952. Same headroom.
 *
 * EXPORTED because /airport unions THREE of these queries and has to know whether any side came
 * back at the bound: a truncated side can drop a cell the overlap query still returns, and the
 * union's subset invariant then throws -- a 500 the proxy has already marked cacheable for
 * thirty days. See endpoints.ts's fetchAirportMix. */
export const AIRCRAFT_MIX_LIMIT = 10000;

/** The pivot the chart is drawn from. No new SQL and no new catalog entries: the existing
 * segment-grain pivot answers this directly (the spec's § Data).
 *
 * `grain: "segment"` is not a choice under either stack. `aircraft_type` is segment-grain only
 * in meta_pivot_dimensions, and the carrier stack is only ever asked for alongside an
 * aircraft-type FILTER, which is segment-grain for the same reason.
 *
 * `grouping: "operating"` because the operating carrier is the grain and the truth
 * (CLAUDE.md) -- under the type stack rolling Endeavor into Delta would not change a single
 * seat, but it is not the filing this chart describes; under the CARRIER stack it would change
 * the bands themselves, merging a regional's adoption of a type into its mainline's.
 *
 * `sort: null` with `sortDesc: true` is the normalized form of "no explicit sort"
 * (normalizeQuery in lib/pivot/types.ts -- the other combination is unrepresentable in the
 * URL format). Order does not matter to this consumer: toBands re-sorts twice, by two
 * different keys, on purpose.
 *
 * Quarantined rows are already excluded by the measure expressions
 * (`SUM(seats) FILTER (WHERE NOT is_quarantined)`); this layer inherits that and must never
 * re-filter.
 *
 * `dimension` and `limit` are LAST and defaulted, so every M4c call site keeps its meaning
 * untouched. `limit` is an argument for the same reason RouteView's row limit is: nothing in
 * production data reaches 10,000, so a caller's truncation handling would otherwise be
 * unreachable and therefore untestable. */
export function aircraftMixQuery(
  filters: [string, string[]][],
  timeFrom: string,
  timeTo: string,
  dimension: MixDimension = BY_AIRCRAFT_TYPE,
  limit: number = AIRCRAFT_MIX_LIMIT,
): PivotQuery {
  return {
    grain: "segment",
    dimensions: ["year_month", dimension.key],
    measures: ["seats", "departures_performed"],
    timeFrom,
    timeTo,
    filters,
    sort: null,
    sortDesc: true,
    limit,
    grouping: "operating",
  };
}

export async function fetchAircraftMix(
  filters: [string, string[]][],
  timeFrom: string,
  timeTo: string,
  dimension: MixDimension = BY_AIRCRAFT_TYPE,
  limit: number = AIRCRAFT_MIX_LIMIT,
): Promise<MixRow[]> {
  const result = await runPivot(aircraftMixQuery(filters, timeFrom, timeTo, dimension, limit));
  return result.rows.map((r) => {
    // `dimension.key` reads BOTH the result column and the resolution key -- see MixDimension.
    // Reading a literal column name here is the hard-coded-dimension regression: the carrier
    // pivot's rows carry no `aircraft_type` column at all, so every row would collapse to the
    // single code "undefined" and the chart would draw one band.
    const code = String(r[dimension.key]);
    return {
      month: String(r.year_month),
      code,
      // displayValue(), not `hit?.code ?? code`: the three-way display contract
      // (absent -> raw id, resolved-without-a-code -> the name, resolved -> the code) lives
      // in exactly one place, and re-deriving it locally is how the two copies drift --
      // lib/resolve.ts's own header records that having happened once already.
      label: displayValue(result.resolved.get(resolutionKey(dimension.key, code)), code),
      seats: Number(r.seats ?? 0),
      departures: Number(r.departures_performed ?? 0),
    };
  });
}

/** The six-token monochrome ramp from app/src/app/globals.css, in ramp order. `--g0` is
 * reserved for Other and is not assignable to a type band, which is why it is not in this
 * list -- docs/design/system.md § Charts owns the values. */
export const BAND_TOKENS = ["--g1", "--g2", "--g3", "--g4", "--g5"] as const;
export type BandToken = (typeof BAND_TOKENS)[number];

/** The token the Other bucket always carries: lightest, and outside the gauge ordering
 * entirely -- Other is a mixture of metal sizes, so it has no gauge to be ordered by. */
export const OTHER_TOKEN = "--g0";

export interface SeriesPoint {
  month: string;
  seats: number;
}

/** The month axis a chart of these rows is drawn on, and where it must BREAK.
 *
 * A month in which the subject filed nothing is not zero seats -- it is unknown. T-100 is a
 * filing, so "no row" means "nobody filed", which is not the same claim as "nobody flew" and
 * is certainly not "0 seats flew". Drawing it either way invents data:
 *
 *   - joining the two surrounding samples (what shipped in M4c) draws a straight edge across
 *     the absence, so a reader reads seats for months that filed nothing;
 *   - zero-filling it draws the stack collapsing to the floor and back, which asserts a
 *     shutdown the data does not record.
 *
 * So the area BREAKS. `series` therefore carries a point only for months that filed, and this
 * axis says which contiguous stretch each of those months belongs to; the renderer draws one
 * area per stretch, so an absent month leaves a hole rather than an edge.
 *
 * Measured over the built warehouse: 14,293 of 23,041 route pairs (62%) have at least one
 * interior gap, and HNL-LAS -- 7.07 M seats -- has six consecutive absent months
 * (2020-04..2020-09) INSIDE the COVID band the chart labels "in window on purpose".
 *
 * `solo` exists because a run of one month has no width: it serializes to a degenerate,
 * invisible path, and 9,486 of 22,919 route pairs (41%) have at least one such isolated
 * month. Erasing a filing is the same class of dishonesty as inventing one, so the renderer
 * draws those runs stroked instead of filled. */
export interface MonthAxis {
  /** Every month from the first filing to the last, contiguous, filed or not. */
  span: string[];
  /** Months in `span` with no filing at all, in order. */
  gaps: string[];
  /** month -> id of the contiguous run of filed months it belongs to. Gap months are absent. */
  run: Map<string, number>;
  /** Run ids covering exactly one month. */
  solo: Set<number>;
}

/** Every month from `from` to `to` inclusive. Arithmetic on the year/month integers rather
 * than on Date: a Date-based walk is one timezone bug away from skipping or repeating a month
 * (the same reason monthStart() in AircraftMixChart is pinned to UTC). */
function monthSpan(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const out: string[] = [];
  for (let i = fy * 12 + (fm - 1); i <= ty * 12 + (tm - 1); i++) {
    out.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** Split the filed months into contiguous runs, and name the months between them. */
function monthAxis(filed: string[]): MonthAxis {
  // No filings at all: an empty axis rather than a crash on filed[0]. The renderer never gets
  // here (it states the absence in words below two months), but toBands is exported and a
  // caller that hands it nothing deserves an answer, not a TypeError.
  if (filed.length === 0) return { span: [], gaps: [], run: new Map(), solo: new Set() };
  const span = monthSpan(filed[0], filed[filed.length - 1]);
  const filedSet = new Set(filed);
  const run = new Map<string, number>();
  const size = new Map<number, number>();
  let current = 0;
  let previousFiled = false;
  for (const month of span) {
    if (!filedSet.has(month)) {
      previousFiled = false;
      continue;
    }
    if (!previousFiled) current += 1;
    run.set(month, current);
    size.set(current, (size.get(current) ?? 0) + 1);
    previousFiled = true;
  }
  return {
    span,
    gaps: span.filter((m) => !filedSet.has(m)),
    run,
    solo: new Set([...size].filter(([, n]) => n === 1).map(([id]) => id)),
  };
}

export interface Band {
  code: string;
  label: string;
  token: BandToken;
  series: SeriesPoint[];
}

export interface OtherSummary {
  /** How many BANDS this bucket aggregates -- aircraft types under the default stack, operating
   * carriers under BY_CARRIER. The name is M4c's and is kept because `toBands` and every caller
   * of it are the only readers; what a band IS comes from the caller's `MixDimension.unit`, which
   * is what the swatch is actually written from ("2 types" / "2 carriers"). Zero means there is
   * no Other band to draw, and `series` is empty rather than a row of zeroes. */
  typeCount: number;
  /** Share of the route's TOTAL seats, not of the remainder. The legend rail states this out
   * loud because Other is often not a rounding error: top-5 + Other covers a median 94.7% of
   * seats on multi-type routes, but 1,571 of 4,618 fall below 90% and the worst is 48.2%
   * (measured -- the spec's § "The Other band is not a rounding error"). */
  seatShare: number;
  series: SeriesPoint[];
}

/** Total seats and total departures per aircraft type, plus its label. */
interface TypeTotal {
  code: string;
  label: string;
  seats: number;
  departures: number;
}

/** Seats per departure over the whole window, or `null` when nothing was flown.
 *
 * `null`, not 0 and not NaN, and the distinction is load-bearing. A type with no performed
 * departures has an UNKNOWN gauge, not a small one -- aircraft type 650 (DC-9-50) appears on
 * JFK-LAX with 0 seats and 0 departures, so the naive `seats / departures` is 0/0 = NaN, and
 * a NaN comparator result makes Array.prototype.sort's order implementation-defined. Treating
 * it as 0 instead would be worse than undefined behaviour: it would make an aircraft that flew
 * nothing the LIGHTEST band on the chart, which is a claim about metal size drawn from no
 * evidence. Unknown sorts last, matching DuckDB's own NULLS LAST default for `ORDER BY ASC`. */
function gauge(t: TypeTotal): number | null {
  return t.departures === 0 ? null : t.seats / t.departures;
}

/** Ascending, nulls last. */
function byGaugeAscNullsLast(a: TypeTotal, b: TypeTotal): number {
  const ga = gauge(a);
  const gb = gauge(b);
  if (ga === null && gb === null) return a.code.localeCompare(b.code);
  if (ga === null) return 1;
  if (gb === null) return -1;
  // Ties are real (four types at an identical gauge is unlikely; two is not), and an
  // unbroken tie leaves the token assignment at the mercy of input order. `code` is the only
  // stable identity available here -- an arbitrary but deterministic tiebreak, which is the
  // property that matters: the same data must always produce the same chart.
  return ga - gb || a.code.localeCompare(b.code);
}

/** Descending, with the same deterministic tiebreak. */
function bySeatsDesc(a: TypeTotal, b: TypeTotal): number {
  return b.seats - a.seats || a.code.localeCompare(b.code);
}

/** Fold the flat (month, type) rows into stacked-area bands.
 *
 * TWO ORDERINGS, and they are not the same one applied twice. This is the single most
 * important detail in M4c (the spec's § Encoding) and the easiest to collapse by accident:
 *
 *   - MEMBERSHIP -- which five types get their own band -- is by TOTAL SEATS, descending.
 *     Everything else is aggregated into Other.
 *   - SHADE -- which of `--g1`..`--g5` a band gets -- is by GAUGE, ascending, so the lightest
 *     band is the smallest metal and an upgauge darkens the stack.
 *
 * On JFK-LAX the A321nXLR is first by seats AND the lightest by gauge, so it alone cannot tell
 * a correct implementation from a single-sort one; positions 2-5 disagree completely (seats:
 * B767-3/R, B767-4, B757-2, A320-1/2 -- gauge: A320-1/2, B757-2, B767-3/R, B767-4). A chart
 * built from one sort looks entirely plausible and encodes nothing.
 *
 * Returned in SHADE order, `--g1` first. That makes the array directly usable as the stack
 * order: light at the bottom, dark on top, so the ramp reads as a gradient rather than as
 * six unrelated greys, which is the whole reason the categories are ordered at all.
 *
 * Every band carries a point for every month THE SUBJECT FILED, zero-filled where that
 * particular type did not fly -- a stacked area needs every series sampled at the same x or
 * the bands misalign. It carries NO point for a month the subject did not file at all: that
 * month is unknown, not zero, and the returned `axis` is what tells the renderer to break the
 * area there instead of drawing across it. See MonthAxis. */
export function toBands(rows: MixRow[]): {
  bands: Band[];
  other: OtherSummary;
  axis: MonthAxis;
} {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const axis = monthAxis(months);

  const totals = new Map<string, TypeTotal>();
  for (const r of rows) {
    const t = totals.get(r.code) ?? { code: r.code, label: r.label, seats: 0, departures: 0 };
    t.seats += r.seats;
    t.departures += r.departures;
    totals.set(r.code, t);
  }

  const members = [...totals.values()].sort(bySeatsDesc).slice(0, BAND_TOKENS.length);
  const memberCodes = new Set(members.map((t) => t.code));

  // A SECOND sort, of the same five, on a different key. Not `.reverse()`, not a re-slice of
  // the first sort -- see this function's header.
  const shaded = [...members].sort(byGaugeAscNullsLast);

  // month -> code -> seats, so a band's series is a lookup per month rather than a scan.
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? new Map<string, number>();
    m.set(r.code, (m.get(r.code) ?? 0) + r.seats);
    byMonth.set(r.month, m);
  }

  const bands: Band[] = shaded.map((t, i) => ({
    code: t.code,
    label: t.label,
    token: BAND_TOKENS[i],
    series: months.map((month) => ({ month, seats: byMonth.get(month)?.get(t.code) ?? 0 })),
  }));

  const otherTypes = [...totals.values()].filter((t) => !memberCodes.has(t.code));
  const totalSeats = [...totals.values()].reduce((a, t) => a + t.seats, 0);
  const otherSeats = otherTypes.reduce((a, t) => a + t.seats, 0);

  const other: OtherSummary = {
    typeCount: otherTypes.length,
    // Guarded, not because a route with zero seats is expected, but because the alternative
    // is rendering NaN% in the legend rail under a DATA AS OF badge.
    seatShare: totalSeats === 0 ? 0 : otherSeats / totalSeats,
    // Empty, not zero-filled, when there is nothing to aggregate: the renderer gates on
    // `typeCount > 0`, and an all-zero series would otherwise put an invisible band and a
    // "0 other types" legend entry on every chart of a five-type route.
    series:
      otherTypes.length === 0
        ? []
        : months.map((month) => {
            const m = byMonth.get(month);
            return {
              month,
              seats: otherTypes.reduce((a, t) => a + (m?.get(t.code) ?? 0), 0),
            };
          }),
  };

  return { bands, other, axis };
}
