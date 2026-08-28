import { ImageResponse } from "next/og";
import { OG_FONT_FAMILY, OG_PALETTE } from "./palette";
import { loadCardFonts } from "./fonts";
import { BASE_URL } from "@/lib/siteUrl";

/** The frame Satori draws around the chart's own SVG. The chart itself is never redrawn here --
 * it arrives as `chartSvg`, already produced by `renderPlotToSvg` + `resolveSvgTokens` (the
 * same functions AircraftMixChart uses), so the gap rules and the two orderings (band
 * membership by seats, shade by gauge) stay ONE implementation instead of a second one that can
 * drift from the page.
 *
 * Satori is flexbox-only and errors on a multi-child node with no explicit `display: "flex"`
 * (no `display: grid`, ever) -- every container below that can hold more than one child sets it,
 * even where a single child happens to be present today, because "today" is data-dependent
 * (a card with no derived stat, or no gaps, still shares this tree). */

export interface CardStat {
  label: string;
  value: string;
  derived?: boolean;
}

export interface CardInput {
  title: string; // "JFK–LAX", "DL — Delta Air Lines"
  subtitle: string; // "Domestic segment · 2015-01 to 2026-05"
  stats: CardStat[]; // six, from the page's own stat row
  chartSvg: string | null; // already token-resolved; null when there is nothing to draw
  chartNote: string | null; // why there is no chart, in the page's words; null when there is one
  gaps: number; // unfiled months inside the window
  /** Filed-but-wholly-quarantined months inside the window -- a hole for a DIFFERENT reason
   * than `gaps`, so it gets its own words rather than being added to that count (#121). */
  unknowable: number;
  /** Drawn months a quarantined filing understates. Not a hole; the stack is lower than the
   * month's real total by an amount that cannot be stated. */
  understated: number;
  asOf: string; // "2026-05"
}

export const CARD_SIZE = { width: 1200, height: 630 } as const;

// The chart's own frame is 960x230 (lib/chart/mixPlotConfig.ts) -- every entity page mounts the
// same AircraftMixChart, so every card embeds that ratio. Scaled to the card's content width so
// the <img> never stretches the chart off its native aspect.
const CHART_DISPLAY_WIDTH = 1112;
const CHART_DISPLAY_HEIGHT = Math.round((CHART_DISPLAY_WIDTH * 230) / 960);

const SANS = OG_FONT_FAMILY["font-sans"];
const MONO = OG_FONT_FAMILY["font-mono"];

/** CLAUDE.md: numeric values are monospaced, tabular-figure. A card is a data view, not a
 * marketing asset, so the rule does not lapse at social-preview size. */
const NUMERIC_STYLE: React.CSSProperties = {
  fontFamily: MONO,
  fontVariantNumeric: "tabular-nums",
};

function Wordmark(): React.ReactElement {
  // `upgauge.shipman.dev` must never be hardcoded -- a fork or staging deploy serves its own
  // host, and BASE_URL (lib/siteUrl.ts) is the one place that host is decided.
  const host = new URL(BASE_URL).host;
  return (
    <div style={{ display: "flex", flexDirection: "row", alignItems: "baseline", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "row" }}>
        <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 20, letterSpacing: 2 }}>
          UP
        </span>
        <span
          style={{
            fontFamily: SANS,
            fontWeight: 600,
            fontSize: 20,
            letterSpacing: 2,
            color: OG_PALETTE.signal,
          }}
        >
          GAUGE
        </span>
      </div>
      <span style={{ ...NUMERIC_STYLE, fontSize: 13, color: OG_PALETTE["ink-2"] }}>{host}</span>
    </div>
  );
}

function DataAsOf({ asOf }: { asOf: string }): React.ReactElement {
  return (
    <div
      style={{
        ...NUMERIC_STYLE,
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: 1,
        color: OG_PALETTE.signal,
        border: `1px solid ${OG_PALETTE.signal}`,
        padding: "5px 11px",
      }}
    >
      {/* ONE template string, not two adjacent children -- React's SSR serializer inserts an
          HTML comment between adjacent text/expression siblings to mark hydration boundaries,
          which would split "DATA AS OF: 2026-05" and defeat both this test and any raw-bytes
          smoke needle (the same trap AircraftMixChart.tsx documents on its own title line). */}
      {`DATA AS OF: ${asOf}`}
    </div>
  );
}

function Stat({ stat }: { stat: CardStat }): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <span
          style={{
            fontFamily: SANS,
            fontSize: 13,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: OG_PALETTE["ink-2"],
          }}
        >
          {stat.label}
        </span>
        {/* Derived measures (load factor, avg gauge) are computed at query time from summed
            numerator/denominator, never stored -- CLAUDE.md's non-negotiable. A card that shows
            the figure without saying so presents a computed value as a filed one, which is the
            data-honesty failure this marker exists to prevent. Its own span, not appended to the
            label string, so it stays a separate node the mutant in the brief can drop cleanly. */}
        {stat.derived === true ? (
          <span
            style={{
              fontFamily: SANS,
              fontSize: 11,
              fontStyle: "italic",
              color: OG_PALETTE["ink-3"],
            }}
          >
            computed
          </span>
        ) : null}
      </div>
      <span style={{ ...NUMERIC_STYLE, fontSize: 26, fontWeight: 600, color: OG_PALETTE.ink }}>
        {stat.value}
      </span>
    </div>
  );
}

function Chart({
  chartSvg,
  note,
}: {
  chartSvg: string | null;
  note: string | null;
}): React.ReactElement {
  if (chartSvg === null) {
    return (
      <div
        style={{
          display: "flex",
          width: CHART_DISPLAY_WIDTH,
          height: CHART_DISPLAY_HEIGHT,
          alignItems: "center",
          justifyContent: "center",
          fontFamily: SANS,
          fontSize: 16,
          color: OG_PALETTE["ink-2"],
        }}
      >
        {/* The PAGE's sentence (`mixAbsenceNote`), not a card-local wording of it. A literal
            here read "No filings in this window." for BOTH of that function's findings, so a
            card previewing a page that says "Only one month of filings in this window
            (2025-06)" asserted the opposite of it. */}
        {note}
      </div>
    );
  }
  // Embedded as a data URI, never a remote <img src>. next/og fetches a remote URL over the
  // network at rasterize time; a data URI keeps the card self-contained and gives it the exact
  // bytes renderPlotToSvg + resolveSvgTokens already produced -- no second render, no drift.
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(chartSvg).toString("base64")}`;
  return (
    // Satori rasterizes this whole tree to one PNG -- there is no live DOM for next/image's
    // loader to attach to, and no accessibility tree for `alt` to reach; the card's own
    // accessibility statement is the opengraph-image route's `alt` export (Task 6), which
    // covers the whole rendered image. Empty here on purpose: a non-empty alt on an element
    // Satori never exposes would be dead text nobody can read.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUri}
      alt=""
      width={CHART_DISPLAY_WIDTH}
      height={CHART_DISPLAY_HEIGHT}
      style={{ display: "block" }}
    />
  );
}

export function CardFrame(input: CardInput): React.ReactElement {
  const { title, subtitle, stats, chartSvg, chartNote, gaps, unknowable, understated, asOf } =
    input;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: CARD_SIZE.width,
        height: CARD_SIZE.height,
        padding: 44,
        gap: 16,
        backgroundColor: OG_PALETTE.panel,
        color: OG_PALETTE.ink,
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: 10,
          borderBottom: `1px solid ${OG_PALETTE.rule}`,
        }}
      >
        <Wordmark />
        <DataAsOf asOf={asOf} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontFamily: MONO, fontWeight: 600, fontSize: 42, color: OG_PALETTE.ink }}>
          {title}
        </div>
        <div style={{ fontSize: 18, color: OG_PALETTE["ink-2"] }}>{subtitle}</div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          gap: 32,
          paddingTop: 14,
          paddingBottom: 14,
          borderTop: `1px solid ${OG_PALETTE["rule-2"]}`,
          borderBottom: `1px solid ${OG_PALETTE["rule-2"]}`,
        }}
      >
        {stats.map((stat) => (
          <Stat key={stat.label} stat={stat} />
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Chart chartSvg={chartSvg} note={chartNote} />
      </div>

      {/* Rendered only when gaps > 0. The page states its unfiled-month count in the chart AND
          in the chart's aria-label (system.md § Charts); a rasterized card has no aria-label, so
          this visible line is the only thing left to carry that statement. */}
      {/* THREE CAUSES, THREE PHRASES, joined only for layout (#121). "Unfiled" is false of a
          month that WAS filed and wholly quarantined, and both are false of a month that is
          drawn but understated -- and a card is the surface where a wrong word is unrecoverable,
          since it has no foot, no empty state and no aria-label to correct it. Built as ONE
          string so the row cannot wrap into a second line the card has no height for. */}
      {gaps + unknowable + understated > 0 ? (
        <div style={{ display: "flex", fontFamily: MONO, fontSize: 13, color: OG_PALETTE["ink-3"] }}>
          {[
            gaps > 0 ? `${gaps} unfiled months` : null,
            unknowable > 0 ? `${unknowable} wholly quarantined` : null,
            understated > 0 ? `${understated} understated` : null,
          ]
            .filter((x) => x !== null)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

// No assertion on `fonts`. `loadCardFonts()` (lib/og/fonts.ts) narrows `weight` to Satori's own
// `100 | 200 | ... | 900` at the literals, so the array is already assignable here. An `as` here
// would be worse than redundant: that union is a subtype of `number`, and an assertion to a
// subtype is always permitted -- so a typo'd `550` upstream would have type-checked exactly as
// happily as `600` and failed only inside Satori, at rasterize time, in production.
export function renderEntityCard(input: CardInput): ImageResponse {
  return new ImageResponse(CardFrame(input), {
    ...CARD_SIZE,
    fonts: loadCardFonts(),
  });
}
