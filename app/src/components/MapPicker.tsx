import { formatSeats } from "@/lib/format";
import type { MapFilter } from "@/lib/map/mapFilter";
import type { PickerOption } from "@/lib/map/picker";

/**
 * The filter control under a point-to-point map, and the map section's refusal states.
 *
 * REAL ANCHORS, NEVER BUTTONS. Every map on this site is server-rendered and visible with JS
 * off; a picker that needs a click handler to change the view would be the one control on the
 * page that is inert in the HTML actually served. The href is the whole mechanism -- it is also
 * what makes each filtered map a permalink, which is this product's growth mechanic
 * (CLAUDE.md, UI constraints).
 *
 * Shape follows `.year-track`, the existing nav-of-anchors on `/airport`: a wrapping flex row,
 * `aria-current="page"` for the showing view, and `--signal` plus a weight change as the visible
 * half of that same fact -- colour is never the sole channel.
 *
 * THE THREE REFUSALS ARE THREE DIFFERENT FINDINGS and they are worded apart on purpose. A value
 * that names NOTHING and a value that names SEVERAL are not the same answer, and this project
 * has already paid for collapsing them: `/carrier/PA` holds three airline_ids -- two Pan Am eras
 * plus an unrelated Florida Coastal -- and picking one is the silent-pick failure the split
 * exists to refuse. So `ambiguous` names every holder and chooses none, and `unknown` wires
 * `mapFilter.ts`'s own `reason` through to the reader rather than swallowing it for a generic
 * message. The picker list stays rendered underneath either one: a refusal that leaves the
 * reader with no way forward is a dead end, which is the same reason `/aircraft`'s 404 lists its
 * candidates.
 */
export function MapPicker({
  options,
  filter,
  legend,
  truncated,
}: {
  options: PickerOption[];
  /** The resolved filter for this map. `ok` is the only kind that may mark a current view. */
  filter: MapFilter;
  /** What the list is OF -- "Aircraft type" | "Carrier". Also supplies the prose subject. */
  legend: string;
  /** The page's own pivot hit its LIMIT, so this list is the top of a longer one. Passed in
   *  because only the page knows its own limit; this component cannot infer it from `options`. */
  truncated: boolean;
}) {
  const subject = legend.toLowerCase();

  return (
    <nav className="map-picker" data-testid="map-picker" aria-label={`${legend} shown on the map`}>
      <p className="mp-legend">{legend}</p>

      {filter.kind === "ambiguous" ? (
        <div className="mp-refusal">
          <p>
            &lsquo;{filter.raw}&rsquo; names more than one {subject} in this dataset. We won&rsquo;t
            pick one for you — choose below.
          </p>
          <ul>
            {/* Every holder, in the order the resolver sorted them. Naming only the plausible one
                IS the silent pick this refusal exists to avoid. Plain text, not links: the point
                is that this value does not identify a subject, so there is no page to link to. */}
            {filter.holders.map((holder, i) => (
              <li key={`${holder}-${i}`} data-testid="mp-holder">
                {holder}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {filter.kind === "unknown" ? (
        <div className="mp-refusal">
          {/* The resolver's curated reason, verbatim -- it is the only thing that says WHICH way
              this value failed (unknown code, non-canonical spelling, a `%` spelling). */}
          <p>
            No map for &lsquo;{filter.raw}&rsquo;: {filter.reason}. Pick from the list below.
          </p>
        </div>
      ) : null}

      {options.length === 0 ? (
        <p className="mp-empty">Nothing to map — no {subject} on this page has a route to draw.</p>
      ) : (
        <ul className="mp-list">
          {options.map((o) => (
            <li key={o.value}>
              <a
                href={o.href}
                // ONLY on a resolved filter. `aria-current="page"` asserts "this is the view you
                // are looking at", and on a refusal no view resolved -- the option still carries
                // `selected`, so this guard is the only thing preventing a false claim.
                aria-current={filter.kind === "ok" && o.selected ? "page" : undefined}
              >
                {o.title !== null && o.title !== o.label ? (
                  <abbr title={o.title}>{o.label}</abbr>
                ) : (
                  o.label
                )}
                {/* The quantity the list is ORDERED by, stated rather than left to be inferred.
                    Monospaced and tabular so the column of figures reads as a column.

                    NULL IS NOT ZERO AND IS NOT A DASH HERE. `seats` is a FILTERed sum
                    (`301_meta_pivot_measures.sql:23`), so NULL means every filing behind this
                    option was quarantined and the total is unknowable -- `/carrier/F4`'s types
                    `489` and `201` are live examples. `0` would be a measurement claim about
                    absent data; a bare "—" beside a column of figures reads as zero at a glance
                    and says nothing about what the reader gets for clicking. The word does both:
                    it marks the absence AND names its cause, which is the count-plus-reason form
                    CLAUDE.md requires of quarantine everywhere else in this app. The map behind
                    the link says the same thing at greater length. */}
                {o.seats === null ? (
                  <span className="mp-seats mp-absent">quarantined</span>
                ) : (
                  <span className="mp-seats">{formatSeats(o.seats)}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="mp-note">
          This picker lists the largest by seats, not every {subject} on this page.
        </p>
      ) : null}
    </nav>
  );
}
