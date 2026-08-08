# Upgauge — Design Brief

> ✅ **Answered. The design lives in [`system.md`](system.md)**, with working mockups in
> [`mockups/`](mockups/). This file is kept as the *problem statement*: the brief and the
> anti-goals below still bind. Do not edit it to match the outcome — edit `system.md`.

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

**The data table is the product.** It was deliverable #1 of this brief and remains the reason
the visual system had to be decided before the app was built: *most of the product is this table
in different clothes — get it right and everything else follows.* Sortable, dense, mono
numerals, sparkline column, quarantine and low-sample flags, `DATA AS OF` badge.

## Product constraints

They are truths about the data, not style preferences — and **this file is not their home.**
[`../product/overview.md` § UI constraints](../product/overview.md) is the single copy; restating
them here is how three wordings of one rule drift apart. Two bear naming because they constrain
visual work specifically:

1. **All numerics in a monospaced, tabular-figure face**, right-aligned, fixed decimals.
   Numbers that don't line up read as amateur. **This is the one type rule that cannot bend.**
2. **`DATA AS OF: YYYY-MM` is a first-class, always-visible element** in the accent colour, on
   every data view — a small confident badge, not an apology in grey 11px at the bottom. The
   lag is the product's credibility.

## The direction that was tried and rejected

**A VFR sectional chart** — ink on warm paper, dense, meaning carried in line weight and dash
pattern rather than hue. Aviation people revere sectionals, the product is half map already, and
a light printable surface serves the share mechanic. It was built, rendered against real data,
and **rejected:** a sectional's palette makes hue carry carrier *identity*, which is the one
thing the map encoding rule forbids. The answer is the instrument-panel direction in
`system.md`, where the reasoning is recorded so it is not re-litigated.

**One idea survived it** — a legend panel that folds the methodology *into* the product instead
of hiding it behind a footer link. It shipped as the legend rail, one of the three signature
elements (`system.md` § The legend rail).

## Anti-goals — things that would make this look generic

- **The dark-dashboard-with-one-neon-accent look.** It is the default every data tool and every
  FlightRadar clone converges on. Zero differentiation for a product whose pitch is "we see
  what others don't."
- The other two current AI-design defaults: warm-cream + high-contrast serif + terracotta
  accent; and the hairline-ruled broadsheet look. All three are defaults, not choices.
- Proportional numerals in data. Non-negotiable.
- A giant hero number with a gradient. Template answer.
- Decorative 01 / 02 / 03 numbering unless something is genuinely a sequence.
- Motion for its own sake — scattered hover effects that read as AI-generated. If motion
  appears, make it one orchestrated moment (e.g. the map year-slider animating a network
  growing), not confetti.
