/** The caveat is a column, not a tooltip. `n` is a data-availability state, so it renders
 * in ink -- --limit is reserved for out-of-limit conditions and nothing else. */
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
