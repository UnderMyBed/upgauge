/** WHAT THE QUARANTINED ROWS DID TO *THESE* NUMBERS -- one sentence, three cases, written ONCE
 * for all four entity pages.
 *
 * "N quarantined rows excluded from these totals" is true only while there ARE totals left to
 * exclude them from. Where every filing in the window was quarantined there is no residue: no
 * measure can be stated at all, and the entity counts are derived from the very rows the
 * sentence claims were excluded. Telling a reader otherwise, on a page whose every other figure
 * is an em dash, describes the data as the opposite of what it is.
 *
 * HERE RATHER THAN IN FOUR PAGES, and the reason is written in `cardSixthStat`'s own docstring:
 * "a shared rule with a single route-local implementation is how the same defect gets re-derived
 * per surface." #121 proved it by doing the opposite -- it copied this three-branch prose into
 * `/route`, `/carrier` and `/aircraft` beside `/airport`'s original, and review found that
 * `/carrier`'s copy could be replaced with garbage while all 1,516 tests and all 663 served
 * checks stayed green. No carrier on this warehouse has a wholly-quarantined window, so that
 * branch is unreachable live and nothing but a unit test can ever reach the string. One
 * implementation, tested at its four cells, is the only shape that closes it.
 *
 * The CALLERS supply only what genuinely differs -- the prepositional phrase naming the subject
 * and the noun phrase naming their own counts. Nothing else about the sentence is theirs to
 * vary, which is what stops four pages drifting into four claims. */
export function quarantineClause({
  subject,
  counts,
  seatsAreNull,
  quarantinedRows,
}: {
  /** The subject as it reads after "Every filing" -- `at A18`, `on A18–LMA`, `by VX`,
   * `on the MD-80`. A phrase and not a bare code, because the right preposition differs per
   * grain and only the page knows which one its subject takes. */
  subject: string;
  /** The page's own count line, as a noun phrase with its verb: `The carrier count is`,
   * `The carrier and destination counts are`, `The aircraft-type count is`. */
  counts: string;
  /** True when no measure on the page can be stated. Both absences produce it -- every filing
   * quarantined, and nothing filed at all -- which is exactly why `quarantinedRows` is the
   * second operand rather than this being the only test. */
  seatsAreNull: boolean;
  /** `count(*) FILTER (WHERE is_quarantined)`, which cannot be NULL. 0 here is the real
   * measurement "nothing on this page was quarantined". */
  quarantinedRows: number;
}): string {
  const rows = `${quarantinedRows} row${quarantinedRows === 1 ? "" : "s"}`;
  if (seatsAreNull) {
    // GATED ON BOTH, and the second half is not redundant. `seatsAreNull` covers TWO absences:
    // every filing quarantined, and nothing filed at all. Only the first is a quarantine story.
    // Telling the second one that "every filing is quarantined — 0 rows" would invent a finding
    // on 11,939 route pages, 44 carriers and 36 aircraft types to fix it on 12.
    if (quarantinedRows === 0) return "";
    // "EVERY filing is quarantined" is INFERRED, not counted: it follows from the sums being
    // null only because `fct_segment_month` carries no NULL `seats`/`passengers`/
    // `departures_performed` on a non-quarantined row (measured: 0, 0, 0). One such row would
    // make this sentence false while leaving the branch reachable. It is a warehouse invariant
    // this code relies on and NO GATE ENFORCES -- no pipeline test or SQL constraint forbids it,
    // and the one runtime check lives in `lib/map/airportNetwork.ts`, at route grain on the map
    // path, which no page foot goes through. `lib/og/entityCard.ts`'s `cardSixthStat` records
    // the same debt for the same reason; the hoist that created this module moved the inference
    // here, so the note belongs here too.
    return (
      `Every filing ${subject} in this window is quarantined — ${rows}, each having failed ` +
      `an invariant — so no measure above can be summed. ${counts} counted from those rows, ` +
      `not net of them.`
    );
  }
  return `${quarantinedRows} quarantined row${quarantinedRows === 1 ? "" : "s"} excluded from these totals, never clamped.`;
}
