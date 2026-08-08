# What Upgauge is

A structural intelligence layer over US DOT / BTS airline data. It answers:

> **"Is this route healthy, and what is the airline about to do to it?"**

It is **not** a flight search tool, a fare tracker, or a real-time product. BTS data is 2–6
months lagged by nature. Design *around* that constraint rather than fighting it — make the
`DATA AS OF` stamp a first-class UI element, not a buried disclaimer.

Two halves, and they need each other:

- **The Explorer** — a real query/pivot surface over T-100. This is the foundation.
- **The Insights** — Gauge Watch, Route Death Watch, Empty Planes, New Routes. Editorial
  entry points that answer a question the Explorer can pose but not rank.

Every insight row must be one click from "show me the raw rows that produced this."
Insights that can't be drilled into feel like astrology.

> **The Insights are NOT saved Explorer queries**, though this file said so until 2026-08.
> Every `meta_pivot_measures` row is a **single-window aggregate**; every preset ranks on a
> **delta between two windows**, which no pivot measure can express. They read
> `mart_route_health` directly and share only `DataTable`'s rank column with the Top-N builder.
>
> M6 disproved the claim and corrected it in six places. It survived *here* — the file
> `docs/README.md` tells every new reader to start with — because this wording is a
> **paraphrase**, and the sweep grepped for the exact phrase. Check corrections by meaning,
> not by string.

**Audience:** aviation enthusiasts and industry-adjacent people. Numerate. They know what a
load factor is. Do not dumb it down; do make it legible.

---

## Decisions locked

| Decision | Resolution |
|---|---|
| Product name | **Upgauge.** Trademark checked — clear in our class. Hosted at **`upgauge.shipman.dev`**; no domain purchase for v0. |
| Rollup model | **Operating carrier is the grain + truth. Optional _date-ranged_ rollup to parent for wholly-owned subsidiaries only.** See [carrier-model](../data/carrier-model.md). |
| History window | **2015 → present.** COVID is in-window on purpose. |
| Public or private | **Public from day one.** |
| Aesthetic | Handled in a separate design session. See [design brief](../design/brief.md). |

### On the name

Chosen because the aircraft-gauge story is the product's real differentiator, not load
factor. Distinctive, ownable, unmistakably aviation-capacity vocabulary.

> ✅ **Trademark: checked, clear in our class.** The only registered `UPGAUGE™` (USPTO
> 90566561) covers home hardware — faucets, lamps, hair dryers — a different class with no
> overlap with a data tool. Nothing in software/data/aviation-information services uses the
> name. Not a formal legal clearance, but no blocking conflict.
>
> "upgauge" is a generic aviation-trade term, so the bare word is SEO-noisy — a mild
> headwind, not a naming problem.
>
> `upgauge.shipman.dev` is a subdomain of a domain we already own. If the tool takes off,
> migrating to an apex domain later is trivial and *that's* the point to revisit a formal
> trademark filing.

---

## UI constraints (product truths, not style preferences)

Visual direction is the [design brief](../design/brief.md)'s job — palette, type
personality, the signature element, map rendering. **Do not invent an aesthetic here.**
These constraints hold regardless of the look chosen:

- **All numerics in a monospaced, tabular-figure face**, right-aligned, fixed decimals. A
  data product with proportional numerals is not serious.
- **`DATA AS OF: YYYY-MM` is a first-class UI element** on every data view, in the accent
  color. The lag is the product's defining honesty; surface it, don't hide it.
- **Density over whitespace.** This is a chart, not a landing page. Sparklines in table rows.
  Hairline rules. No card-soup.
- **URL-encoded query state on every view.** Permalinks are the entire growth mechanic —
  people paste links into forums and Discords. Not optional, not a later add-on.
- **Screenshot- and link-shareable.** Every view must look good pasted into a forum. This
  biases toward a lighter, print-legible surface over a dark dashboard, but the design
  session decides.
- **Honest labels:** derived measures are labeled as computed. Never imply a precision the
  lagged, sampled data doesn't have.
- **Quality floor:** responsive to mobile, visible keyboard focus, reduced-motion honored.
