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
 *        as `us` unless normalized first; also 12 departures, below DEPARTURE_FLOOR, so it
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
  origin: { code: "ORD", lat: 41.98, lon: -87.9, seats: 0, departures: 0, loadFactor: null },
  arcs: [
    { code: "ORD", lat: 41.98, lon: -87.9, seats: 73_082, departures: 53, loadFactor: 0.8 },
    { code: "HNL", lat: 21.32, lon: -157.92, seats: 180_000, departures: 900, loadFactor: 0.83 },
    { code: "MIA", lat: 25.79, lon: -80.29, seats: 42_000, departures: 300, loadFactor: 0.79 },
    { code: "SYA", lat: 52.71, lon: 174.11, seats: 900, departures: 12, loadFactor: 0.55 },
    { code: "JFK", lat: 40.64, lon: -73.78, seats: 310_000, departures: 1_400, loadFactor: 0.88 },
    { code: "DEN", lat: 39.86, lon: -104.67, seats: 42_000, departures: 300, loadFactor: 0.81 },
    { code: "GUM", lat: 13.48, lon: 144.8, seats: 26_000, departures: 120, loadFactor: 0.71 },
    { code: "ANC", lat: 61.17, lon: -149.99, seats: 64_000, departures: 260, loadFactor: 0.62 },
    { code: "SEA", lat: 47.45, lon: -122.31, seats: 155_000, departures: 700, loadFactor: 0.86 },
    { code: "SJU", lat: 18.44, lon: -66.0, seats: 31_000, departures: 150, loadFactor: null },
  ],
  window: "2025-05 → 2026-04",
  sameAirportSeats: 73_082,
  basemapPaths: '<path d="M0 0" class="golden-basemap"/>',
};

/** Captured from `renderNetworkMap(GOLDEN_NETWORK_INPUT)` on c7b8be5, BEFORE any of #104's
 *  changes to the renderer. Regenerate ONLY if the rendered bytes are intended to move. */
export const GOLDEN_NETWORK_SVG =
  "<svg viewBox=\"0 0 960 500\" width=\"960\" height=\"500\" role=\"img\" aria-label=\"Network map of ORD's scheduled service, 2025-05 \u2192 2026-04. 9 destinations drawn thinnest to heaviest by seats -- 4 as great-circle arcs, 5 as straight lines across a panel boundary (a great circle cannot cross one). 73,082 same-airport seats excluded from the arcs above, included in this total.\" style=\"font-family:var(--font-mono);font-variant-numeric:tabular-nums\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"30\" y=\"316\" width=\"152\" height=\"158\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"32\" y=\"328\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">ALASKA</text><rect x=\"186\" y=\"386\" width=\"112\" height=\"88\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"188\" y=\"398\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">HAWAI\u2018I</text><rect x=\"34\" y=\"24\" width=\"56\" height=\"228\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"36\" y=\"36\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">MARIANAS</text><rect x=\"418\" y=\"386\" width=\"308\" height=\"88\" fill=\"none\" stroke=\"var(--rule-2)\" style=\"stroke-width:1\"/><text x=\"420\" y=\"398\" font-size=\"8\" letter-spacing=\"0.1em\" fill=\"var(--ink-3)\">CARIBBEAN</text><path d=\"M0 0\" class=\"golden-basemap\"/><polyline points=\"581.4,164.2 -35.2,433.5\" fill=\"none\" stroke=\"var(--ink-3)\" stroke-width=\"1.00\" stroke-dasharray=\"1 3\" stroke-opacity=\"0.75\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 45.7,236.6\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.54\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 594.7,399.9\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.62\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 559.3,167.7 537.3,171.2 515.2,174.8 493.2,178.4 471.1,182.1 449.1,185.8 427.1,189.5 405.1,193.4 383.2,197.2\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.77\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 592.2,184.4 603.0,204.7 613.8,225.1 624.6,245.4 635.3,265.7 646.2,285.9 657.0,306.2 667.8,326.4 678.7,346.5 689.6,366.5 700.6,386.5 711.6,406.4\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"1.77\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 100.5,407.4\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2.02\" stroke-dasharray=\"5 3\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 561.0,156.8 540.6,149.5 520.1,142.2 499.6,135.0 479.1,127.9 458.5,120.9 437.9,113.9 417.2,107.0 396.5,100.2 375.7,93.5 354.9,86.9 334.1,80.3 313.2,73.8 292.2,67.5 271.2,61.2 250.2,55.0 229.2,48.9 208.1,42.9\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2.75\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 229.4,414.3\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"2.91\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><polyline points=\"581.4,164.2 602.3,163.4 623.2,162.6 644.1,161.8 665.0,161.1 685.9,160.5 706.8,159.9 727.7,159.3 748.6,158.8\" fill=\"none\" stroke=\"var(--ink)\" stroke-width=\"3.60\" stroke-opacity=\"0.62\" stroke-linecap=\"round\"/><circle cx=\"229.4\" cy=\"414.3\" r=\"2\" fill=\"var(--ink)\"/><text x=\"234.4\" y=\"417.3\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">HNL</text><circle cx=\"711.6\" cy=\"406.4\" r=\"2\" fill=\"var(--ink)\"/><text x=\"716.6\" y=\"409.4\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">MIA</text><circle cx=\"-35.2\" cy=\"433.5\" r=\"1.3\" fill=\"var(--ink-3)\"/><circle cx=\"748.6\" cy=\"158.8\" r=\"2\" fill=\"var(--ink)\"/><text x=\"753.6\" y=\"161.8\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">JFK</text><circle cx=\"383.2\" cy=\"197.2\" r=\"2\" fill=\"var(--ink)\"/><text x=\"388.2\" y=\"200.2\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">DEN</text><circle cx=\"45.7\" cy=\"236.6\" r=\"2\" fill=\"var(--ink)\"/><text x=\"50.7\" y=\"239.6\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">GUM</text><circle cx=\"100.5\" cy=\"407.4\" r=\"2\" fill=\"var(--ink)\"/><text x=\"105.5\" y=\"410.4\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">ANC</text><circle cx=\"208.1\" cy=\"42.9\" r=\"2\" fill=\"var(--ink)\"/><text x=\"213.1\" y=\"45.9\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">SEA</text><circle cx=\"594.7\" cy=\"399.9\" r=\"2\" fill=\"var(--ink)\"/><text x=\"599.7\" y=\"402.9\" font-size=\"9\" font-weight=\"600\" fill=\"var(--ink)\">SJU</text><circle cx=\"581.4\" cy=\"164.2\" r=\"4.5\" fill=\"var(--field)\" stroke=\"var(--signal)\" style=\"stroke-width:1.8\"/><text x=\"574.4\" y=\"156.2\" text-anchor=\"end\" font-size=\"11\" font-weight=\"600\" fill=\"var(--signal)\">ORD</text><text x=\"8\" y=\"494\" font-size=\"10\" fill=\"var(--ink-2)\">2025-05 \u2192 2026-04 \u00b7 73,082 same-airport seats excluded from the arcs above, included in this total.</text></svg>";
