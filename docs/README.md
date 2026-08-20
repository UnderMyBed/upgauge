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
| [architecture/deploy.md](architecture/deploy.md) | **The delivery path** — promote and rollback, the operator credential file, bootstrap |
| [architecture/hosting.md](architecture/hosting.md) | Deployment shape, cost, the hosting survey, portability test |
| [architecture/pipeline.md](architecture/pipeline.md) | Repo layout, ingest, **the warehouse catalog and the load-bearing CWD constraint**, the pivot contract, entity resolution, the toolchain |
| [design/system.md](design/system.md) | **The design system: tokens, components, chart and map encodings, states** |
| [design/brief.md](design/brief.md) | The design problem statement — brief, constraints, anti-goals, and the direction that was rejected (answered by `system.md`) |
| [../LICENSE](../LICENSE) | MIT, covering all code in this repository. The upstream BTS data is US federal public domain (17 U.S.C. § 105) and imposes nothing on reuse of our code |
| [../.github/](../.github/) | CI, the warehouse publisher and its drift classifier, CodeQL, Dependabot |

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

**Evidence for a SUPERSEDED state does not.** These are different things, and conflating them is
how a doc ends up narrating the history of its own numbers:

| Keep | Cut |
|---|---|
| the measurement that justifies the current rule | the same measurement taken over an older window, when the current one is in the same paragraph |
| a rejected design plus what killed it | the rejected design's own measurements |
| a limitation that is still true | a plan to fix it, or a claim about its priority (tracker) |
| the trap a past mistake reveals | the fact that a past revision of this file made it |

**Write the rule, not the correction.** "An earlier version said X; it is really Y" costs a
reader two passes and dates instantly — `> ⚠️ **Y, and the direction is easy to invert**` is the
same knowledge as a rule. If a mistake's only lesson is "check this by meaning, not by string",
that lesson is already a rule in `CLAUDE.md` § Workflow; do not re-record it per site.

**No doc here is organised by milestone, and none carries a milestone tag.** These files say
what is TRUE about the system, in the present tense. Which milestone built a thing, which task
number fixed it, and what a page did "through M6" are git's business — `git log -S` finds them
faster than prose can carry them, and prose that carries them goes stale the moment the next
milestone lands. A rule that only makes sense as a story about the past is a rule that has not
been written yet.

This is not licence to strip evidence. **A measurement whose rule is still live stays, in
full** — that is what stops the rule being re-litigated. The 2026-08 pass removed 17 dual
measurements and 17 self-corrections, every one a case where a superseded figure sat beside the
current one, doubling the number of figures that had to stay true (see the tracker's "Stop
measured numbers drifting").
