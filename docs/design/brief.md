# Upgauge — Design Brief

> ✅ **This brief has been answered. The design lives in [`system.md`](system.md)**, with
> working mockups in [`mockups/`](mockups/). This file is kept as the *problem statement* —
> the constraints and anti-goals below still bind, and the content inventory is still the
> checklist. Do not edit it to match the outcome; edit `system.md`.
>
> **The sectional hypothesis below was built, rendered against real data, and rejected** in
> favour of an instrument-panel direction. The reasoning is recorded in `system.md` so it
> is not re-litigated: a sectional's palette makes hue carry carrier *identity*, which is
> the one thing the map encoding rule forbids.

> Handoff for a **design-focused** Claude session. Companion to
> [`../product/overview.md`](../product/overview.md) (read that first for what the product
> does). Your job here is the *visual identity and the key screens*, not the data
> engineering.
>
> This is a v0 skateboard. The mandate is **restraint**: clean, credible, distinctive —
> not elaborate. A lean data tool earns its personality through precision in type,
> spacing, and one memorable device, not through decoration. Don't go big.

---

## The brief in one paragraph

Upgauge reads US DOT airline filings and tells an aviation nerd whether a route is healthy
and what the airline is about to do to it — which routes are quietly dying, which are being
fed more capacity, which just got downgauged from a mainline jet to a regional. The data is
always a few months old; that lag is a fact we surface proudly, never hide. The product is
half data explorer, half map. It should feel like an instrument a knowledgeable person
trusts, and every screen should be worth screenshotting into a forum.

- **Subject:** commercial airline capacity and route health, from public filings.
- **Audience:** aviation enthusiasts and industry-adjacent people. Numerate. They know what
  a load factor is. Do not dumb it down; do make it legible.
- **The page's one job:** let a curious person *see a trend and trust it* — then share it.

---

## Non-negotiable product constraints (these come from `../product/overview.md`, don't relitigate)

Design freely, but within these. They're truths about the data, not style preferences:

1. **All numerics in a monospaced, tabular-figure face.** Right-aligned, fixed decimals.
   Numbers that don't line up read as amateur. This is the one type rule you can't bend.
2. **`DATA AS OF: YYYY-MM` is a first-class, always-visible element**, in the accent color,
   on every data view. The lag is our credibility. Make a small, confident badge of it —
   not an apology in gray 11px at the bottom.
3. **Density over whitespace.** This is closer to a chart or a terminal than a marketing
   site. Sparklines in table rows are encouraged. Hairline rules over heavy borders.
   No rounded-corner card soup, no big hero whitespace.
4. **Screenshot- and link-shareable.** The growth mechanic is people pasting views into
   Discords and forums. Bias toward a surface that survives a screenshot on a white forum
   background — which nudges lighter/printable over a dark dashboard, though you decide.
5. **Quality floor, unannounced:** responsive to mobile, visible keyboard focus,
   reduced-motion respected.
6. **Honest labeling.** Derived numbers (load factor, ASM, avg gauge) are computed from
   sampled, lagged data. Never let the type treatment imply false precision.

---

## What needs designing (content inventory)

Prioritized. If time is short, nail the first three — they define the system.

1. **The data table.** The workhorse. Sortable, dense, mono numerals, sparkline column,
   quarantine/low-sample flags, a `DATA AS OF` badge. Most of the product is this table in
   different clothes. Get it right and everything else follows.
2. **The time-series chart.** Multi-series (several carriers on a route), a rolling-12
   toggle, seasonality-legible. Dense but readable. This is Observable Plot under the hood.
3. **The route arc / map.** Great-circle arcs over a Natural Earth coastline (no tiled
   basemap). **Load factor should be encoded in the arc's *rendering* — weight, opacity,
   dash — not hue alone**, so it survives grayscale and reads like a real chart. Decide how.
4. **An entity page template** (route / airport / carrier / aircraft share one skeleton):
   header + key stats + chart + table + optional map.
5. **The Explorer** — the pivot builder: dimension/measure/filter controls, results table,
   compare-mode overlay, permalink + export affordances.
6. **The seasonality heatmap** — year × month grid.
7. **The `/watch` leaderboard** — ranked insight rows with editorial framing, each linking
   back into the Explorer.
8. **The methodology / "how to read this" surface** — see the signature idea below.
9. **The social card (OG image).** The stated growth mechanic is people pasting links into
   Discords and forums — and a pasted link unfurls before anyone sees a screenshot.
   Screenshot-friendly and unfurl-friendly are different problems and the brief only solved
   the first. Design a card template that carries the entity name, the headline number, and
   the `DATA AS OF` stamp, generated per entity page. This is cheap and it is the highest-
   leverage surface in the product for reach.
10. **Empty, loading, sparse, and error states.** Not an afterthought here: quarantined rows
    (`../data/invariants.md`), thin routes below the minimum-departures threshold, and a carrier
    that stops filing mid-series are all *normal* in this data. A table that only looks
    right when full is a table that looks broken most of the time. Include the
    "this route has too few departures to score" case explicitly — it's a trust moment, not
    a failure.

---

## A starting hypothesis (pressure-test it, don't just accept it)

One direction has been floated and it's worth exploring **first** — but your job is to
confirm it's right for this brief or beat it, not to rubber-stamp it.

**The VFR sectional chart.** Aviation people revere sectional charts: ink on warm paper,
dense, precise, and they encode meaning through *line weight and dash pattern*, not just
color. The product is half map already. A light, printable, screenshot-friendly surface
also serves the share mechanic. And there's a natural signature device:

> **A "chart legend" panel** — styled like a real sectional's legend — that explains what
> the arc weights and dashes mean. It folds the methodology (constraint #6, and §8.1 of
> `../product/features.md`) *into* the product instead of hiding it behind a footer link. The thing
> people remember.

If you build toward this, spend the boldness on the arcs and the legend and keep
everything else quiet.

**But run the two-pass process properly** (per good design practice): brainstorm a couple
of genuinely different directions, sketch a token system for the front-runner (color as
4–6 named hex values; a display + body + mono type trio; a layout concept; the one
signature element), then critique it against this brief. If the sectional idea turns out to
be the safe/obvious answer rather than the *right* one, say so and show the alternative.

---

## Anti-goals (things that would make this look generic)

- **The dark-dashboard-with-one-neon-accent look.** It's the default every data tool and
  every FlightRadar clone converges on. Zero differentiation for a product whose pitch is
  "we see what others don't." Avoid unless you can strongly justify it for *this* brief.
- The other two current AI-design defaults: warm-cream + high-contrast serif + terracotta
  accent; and the hairline-ruled broadsheet look. All three are defaults, not choices.
- Proportional numerals in data. (Constraint #1. Non-negotiable.)
- A giant hero number with a gradient. Template answer.
- Decorative 01 / 02 / 03 numbering unless something is genuinely a sequence.
- Motion for its own sake — scattered hover effects that read as AI-generated. If motion
  appears, make it one orchestrated moment (e.g., the map year-slider animating a network
  growing), not confetti.

---

## Deliverables from the design session

1. A short **design plan**: the token system (color / type / layout / signature) with a
   one-line justification for each choice tied to *this* brief.
2. **Mocked key screens** — at minimum the data table, the time-series chart, and one
   entity page; ideally the map and the Explorer too.
3. **Component-level styling** for the table, chart, and arc map that the code session can
   implement directly (concrete hex, type scale, spacing).
4. The **signature element** built out enough to see whether it lands.

Keep it lean. Three strong, coherent screens beat ten half-decided ones. The code session
picks this up right after, so hand off specifics (real values), not vibes.
