import type { NetworkMapInput } from "./networkMap";

/**
 * The byte-identity guard for #104's hub-and-spoke -> point-to-point refactor.
 *
 * WHY A LITERAL FIXTURE AND NOT A LIVE `/airport` RENDER: issue #104 proposed asserting that
 * `/airport`'s rendered output stays byte-identical "because the existing map is
 * deterministic". `renderNetworkMap` IS deterministic for a fixed input -- but the pipeline
 * feeding it is not, in three independent ways, so a live render is red for reasons that have
 * nothing to do with this refactor:
 *
 *   1. Destination circles and their labels are emitted in the CALLER'S array order, and that
 *      order comes from `sql/03_queries/pivot_route.sql`'s `ORDER BY seats DESC` with no
 *      tiebreak column -- tied seats are SQL-unspecified.
 *   2. `window` is derived from `asOf` and moves every month.
 *   3. The arc set and `sameAirportSeats` move with every BTS refresh. Already demonstrably
 *      true here: `docs/data/invariants.md` § Route identity records ORD at 274/273
 *      far-endpoints for the trailing 12, while `airportNetwork.test.ts` asserts 268/267
 *      against a FIXED 2025-05..2026-04 window.
 *
 * A literal fixture is also the STRONGER guard: it is stable across BTS refreshes, so it
 * cannot rot the way every hand-written figure in this repo has.
 *
 * There is no snapshot infrastructure in this repo (no `toMatchSnapshot`, no `__snapshots__`),
 * and this file deliberately does not add any -- `GOLDEN_NETWORK_SVG` is an explicit constant,
 * captured from the renderer BEFORE the refactor and never regenerated to make a red test
 * green. If it goes red, the rendered bytes moved; that is the finding, not the problem.
 *
 * WHAT EACH ARC IS FOR -- every branch of the renderer that has an input-shaped trigger:
 *
 *   ORD  self-arc (`code === origin.code`): filtered from the drawn set, seats still counted
 *   SEA  plain conterminous great circle
 *   JFK  the heaviest arc -- pins `maxSeats`, so every other stroke width is relative to it
 *   MIA  seats tied with DEN, and placed BEFORE it in the array, so the `code` tiebreak is
 *        what decides their draw order and a dropped tiebreak moves bytes
 *   DEN  the tie's other half
 *   ANC  `loadFactor` 0.62 -- below LOAD_FACTOR_FLOOR, dashed "5 3"; also cross-panel (ak)
 *   SYA  Alaska's Eareckson, longitude +174.11 -- a POSITIVE longitude that `regionOf` files
 *        as `us` unless normalized first; also 12 departures in its one active month --
 *        below the departure floor -- so it
 *        pins both the dotted "1 3" stroke and the 1.3px `--ink-3` node
 *   HNL  cross-panel into `hi`
 *   GUM  longitude +144.8 -> `pac`, the ONE panel `fitPanels(BASEMAP_FIT_POINTS)` has no entry
 *        for, so this arc is what pins the subject-derived fit FALLBACK staying a fallback
 *   SJU  `loadFactor: null` -> drawn solid, because null is not "low"; also `car`
 *
 * All five panels are reached, so all four inset frames are drawn. Nine destinations against
 * `TOP_LABEL_COUNT` = 8 means exactly one node (SYA, the lightest) goes unlabelled, pinning
 * the slice. Five of the nine are cross-panel, so the `aria-label` takes its alternate
 * wording. The arcs are deliberately in an order that is NEITHER seats-ascending NOR
 * code-alphabetical, so the golden pins the draw-order sort and the caller-order node
 * emission independently of each other.
 */
export const GOLDEN_NETWORK_INPUT: NetworkMapInput = {
  origin: { code: "ORD", lat: 41.98, lon: -87.9, seats: 0, departures: 0, loadFactor: null, activeMonths: 1 },
  arcs: [
    { code: "ORD", lat: 41.98, lon: -87.9, seats: 73_082, departures: 53, loadFactor: 0.8, activeMonths: 1 },
    { code: "HNL", lat: 21.32, lon: -157.92, seats: 180_000, departures: 900, loadFactor: 0.83, activeMonths: 1 },
    { code: "MIA", lat: 25.79, lon: -80.29, seats: 42_000, departures: 300, loadFactor: 0.79, activeMonths: 1 },
    { code: "SYA", lat: 52.71, lon: 174.11, seats: 900, departures: 12, loadFactor: 0.55, activeMonths: 1 },
    { code: "JFK", lat: 40.64, lon: -73.78, seats: 310_000, departures: 1_400, loadFactor: 0.88, activeMonths: 1 },
    { code: "DEN", lat: 39.86, lon: -104.67, seats: 42_000, departures: 300, loadFactor: 0.81, activeMonths: 1 },
    { code: "GUM", lat: 13.48, lon: 144.8, seats: 26_000, departures: 120, loadFactor: 0.71, activeMonths: 1 },
    { code: "ANC", lat: 61.17, lon: -149.99, seats: 64_000, departures: 260, loadFactor: 0.62, activeMonths: 1 },
    { code: "SEA", lat: 47.45, lon: -122.31, seats: 155_000, departures: 700, loadFactor: 0.86, activeMonths: 1 },
    { code: "SJU", lat: 18.44, lon: -66.0, seats: 31_000, departures: 150, loadFactor: null, activeMonths: 1 },
  ],
  window: "2025-05 → 2026-04",
  sameAirportSeats: 73_082,
  basemapPaths: '<path d="M0 0" class="golden-basemap"/>',
};

/** Captured from `renderNetworkMap(GOLDEN_NETWORK_INPUT)` on c7b8be5, BEFORE any of #104's
 *  changes to the renderer, and RE-PINNED THREE TIMES: by #115, by #119 and by #122/#123.
 *  Regenerate ONLY if the rendered bytes are intended to move.
 *
 *  WHY #115 RE-PINNED IT, since re-pinning a byte-identity guard normally deserves suspicion:
 *  THE OLD BYTES WERE THE DEFECT. This fixture held
 *  `<circle cx="-35.2" cy="433.5" r="1.3" .../>` and a polyline running to `-35.2,433.5` --
 *  SYA drawn 35px off the left edge of the canvas, where the stylesheet's
 *  `svg:not(:root) { overflow: hidden }` clips it away. A guard built to protect #104's
 *  refactor was enshrining an off-canvas mark. #115 gave the `ak` panel a declared extent
 *  (build-basemap.mjs's `AK_EXTENT_ANCHORS`), which moves its fit from k=377.8396853372171 to
 *  k=244.54496902469134; the new bytes ARE the fix, not a silenced assertion.
 *
 *  WHY #119 RE-PINNED IT, and how the new bytes were DERIVED rather than accepted -- which,
 *  after the paragraph above, is the only honest way to move this file. #119 gave the `us`
 *  panel a declared southern extent (`US_EXTENT_ANCHORS`, the Marquesas Keys), taking its fit
 *  from {k: 904.5131300948573, ox: 487.1120339377376, oy: 239.57188375255203} to
 *  {k: 892.2437067538316, ox: 487.0155615347458, oy: 236.5663339691636}. That is a pure
 *  similarity transform, and the whole rendered string was checked against it -- 39 elements
 *  before and after in the same order, 20 byte-identical and 19 changed, holding 71 coordinate
 *  pairs between them. TWO DIFFERENT LAWS GOVERN THOSE PAIRS, and conflating them is the one
 *  mistake to avoid here, because applying the first to a label gives a residual that looks
 *  like a defect and is not.
 *
 *  WHY #122/#123 RE-PINNED IT, and how these bytes were DERIVED. Two changes land in one
 *  render, and they are separable by inspection, which is what makes accepting them honest:
 *
 *    #122 moved the five bottom-tray RECTS down 44px so `car`'s frame clears the `us` rect.
 *    `fitPanels` reads a rect's width and height for `k` and adds `ry0` once into `oy`, so a
 *    translation moves `oy` by exactly the offset and changes nothing else -- no `k`, no `ox`,
 *    and no `us` byte at all.
 *
 *    #123 cropped the CANVAS to the panels a map reaches: the `viewBox` window and the footer's
 *    own baseline, which is now anchored to the crop's floor rather than to `HEIGHT`.
 *
 *  CHECKED RATHER THAN ASSUMED, element by element over the whole string: 54 elements before
 *  and after, in the same order, none added and none removed; 35 byte-identical and 19 changed.
 *  Across every one of those 19, the COMPLETE set of numeric deltas is {44, 12, 32} -- and each
 *  of the three is accounted for:
 *
 *    +44  every inset rect, inset label, and arc endpoint that lands in `ak`, `hi` or `car`,
 *         plus the footer baseline (494 -> 538). The tray translation, and nothing else.
 *     12  the `viewBox`'s y origin, 0 -> 12: the crop's top, one frame pad above the `us`
 *         rect's own top edge of 18.
 *     32  the `viewBox`'s height, 500 -> 532, which is 544 - 12 and therefore the same two
 *         numbers again.
 *
 *  Every ORD-anchored coordinate is unchanged -- `580.0,162.2` before and after -- because
 *  `us` was not re-fit, and the `aria-label` is byte-identical, because no copy changed. A
 *  residual anywhere else would have been the finding; there is none.
 *
 *  PROJECTED POINTS -- the 61 that moved, being node and marker centres and every interpolated
 *  vertex of a `us`-to-`us` arc -- satisfy
 *
 *      new = (old - o_old) * (k_new / k_old) + o_new,      ratio 0.9864353286505205
 *
 *  with `o` = ox for x and oy for y. Worst residual 0.0908px, against an admissible ceiling of
 *  0.101px: both sides are rounded to 1dp and the map is applied to an already-rounded input,
 *  so the error is one rounding step in, scaled by the ratio, plus one rounding step out.
 *
 *  LABEL COORDINATES DO NOT, and the formula above is simply not about them. `segmentMap.ts`
 *  :511 and :518 emit label text at `fmt(x + 5), fmt(y + 3)` and `fmt(x - 7), fmt(y - 8)` --
 *  a constant screen-space offset added to the RAW point and rounded independently of the node.
 *  So the law for a label is `label = its own node + that offset`, and because the offsets are
 *  whole pixels while rounding is to 1dp, it holds EXACTLY: all 9 labels are byte-exact against
 *  their own node in both the old and the new bytes, residual 0.0000px. That is a stronger
 *  statement than the affine one, not a weaker one.
 *
 *  Feed a label into the projected-point formula instead and you get up to 0.1254px (the ORD
 *  marker's label, whose offset is the largest at -7/-8) and 0.1113px for JFK -- both past the
 *  0.101px ceiling, and both an artefact of the wrong law rather than a bad byte. Recorded
 *  because that is the shape a reader checking this fixture will land on first.
 *
 *  The remaining 5 of the 71 HELD, and all 5 are the far endpoints of the cross-panel arcs.
 *
 *  THOSE FIVE ARE THE PARTITION ARGUMENT'S OWN CHECK, and they are why this fixture is worth
 *  more than a hash here. `fitPanels` partitions its input by `regionOf` before fitting, so a
 *  `us`-classified anchor CANNOT move another panel. If that were wrong, SYA (39.3,418.4),
 *  GUM (45.7,236.6), ANC (127.1,401.5), HNL (229.4,414.3) and SJU (594.7,399.9) would have
 *  moved. They are byte-identical, and so are their nodes and labels, and so are all four
 *  inset frames (no rect changed -- #119 moved the FIT, not the rect, and could not have moved
 *  the rect: see `US_EXTENT_ANCHORS` for the arithmetic).
 *
 *  WHAT MOVED: the ORD subject marker and its label, the four `us` destinations (MIA, JFK,
 *  DEN, SEA) with their nodes and labels, and every interpolated point of the four `us`-to-`us`
 *  great circles -- plus the ORD end, and only the ORD end, of the five cross-panel straights.
 *
 *    ORD marker  581.4,164.2 -> 580.0,162.2      ORD label  574.4,156.2 -> 573.0,154.2
 *    MIA         711.6,406.4 -> 708.4,401.1      JFK        748.6,158.8 -> 745.0,156.9
 *    DEN         383.2,197.2 -> 384.5,194.8      SEA        208.1, 42.9 -> 211.8, 42.5
 *
 *  DEN and SEA move RIGHT while MIA and JFK move LEFT: the fit shrank about its own centre, so
 *  the sign of the shift is the sign of the point's offset from it. A uniform drift in one
 *  direction would have been the bug.
 *
 *  Total length 4,692 -> 4,691 bytes. SYA still has no label of its own to move: it is the
 *  ninth of nine destinations and the lightest, so `TOP_LABEL_COUNT` = 8 ranks it out -- the
 *  same slice this fixture already existed to pin. */
export const GOLDEN_NETWORK_SVG =
  "<svg viewBox=\"0 12 960 532\" width=\"960\" height=\"532\" role=\"img\" aria-label=\"Network map of ORD's scheduled service, 2025-05 \u2192 2026-04. 9 destinations drawn thinnest to heaviest by seats -- 4 as great-circle arcs, 5 as straight lines across a panel boundary (a great circle cannot cross one). 73,082 same-airport seats excluded from the arcs above, included in this total.\" style=\"font-family:var(--font-mono);font-variant-numeric:tabular-nums\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"30\" y=\"360\" width=\"152\" height=\"158\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"32\" y=\"372\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">ALASKA</text><rect x=\"186\" y=\"430\" width=\"112\" height=\"88\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"188\" y=\"442\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">HAWAI\u2018I</text><rect x=\"34\" y=\"24\" width=\"56\" height=\"228\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"36\" y=\"36\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">MARIANAS</text><rect x=\"418\" y=\"430\" width=\"308\" height=\"88\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"420\" y=\"442\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">CARIBBEAN</text><path d=\"M0 0\" class=\"golden-basemap\"/><polyline points=\"580.0,162.2 39.3,462.4\" fill=\"none\" stroke=\"var(--ink-3)\" stroke-width=\"1.00\" stroke-dasharray=\"1 3\" stroke-opacity=\"0.75\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 45.7,236.6\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.54\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 594.7,443.9\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.62\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 558.2,165.6 536.5,169.1 514.7,172.6 493.0,176.2 471.3,179.8 449.6,183.5 427.9,187.2 406.2,191.0 384.5,194.8\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.77\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 590.7,182.2 601.3,202.2 612.0,222.2 622.6,242.3 633.2,262.3 643.9,282.3 654.6,302.3 665.3,322.2 676.0,342.0 686.8,361.8 697.6,381.5 708.4,401.1\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.77\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 127.1,445.5\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2.02\" stroke-dasharray=\"5 3\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 559.9,154.9 539.7,147.7 519.6,140.6 499.3,133.5 479.1,126.4 458.8,119.5 438.4,112.6 418.0,105.8 397.6,99.1 377.1,92.5 356.6,85.9 336.0,79.5 315.4,73.1 294.8,66.8 274.1,60.6 253.3,54.5 232.6,48.4 211.8,42.5\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2.75\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 229.4,458.3\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2.91\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"580.0,162.2 600.6,161.4 621.2,160.6 641.9,159.9 662.5,159.2 683.1,158.6 703.7,158.0 724.3,157.4 745.0,156.9\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"3.60\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><circle cx=\"229.4\" cy=\"458.3\" r=\"2\" fill=\"var(--ink)\"/><text x=\"234.4\" y=\"461.3\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">HNL</text><circle cx=\"708.4\" cy=\"401.1\" r=\"2\" fill=\"var(--ink)\"/><text x=\"713.4\" y=\"404.1\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">MIA</text><circle cx=\"39.3\" cy=\"462.4\" r=\"1.3\" fill=\"var(--ink-3)\"/><circle cx=\"745.0\" cy=\"156.9\" r=\"2\" fill=\"var(--ink)\"/><text x=\"750.0\" y=\"159.9\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">JFK</text><circle cx=\"384.5\" cy=\"194.8\" r=\"2\" fill=\"var(--ink)\"/><text x=\"389.5\" y=\"197.8\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">DEN</text><circle cx=\"45.7\" cy=\"236.6\" r=\"2\" fill=\"var(--ink)\"/><text x=\"50.7\" y=\"239.6\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">GUM</text><circle cx=\"127.1\" cy=\"445.5\" r=\"2\" fill=\"var(--ink)\"/><text x=\"132.1\" y=\"448.5\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">ANC</text><circle cx=\"211.8\" cy=\"42.5\" r=\"2\" fill=\"var(--ink)\"/><text x=\"216.8\" y=\"45.5\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">SEA</text><circle cx=\"594.7\" cy=\"443.9\" r=\"2\" fill=\"var(--ink)\"/><text x=\"599.7\" y=\"446.9\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">SJU</text><circle cx=\"580.0\" cy=\"162.2\" r=\"4.5\" fill=\"var(--field)\" stroke=\"var(--signal)\" style=\"stroke-width:1.8\"/><text x=\"573.0\" y=\"154.2\" text-anchor=\"end\" font-size=\"11\" font-weight=\"600\" fill=\"var(--signal)\">ORD</text><text x=\"8\" y=\"538\" font-size=\"10\" fill=\"var(--ink-2)\">2025-05 \u2192 2026-04 \u00b7 73,082 same-airport seats excluded from the arcs above, included in this total.</text></svg>";
