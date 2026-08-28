/**
 * The builder's one visual atom, and the reason it is one file: every control in
 * `components/builder/` renders the same thing -- an option that is either reachable (an
 * anchor) or refused (an inert span that says why).
 *
 * REAL ANCHORS, NEVER BUTTONS, for the reason `MapPicker` states: a native form GET cannot
 * emit this product's permalink at all (the spec's § "The finding that shapes everything"),
 * and every view here is server-rendered and visible with JS off. A `<button>` would be inert
 * in the HTML actually served.
 *
 * AN UNAVAILABLE OPTION IS RENDERED, NOT OMITTED. Dropping `aircraft_type` from the list at
 * route grain would leave a reader wondering where it went; rendering it inert with its reason
 * answers the question in place. Same rule as `/aircraft`'s 404 listing its candidates, and as
 * `MapPicker` keeping the option list rendered underneath a refusal.
 */
export function Chip({
  href,
  label,
  current,
  derived,
  reason,
}: {
  href: string | null;
  label: string;
  current?: boolean;
  derived?: boolean;
  reason?: string;
}) {
  const className = derived ? "chip chip-derived" : "chip";
  if (href === null) {
    return (
      <span className={`${className} chip-off`} title={reason}>
        {label}
      </span>
    );
  }
  return (
    <a className={className} href={href} aria-current={current ? "page" : undefined}>
      {label}
    </a>
  );
}

/** One labelled row of the builder. The URL key is displayed, not decorative. */
export function ChipRow({
  urlKey,
  label,
  children,
}: {
  urlKey: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="chip-row">
      <span className="chip-label">
        {label} <code className="chip-key">{urlKey}</code>
      </span>
      <div className="chip-set">{children}</div>
    </div>
  );
}
