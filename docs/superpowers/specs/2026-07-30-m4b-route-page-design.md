# M4b — `/route/<pair>`: the first entity page

**Status:** design approved 2026-07-30, not yet planned.
**Milestone:** M4b, the second of the decomposed M4. Depends on M4a (shipped).

| | Scope |
|---|---|
| M4a (shipped) | ID → code/name resolution; `/explore` displays codes |
| **M4b (this spec)** | `/route/<pair>` as a working page, and the pivot capability it needs |
| M4c | Observable Plot + the aircraft-type-mix chart |
| M4d+ | `/airport`, `/carrier`, `/aircraft`, the maps |

**Deliberately not in M4b: any chart, and any new dependency.** `features.md` lists the
aircraft-type-mix chart on this page, and CLAUDE.md is emphatic that it comes before the
load-factor chart — but no chart library is installed, and proving Observable Plot renders
server-side under Next 16 and Turbopack is its own risk. Bundling that into the page's first
outing would let it dominate. M4c takes it, once, and every later chart reuses the result.

---

## Why this page needs a pivot change

`/route/JFK-LAX` is a saved pivot query: segment grain, grouped by operating carrier, filtered
to one undirected route. Composing the existing pivot layer is the right shape — one query
path, the derived-measure rule already enforced in the templates, and the Explorer link nearly
free.

**But the pivot cannot express an undirected route.** `renderPivot` throws on any filter over a
multi-column dimension:

> `dimension 'route' spans multiple columns (route_key_low, route_key_high); filter on the
> underlying columns directly, not the composite dimension`

And the workaround that error suggests is **silently wrong**. Measured on JFK–LAX over
2025-05 → 2026-04:

| Filter | Rows | Seats |
|---|---|---|
| `origin IN (JFK,LAX) AND dest IN (JFK,LAX)` | 297 | 3,474,715 |
| The actual undirected route | 264 | **3,455,820** |

The gap is JFK→JFK (2 rows) and LAX→LAX (31 rows). Same-airport filings are not a curiosity:
**12,738 of them exist across 530 airports.** The workaround would inflate this route by 18,895
seats under a `DATA AS OF` badge — the silently-authoritative wrong number this project treats
as worse than an error.

So M4b's first deliverable is the missing capability, not the page.

### Composite-dimension filtering

Replace the "spans multiple columns" error with real support, in `app/src/lib/pivot/render.ts`
and `pipeline/pivot.py` **in lockstep** — a change to one without the other is the drift the
goldens exist to prevent.

**Filter value format: one value encodes one route, as `low-high` in ID order.**

```
f=route:12478-12892                    one route
f=route:12478-12892,10140-14747        either of two routes
```

Multiple values stay OR'd exactly as every other dimension's do. A positional
two-values-make-one-pair convention was rejected: it would make `f=route:a,b,c` meaningless and
break the IN-list semantics every other dimension follows.

**Emitted SQL**, per value, OR-joined:

```sql
(least(route_key_low, route_key_high) = $f0_0a AND greatest(route_key_low, route_key_high) = $f0_0b)
```

`least`/`greatest` rather than trusting stored order, so the filter is correct regardless of how
a fact row was written. Both operands bound, never interpolated.

**The existing 17 goldens must remain byte-identical.** This adds cases; it changes none. A
moved golden means the change was not additive and something reached into the existing contract.

`/airport` will need the sibling capability — one airport as origin *or* destination, equally
inexpressible today. M4b does **not** build it, but the dispatch point it adds is where that
goes.

---

## URL resolution

```
/route/JFK-LAX  →  parse two codes  →  reverse-lookup to ids  →  order by id  →  canonical check
```

### Canonical form is alphabetical by code

Routes are stored undirected by **ID** order (`route_key_low`/`route_key_high`), but a person
writes them alphabetically, and the two disagree for **154 of 22,950 routes (0.7%)** — `HPN-BNH`
is the stored form of what a reader would write `BNH-HPN`.

Alphabetical wins: storage order is an implementation detail that should not leak into a URL,
and it makes the canonical form predictable from the two codes alone, without consulting the
database. `features.md` calls entity pages "canonical hubs, good for SEO", so one URL per route
is the point.

| Request | Response |
|---|---|
| `/route/JFK-LAX` | 200 — canonical (agrees both ways) |
| `/route/LAX-JFK` | **308** → `/route/JFK-LAX` |
| `/route/HPN-BNH` | **308** → `/route/BNH-HPN` (storage order, 154 routes) |

**308, not 301** — Next's `permanentRedirect()` is the documented API for "this IS the
canonical URL," and it issues 308, not 301. 308 preserves the request method (a 301
historically permitted a client to rewrite a POST to GET on redirect); 301 was this spec's
draft-time guess and is not what shipped, so treat 308 as the correct choice, not a deviation
to "fix" back.

The query still uses IDs: codes resolve to IDs, which are then ordered by ID for
`least`/`greatest`. Alphabetical ordering governs the URL only.

### Reverse lookup

The M4a resolver run backwards: code → `airport_id`. This is where M4a's zero-in-window-collision
invariant earns its keep — **0 airport codes collide among in-window airports** (60 collide across
all of `dim_airport`'s history), which is what makes `JFK → 12478` a function.

If a future refresh introduces a collision, the resolver **fails loudly** rather than picking
one. A silently-chosen airport would render a page about the wrong one, under a `DATA AS OF`
badge. `pipeline/tests/test_resolution_invariants.py` already pins the invariant; this is the
consumer that makes breaking it matter.

### Error taxonomy

| Case | Response |
|---|---|
| Path is not exactly two codes (`/route/JFK`) | **404**, naming what was expected |
| A code does not resolve (`/route/ZZZ-LAX`) | **404**, naming the offending code |
| Both codes resolve, no service in window | **200**, empty state |

**"No service" is not an error.** Two real airports with nobody flying between them is a valid
question with a real answer, and the answer is data. It renders a 200 stating the finding in
words with the window used, and offers the widened-to-2015 permalink — the same treatment
`/explore` gives a valid query matching zero rows, where M3b established that a blank panel and
a silent fallback are both unacceptable.

Distinguishing 404 from empty state is also the only signal that separates a typo from a genuine
gap in service, and keeps pages for non-existent codes out of the index.

---

## Page composition

```
UPGAUGE                                    DATA AS OF 2026-04
─────────────────────────────────────────────────────────────
JFK–LAX     John F Kennedy Intl · Los Angeles Intl
            2,475 mi · 4 carriers · 2025-05 → 2026-04

  SEATS      PASSENGERS   LOAD FACTOR   AVG GAUGE   DEPARTURES
  3,455,820  2,998,796    86.78%        170.4       20,283
─────────────────────────────────────────────────────────────
  [ carriers table — DataTable, one row per operating carrier ]
  ⌄ See these rows in the Explorer
─────────────────────────────────────────────────────────────
  [ legend rail ]
```

Reuses `DataTable`, `GaugeRail`, `ReasonCode`, `LegendRail` and M4a's resolution layer unchanged.
Carriers render as `DL`, `B6`, `AA` with full names in the `abbr` expansion.

### The totals are ratios of sums, never averages of rows

`LOAD FACTOR` and `AVG GAUGE` are computed in TypeScript from the summed additive measures the
same query already returns:

```
LF    = Σ passengers / Σ seats
gauge = Σ seats / Σ departures_performed
```

Verified on JFK–LAX: `seats=3,455,820  pax=2,998,796  dep=20,283 → LF=0.8678, gauge=170.4`.

This is CLAUDE.md's rule applied, not bent: the prohibition is on averaging derived values, and
summing numerator and denominator is the sanctioned computation. Averaging the per-carrier load
factors shown in the table would be the classic error, and a test pins that the code does not.

Both carry the stat strip's existing derived marker — computed measures are labelled as computed.

### Truncation must be impossible or disclosed

The totals are only correct if the query returned **every** carrier. Measured: the busiest route
carries **16** distinct operating carriers over the trailing 12 months; the 99th percentile is
**8**. A limit of 50 therefore guarantees a complete set today.

That is a measurement, not a guarantee. The page checks whether the result hit the limit and, if
it ever does, states that the totals cover the listed carriers only. Silently under-reporting a
route's seats is exactly the failure mode this milestone's filter fix exists to prevent.

### The Explorer link

The page's query *is* a `PivotQuery`, so `encode()` yields the permalink directly — satisfying
CLAUDE.md's "every insight row is one click from the raw rows that produced it" at no cost. This
is also the strongest argument for composing the pivot rather than writing bespoke SQL: a page
built on its own queries could not offer this.

---

## Testing

| Level | What it pins |
|---|---|
| Goldens, both languages | The route filter renders identical SQL from `pipeline/pivot.py` and `render.ts`; the existing 17 goldens stay byte-identical |
| Filter correctness | JFK–LAX returns 264 rows / 3,455,820 seats — **not** the 297 / 3,474,715 the naive filter yields. This is the self-route contamination test and it must fail if `least`/`greatest` is replaced by the `IN`-both form |
| Reverse lookup | `JFK → 12478`; an unknown code throws named; a hypothetical collision fails loudly rather than choosing |
| Canonical redirect | `/route/LAX-JFK` → 308 → `/route/JFK-LAX`; `/route/HPN-BNH` → 308 → `/route/BNH-HPN` (308, not 301: `permanentRedirect()` preserves the request method) |
| 404 | Malformed path and unresolvable code, each naming the offence |
| Empty state | Two real airports, no service → 200, states the finding, offers the wider window |
| Totals | Computed from summed parts, and **fails** if changed to average the carrier rows |
| Truncation | The limit check fires when the carrier count reaches the limit |
| `make app-smoke` | A real served `/route/JFK-LAX` renders carrier codes and the totals; `/route/LAX-JFK` really returns 308 with the right `Location`; `/route/ZZZ-LAX` really returns 404 |

The smoke row matters disproportionately. Six bugs in M3b, plus the `make dev` breakage found
after it, all had the shape *green tests, broken production*. **Status codes and redirects are
exactly what unit tests fake** — a test can assert a handler returned a 308 object while the
served app returns 200, and only a curl against a built server tells them apart.

M4a shipped seven assertions that could not fail, every one caught by review rather than by the
test run. Each test above must be checked for falsifiability before it is accepted: name the
change that would make it fail, and confirm it does.

---

## Documentation, in the same commit

- **`docs/architecture/pipeline.md`** — an `## M4b` section: composite-dimension filtering, why
  the naive filter is wrong with the measured 18,895-seat discrepancy, and the URL resolution
  contract.
- **`docs/product/features.md`** — `/route` exists, what it shows, and that the chart is M4c.
- **`docs/design/system.md`** — the entity-page layout: title block, stat strip, table, Explorer
  link, legend rail.
- **`docs/data/invariants.md`** — same-airport filings (12,738 across 530 airports) and the
  0.7% ID-vs-alphabetical ordering disagreement, each next to the rule it justifies.
- **CLAUDE.md** — status, and `/route` in the command/route inventory.

---

## Out of scope

| Excluded | Why |
|---|---|
| The aircraft-type-mix chart, and any chart | M4c. Needs a charting dependency and SSR proof; would dominate this milestone. |
| Any new npm dependency | M4b ships zero. |
| `/airport`, `/carrier`, `/aircraft` | M4d+. |
| Origin-**or**-destination filtering | `/airport` needs it; nothing in M4b does. The dispatch point this adds is where it will go. |
| Zero-dimension (grand total) pivot queries | `renderPivot` requires ≥1 dimension. Not needed: the totals come from summing the carrier rows' additive measures. |
| Directed (one-way) route views | T-100 Segment is directional per filing, but the product's route concept is undirected. A direction toggle is a product decision nobody has asked for. |

## Definition of done

- [ ] `renderPivot` and `pipeline/pivot.py` both support composite-dimension filters, verified identical by new goldens
- [ ] The existing 17 goldens are byte-identical after `make goldens`
- [ ] The JFK–LAX filter returns 264 rows / 3,455,820 seats, and the test fails under the naive `IN`-both filter
- [ ] Code → `airport_id` reverse lookup, failing loudly on an ambiguous code
- [ ] `/route/JFK-LAX` renders the title block, stat strip, carriers table, Explorer link and legend rail
- [ ] `/route/LAX-JFK` and `/route/HPN-BNH` 308 (`permanentRedirect()`, not 301) to their canonical forms
- [ ] `/route/ZZZ-LAX` and `/route/JFK` 404 with named reasons
- [ ] A no-service pair renders the 200 empty state with the widened-window offer
- [ ] Totals are ratios of sums; the test fails if they become averages
- [ ] `make check`, `make app-check`, `make app-smoke`, `make verify` all green
- [ ] All five docs updated in the same commits
