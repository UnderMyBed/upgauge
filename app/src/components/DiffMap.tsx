import { SegmentMap } from "@/components/SegmentMap";
import { segmentMapWindow } from "@/lib/map/segmentMap";
import {
  DIFF_CATEGORIES,
  DIFF_CATEGORY_LABELS,
  diffPanelTitle,
  type CarrierDiff,
  type DiffCategory,
} from "@/lib/map/carrierDiff";

/**
 * EVERY SENTENCE BELOW IS ONE TEMPLATE STRING, never adjacent JSX expressions, and that is a
 * hard requirement rather than a style: React's SSR emits `<!-- -->` between adjacent text
 * nodes, so `... {carrier} added {n} pairs ...` puts comment markers INSIDE the sentence in the
 * served bytes. Every unit test still passes -- `textContent` skips comment nodes -- while a
 * `grep` over the served HTML stops matching, which is the "green suite, broken production"
 * shape `app/smoke.sh` exists to catch and has been bitten by before (`grainNote`'s comment on
 * carrier/[code]/page.tsx carries the same rule for the same reason).
 *
 * Typographic characters are written LITERALLY here (U+2019, U+2014), not as JSX entities: JSX
 * decodes entities at compile time and React emits the raw code point, so a smoke needle copied
 * off an `&rsquo;` could never fire. What is in this file is what is in the bytes.
 */

/** What each panel's count sentence CLAIMS, as the query's own predicate rather than a summary
 * of it. Each is `departures_performed >= 1` in the window named -- the shared floor
 * `map_carrier_diff.sql` applies to all three categories so the panels stay comparable.
 *
 * "the 12 months before it" / "after it", never "the prior window" / "the trailing window": the
 * OTHER window is not on the row. `CarrierDiff.window` is this category's own window only --
 * trailing for added and downgauged, PRIOR for dropped -- and carrierDiff.ts's contract says to
 * read it off the query rather than re-derive it from `asOf`. A carrier can also have exactly
 * one category (ZW: 92 dropped, 0 added, 0 downgauged), so the other window is not reliably
 * anywhere on the page to point at. A relative clause is exact without inventing a date. */
const COUNT_CLAUSE: Record<DiffCategory, string> = {
  added: "flown in this window, and not flown in the 12 months before it",
  dropped: "flown in this window, and not flown in the 12 months after it",
  downgauged: "flown in both windows, at fewer seats per departure in this one",
};

function countNote(carrier: string, d: CarrierDiff): string {
  // The TRUE pre-cap count, straight off `totalRoutes`. Never `segments.length`: the producer
  // cut this panel at NETWORK_ARC_CAP, so on OO's added panel that would read 400 instead of
  // 1,624 -- and SegmentMap's own "400 of 1,624 routes drawn." sentence sits directly above it.
  const n = d.map.totalRoutes;
  const noun = `route pair${n === 1 ? "" : "s"}`;
  return `${diffPanelTitle(carrier, d.category)} ${n.toLocaleString("en-US")} ${noun} — ${COUNT_CLAUSE[d.category]}.`;
}

/** map_carrier_diff.sql's quarantine section, whose exclusion is NARROWER than the sentence
 * `segmentMap.ts`'s own `quarantinedNote` writes for #105. That one says "not drawn -- failed an
 * invariant"; measured over these 25 carrier-routes, ZERO have both windows quarantined and 7
 * performed real departures in the window that stayed clean (8V BTI-VEE has 8). "Every filing
 * behind them was quarantined" is false of 100% of them. The property they actually share is
 * that the window DECIDING the category was wholly quarantined, so no category could be
 * assigned -- which is also why they belong to no panel and are stated once, here. */
function quarantineNote(carrier: string, routes: number): string {
  const subject = routes === 1 ? "route pair is" : "route pairs are";
  return (
    `${routes.toLocaleString("en-US")} of ${carrier}’s ${subject} on no panel above: the ` +
    "12-month window that decides the category was wholly quarantined, so no category could be " +
    "assigned. They are excluded from every count on this page, never clamped."
  );
}

/** map_carrier_diff.sql:97 -- 4,691 of 8,357 added carrier-routes (56.1%) had already FILED that
 * pair before the prior window, so "first appearance" is false of the majority of this panel.
 * PREDICATE: EXISTS a fct_route_month row, same op_airline_id, same (route_key_low,
 * route_key_high), year_month < p12_start_month. The figures stay in this comment rather than in
 * the served copy deliberately: they are dataset-wide, they move on every BTS refresh, and
 * `test_stated_counts.py` gates only the seven measures in its manifest -- so stating them on
 * the page would create a figure that rots SILENTLY, which is the failure that gate exists to
 * make impossible for the figures it does cover. The CLAIM is required; the digits are not. */
function reEntryNote(carrier: string): string {
  return (
    "Added means re-entry, not first appearance. This compares two 12-month windows and looks " +
    `no further back, so a pair ${carrier} flew years ago, stopped, and has now returned to ` +
    "counts as added here."
  );
}

/** map_carrier_diff.sql:111 -- 3,640 of 5,959 dropped carrier-routes (61.1%) had a DIFFERENT
 * carrier flying the same pair inside the trailing window; the largest is F9 DFW-IAH, where 10
 * other carriers filed 1,704,401 seats on the pair F9 left. Same predicate as the added one with
 * the trailing window substituted. "New service nobody flew last year" is the exact sentence
 * /watch/new-routes shipped wrong, on this same grain; this is the other direction of it. */
function otherCarrierNote(carrier: string): string {
  return (
    `A dropped pair is dropped by ${carrier}, not by the industry — another carrier may still ` +
    `be flying it, and this map cannot see that. Every count here is a carrier-route pair: ` +
    `${carrier}’s own service on that pair, never the pair itself.`
  );
}

/**
 * What one carrier added, dropped and downgauged, as three small multiples.
 *
 * CATEGORY IS ENCODED BY POSITION, and this component imposes that order from `DIFF_CATEGORIES`
 * rather than trusting the order it is handed. `arcs.ts` has already spent width on seats, dash
 * on load factor and dotted-muted on the departure floor, so position is the channel left for
 * category -- which makes the order semantic, and makes rendering arrival order a silent change
 * to what the map means.
 *
 * PANELS ARE STACKED, NOT SET SIDE BY SIDE, and that is a measurement rather than a taste.
 * `.body` is `minmax(0, 1fr) 214px` inside a 1200px `.wrap` with 20px padding and a 24px gap, so
 * the main column is 922px; three across is 291px each, and `renderSegmentMap`'s canvas is
 * 960px wide whose labels are `font-size="10"` -- roughly 3px once scaled. A small
 * multiple whose panels cannot be read is not a comparison. Stacking preserves the encoding --
 * first, second, third is still position -- and gives each panel the full column.
 *
 * EACH PANEL NORMALIZES AGAINST ITS OWN MAXIMUM, which falls out of giving each its own
 * `SegmentMapInput`: `renderSegmentMap` derives `maxSeats` from the lines it is handed
 * (segmentMap.ts:448). It is asserted anyway, because the property is a claim about MEANING and
 * not about today's call graph -- an added route's seats and a dropped route's are counted over
 * two different windows, so one width scale across both would look comparable without being
 * comparable.
 *
 * THE DISCLOSURE COPY HAS ONE OWNER PER SENTENCE. The cap, quarantine and same-airport sentences
 * belong to `disclosureNotes()` and `SegmentMap` renders them; nothing here re-words them. The
 * sentences in this file are the ones that exist NOWHERE else, because no other surface knows
 * this map is a diff: what "added" and "dropped" do not claim, which window each panel's arcs
 * are measured over, and the ranking key of the downgauged panel.
 */
export function DiffMap({
  diffs,
  quarantinedRoutes,
  carrier,
}: {
  diffs: CarrierDiff[];
  /** CARRIER-WIDE, off `CarrierDiffResult` and never off a panel: a route excluded because the
   *  window deciding it was wholly quarantined HAS no category, so there is no panel it belongs
   *  to. Stated once, here, for the measured reason -- across three panels 8V's same 16 read as
   *  48 to anyone who sums the small multiple. */
  quarantinedRoutes: number;
  /** The display code, for every count sentence and every panel's accessible name. */
  carrier: string;
}) {
  const byCategory = new Map(diffs.map((d) => [d.category, d]));
  const ordered = DIFF_CATEGORIES.map((c) => byCategory.get(c)).filter(
    (d): d is CarrierDiff => d !== undefined,
  );

  // ONE CANVAS WINDOW ACROSS THE SET (#123). `renderSegmentMap` crops each map's canvas to what
  // that map needs -- the panels it reaches, unioned with the ink it actually emits. Right for a
  // single map, wrong for a small multiple: panels of different heights, stacked under one
  // heading, are a second and unintended encoding on top of the position one this component
  // already spends on category (see the header).
  //
  // MEASURE, UNION, HAND BACK. Two things can split the set, and only the union closes both.
  // Reach is the obvious one -- a dropped-routes panel that goes to Alaska and an added-routes
  // panel that stays conterminous. INK is the one that is easy to miss: with BLI (the
  // northernmost fact-present `us` airport, whose node label rides above the `us` band) in the
  // added panel alone, every panel reaches `us` and only `us`, yet the boxes came out
  // `0 9 960 453`, `0 12 960 450`, `0 12 960 450` -- different top AND different height.
  //
  // RESERVING PANELS ACROSS THE SET IS NOT A SECOND STEP, and it is worth saying so because it
  // looks like one. Passing every member the union of the panels ANY of them reaches is provably
  // inert: `floor`, `ceil` and `max(0, .)` are all monotone, so the union of the unreserved
  // windows is identical to the union of the reserved ones -- the union of the parts is the
  // whole either way. Reserving and then NOT unioning is the combination that splits the set, so
  // the union is the step that matters and it is the only one.
  //
  // MEASURE THE INPUT THAT IS ACTUALLY RENDERED. The panel input is built ONCE, here, and the
  // same object is both measured and handed to `<SegmentMap>`. Measuring `d.map` and rendering
  // `{...d.map, title}` is a divergence that looks harmless and is not: `title` adds a second
  // footer line, the window a two-line footer needs is 12px taller, and the override would then
  // pin every panel to a box measured for a footer it does not have -- putting the upper line
  // back over the map it was just moved off. `segmentMapWindow` asks the renderer rather than
  // recomputing its geometry, so the only way to ask the wrong question is to hand it the wrong
  // input.
  //
  // `title` is refined from the producer's bare label to the carrier-qualified form, because it
  // is the only field reaching the SVG's accessible name and `arcsSentence`'s "N routes drawn"
  // does not name the carrier.
  //
  // Neither measuring nor sharing widens what is DRAWN: no fit changes, no extra frame is
  // emitted, and a panel still draws only the panels its own network reaches.
  const panels = ordered.map((d) => ({
    d,
    input: { ...d.map, title: diffPanelTitle(carrier, d.category) },
  }));
  const windows = panels.map((p) => segmentMapWindow(p.input));
  const cropWindow =
    windows.length === 0
      ? undefined
      : {
          top: Math.min(...windows.map((w) => w.top)),
          bottom: Math.max(...windows.map((w) => w.bottom)),
        };

  // A carrier with no change AND nothing withheld gets no section at all -- fetchAirportNetwork's
  // "no panel rather than an empty panel" rule. `quarantinedRoutes` ALONE is enough to render,
  // though: F4 (21615) has 3 undrawable carrier-routes and ZERO drawable arcs, so gating the
  // section on the panels would drop the one count that says anything was there -- the "no
  // trace" this field exists to prevent, on a live page.
  if (ordered.length === 0 && quarantinedRoutes <= 0) return null;

  return (
    <section className="diff-map" data-testid="diff-map">
      <h2>{`What ${carrier} added, dropped and downgauged`}</h2>
      <p className="foot">
        The trailing 12 months against the 12 before them. Each panel is scaled to its own
        heaviest route: an added route’s seats and a dropped route’s seats are counted over
        different windows, so a single width scale across both would look comparable without
        being comparable.
      </p>

      {ordered.length === 0 ? (
        <p className="foot" data-testid="diff-empty">
          {`No route pair of ${carrier}’s changed in a way this map can draw.`}
        </p>
      ) : null}

      {panels.map(({ d, input }) => {
        // KEYED ON THE DATA, not on `d.category === "downgauged"`. `SegmentDatum.rankedBy` is
        // `number | null | undefined` and the producer emits an explicit `null` on added and
        // dropped (carrierDiff.ts:116), so `"rankedBy" in seg` and `seg.rankedBy !== undefined`
        // are both TRUE there and both put this sentence on all three panels. `typeof ===
        // "number"` is the only predicate true of exactly the panels ranked on a quantity no arc
        // encodes -- and keying on the data is what makes those two misreadings killable.
        const ranked = d.map.segments.some((s) => typeof s.rankedBy === "number");
        return (
          <div className="diff-panel" data-testid="diff-panel" key={d.category}>
            {/* UPPERCASED IN CSS, not here: an all-caps DOM string is announced letter by
                letter by some screen readers, and this label is the visible half of the same
                fact the map's own accessible name carries. `.mp-legend` and `.search-group h2`
                set the same precedent. */}
            <div className="dp-label" data-testid="diff-panel-label">
              {DIFF_CATEGORY_LABELS[d.category]}
            </div>
            <div className="dp-window" data-testid="diff-panel-window">
              {d.window}
            </div>
            {/* `input` is the OBJECT THAT WAS MEASURED, above -- see the comment there. */}
            <SegmentMap map={{ ...input, cropWindow }} />
            {/* ONE `.foot` container, one `<p>` per note. `.foot` carries `border-top`
                (globals.css:449), so sibling `.foot` paragraphs stack a hairline rule EACH --
                on a downgauged panel that is three rules in a row counting SegmentMap's own
                notes block. `.foot p + p` already spaces the paragraphs inside one container,
                which is the shape `SegmentMap.tsx` and `AircraftMixChart.tsx` both use. */}
            <div className="foot">
              <p data-testid="diff-panel-count">{countNote(carrier, d)}</p>
              {ranked ? (
                <p data-testid="diff-panel-ranking">
                  Ranked and cut by the fall in seats per departure, not by size — a route that
                  lost a lot of gauge outranks a much bigger route that lost a little, and any
                  fall at all qualifies, however small. The arcs cannot show that ranking: width
                  encodes seats, which runs the other way inside this panel, and every route
                  under 30 departures draws the same dotted hairline.
                </p>
              ) : null}
            </div>
          </div>
        );
      })}

      {/* The section's own claims, in ONE `.foot` container for the reason the panel's are --
          four sibling `.foot` paragraphs would draw four hairline rules down the page. */}
      <div className="foot">
        {quarantinedRoutes > 0 ? (
          <p data-testid="diff-quarantine">{quarantineNote(carrier, quarantinedRoutes)}</p>
        ) : null}
        <p>{reEntryNote(carrier)}</p>
        <p>{otherCarrierNote(carrier)}</p>
        <p>
          Each panel’s arcs are measured over the window that panel names, including the dotted
          under-30-departures stroke — for dropped routes those are departures in the earlier
          window, not recent ones.
        </p>
      </div>
    </section>
  );
}
