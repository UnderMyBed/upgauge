# Upgauge docs

A structural intelligence layer over US DOT / BTS airline data: *is this route healthy, and
what is the airline about to do to it?*

Start with [product/overview.md](product/overview.md). If you're about to touch the
pipeline, read [data/invariants.md](data/invariants.md) first — it is the part that will
bite you.

## Map

| Doc | What lives there |
|---|---|
| [product/overview.md](product/overview.md) | What this is, the audience, locked decisions, UI constraints |
| [product/features.md](product/features.md) | Explorer, entity pages, maps, `/watch` presets, route-health score |
| [product/scope.md](product/scope.md) | Out of scope for v0, open decisions (D2, D3) |
| [data/sources.md](data/sources.md) | The BTS endpoint, request shape, obfuscation, measured volumes |
| [data/model.md](data/model.md) | Fact/dim/map tables, measures, the derived-measure rule |
| [data/invariants.md](data/invariants.md) | The rules that gate the pipeline, each with its evidence |
| [data/carrier-model.md](data/carrier-model.md) | Operating-carrier grain, the date-ranged mainline map |
| [architecture/hosting.md](architecture/hosting.md) | Deployment shape, cost, the hosting survey, portability test |
| [architecture/pipeline.md](architecture/pipeline.md) | Repo layout, milestones, M1 phase order, **the M2 marts layer and the load-bearing CWD constraint** |
| [design/brief.md](design/brief.md) | Visual identity handoff |

## How these docs work

**Docs are part of every change, not a follow-up.** A change to behavior, a data rule, or a
decision is not done until the relevant file above reflects it — in the same commit.

**Findings go into the topic file they belong to.** Do not add a new markdown file per
investigation. Review notes, spike results, and audit findings get decomposed into the docs
above; the file that owns the subject is the one that gets edited. One-off artifact files
fragment the truth, go stale silently, and end up stating the same rule three different ways.

**Evidence stays attached to the rule it justifies.** Measured counts, distributions, and
prices live inline next to the constraint they support. A rule without its evidence gets
re-litigated, or "simplified" by someone who doesn't know why it exists.
