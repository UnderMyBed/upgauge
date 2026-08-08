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
| [product/scope.md](product/scope.md) | Out of scope for v0; the D1–D4 decision record, all four resolved |
| [data/sources.md](data/sources.md) | The BTS endpoint, request shape, obfuscation, measured volumes |
| [data/model.md](data/model.md) | Fact/dim/map tables, measures, the derived-measure rule |
| [data/invariants.md](data/invariants.md) | The rules that gate the pipeline, each with its evidence |
| [data/carrier-model.md](data/carrier-model.md) | Operating-carrier grain, the date-ranged mainline map |
| [architecture/hosting.md](architecture/hosting.md) | Deployment shape, cost, the hosting survey, portability test |
| [architecture/pipeline.md](architecture/pipeline.md) | Repo layout, the milestone record, M1 phase order, the ingest/query layer, **the M2 marts layer and the load-bearing CWD constraint** |
| [design/system.md](design/system.md) | **The design system: tokens, components, chart and map encodings, states** |
| [design/brief.md](design/brief.md) | The design problem statement — constraints, anti-goals, content inventory (answered) |

## Where the work lives

**Outstanding work is tracked in [GitHub Issues](https://github.com/UnderMyBed/upguage/issues),
not in these docs.** 12 epics across four milestones — `M8 — Public launch`,
`M9 — Post-launch surfaces`, `Engineering health`, `v1+`.

**These docs describe what is TRUE about the system. The tracker describes what is PLANNED.**
That split is not tidiness: the same backlog item used to be stated three ways in three files
and drift independently. The either-endpoint filter was described as missing in four places for
a full milestone after it shipped — two of them on served pages a visitor could read.

Some passages here still explain *why* an unbuilt thing is worth building (the Maps table in
[product/features.md](product/features.md) is the clearest case). That is design rationale and
it belongs here. Only status and scheduling belong in the tracker.

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
