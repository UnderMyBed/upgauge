/** The caveat is a column, not a tooltip. `n` is a data-availability state, so it renders
 * in ink -- --limit is reserved for out-of-limit conditions and nothing else. This glyph is
 * the gutter's severity pick (`Q` > `⌀` > `n`, see DataTable.tsx's `reasonFor`) and is
 * independent of whether the row also gets the below-floor row treatment -- a row can show
 * `⌀` here and still carry the dashed rule and muted gauge tick. */
export type Reason = "zeroPax" | "belowFloor" | "quarantined" | null;

const GLYPH: Record<Exclude<Reason, null>, { mark: string; label: string; limit: boolean }> = {
  zeroPax: { mark: "⌀", label: "Filed departures carrying zero passengers", limit: true },
  belowFloor: { mark: "n", label: "Below the 30-departure floor — reported, never scored", limit: false },
  quarantined: { mark: "Q", label: "Quarantined — failed an invariant", limit: true },
};

export function ReasonCode({ reason }: { reason: Reason }) {
  if (reason === null) return <td className="gut" />;
  const g = GLYPH[reason];
  return (
    <td className="gut" data-limit={g.limit ? "true" : undefined}>
      <abbr title={g.label}>{g.mark}</abbr>
    </td>
  );
}
