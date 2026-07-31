# M4a — entity resolution: IDs become codes

**Status:** shipped 2026-07-30. Built across seven tasks plus fix rounds; see
`docs/architecture/pipeline.md`'s M4a section and `CLAUDE.md`'s Status section for what
landed.
**Milestone:** M4a, the first of the decomposed M4.

M4 as originally written — four entity page types, three chart families, three map
variants — is four independent subsystems. It is decomposed here. M4a builds the
resolution layer every one of them depends on, and closes a gap M3b shipped knowingly.

| | Scope |
|---|---|
| **M4a (this spec)** | ID → code/name resolution; `/explore` displays codes |
| M4b | `/route/<pair>`, including the aircraft-type-mix chart |
| M4c+ | `/airport`, `/carrier`, `/aircraft`, the maps |

---

## Why

`app/src/app/explore/page.tsx` renders the raw `AIRLINE_ID` / `AIRPORT_ID` the catalog is
keyed on — `19393`, `14747`. CLAUDE.md's own hard rule says **"Join on IDs, display
`carrier_code`."** M3b documented the violation rather than fixing it, deferring it here on
the grounds that it is query-layer work, not page rendering. That reasoning holds; this is
the query-layer work.

Every M4 entity URL is keyed by code (`/route/PDX-AUS`, `/carrier/DL`). Resolution is
therefore not cosmetic — it is the capability the rest of M4 is built on.

### A third dimension nobody documented

The M3b gap note names only `AIRLINE_ID` and `AIRPORT_ID`. Measured against the built
database, `aircraft_type` is worse: the fact table stores `'612'`, a zero-padded string code
that is meaningless to a reader, and `/explore` renders it verbatim.

**Correction, found during implementation.** Earlier drafts of this spec said `'612'` resolves
to `A321`. It does not — `612` is `BOEING 737-700/700LR/MAX 7`; the A321 is `699`. More
importantly the error exposed a design flaw: `dim_aircraft_type.code` *is* `'612'`, so a rule
of "display the code" would have rendered the exact value this milestone exists to remove.
`aircraft_type` therefore displays **`short_name`** (`B737-7`, `ERJ-175`, `A321/LR`) in the
role `carrier_code` plays for carriers, with the full `name` as the tooltip. Measured:
`short_name` is non-null and non-empty for all 450 rows and all 112 in-window types. The aircraft-type-mix
chart is this product's stated differentiator (CLAUDE.md; `features.md`), and it is
unreadable without this resolution.

---

## What resolves, and to what

Four dimension tables, and they are **not** all the same shape. This is the central fact of
the design; a single generic "join the dim" abstraction does not fit.

| Dimension key | Fact stores | Resolves to | Shape |
|---|---|---|---|
| `op_airline_id` | `19790` | `DL` (+ `Delta Air Lines Inc.`) | id → code + name |
| `origin_airport_id`, `dest_airport_id` | `14747` | `SEA` (+ `Seattle/Tacoma Intl`) | id → code + name |
| `origin_city_market_id`, `dest_city_market_id` | `30559` | `Seattle, WA` | id → **name only** |
| `aircraft_type` | `'612'` | `B737-7` (+ `BOEING 737-700/700LR/MAX 7`) | **code → short name + name** |

`dim_city_market` has columns `city_market_id` and `name` only — there is no code to display,
so the market dimensions render a name and nothing else. `aircraft_type` inverts the usual
direction: the fact already holds the join key, and what is missing is the human-readable
name.

### `route` is a hole in the catalog metadata

`meta_pivot_dimensions` gives `route` a `column_expr` of `route_key_low, route_key_high` —
two airport IDs, e.g. `(10140, 14747)` — but its `join_dim` and `join_key` are `NULL`. The
catalog cannot describe how to resolve the dimension that most visibly needs it: a route
currently renders as two bare numbers.

**Fix the metadata, do not special-case the code.** `route` gains join metadata naming
`dim_airport` for both keys. The resolver reads the catalog; it never branches on a
dimension's name. Anything else reintroduces exactly the hand-maintained parallel list that
the M3b review's Minor 3 was about.

---

## Architecture

```
decode → renderPivot → runPivot            (UNCHANGED — goldens untouched)
                          ↓  rows keyed by ID
                       resolve()            ← new
                          ↓
   sql/03_queries/resolve_{carrier,airport,city_market,aircraft_type}.sql
                          ↓
             rows + code/name columns → DataTable
```

Resolution runs **after** the pivot, against the IDs actually present in the returned page
(at most `n` rows, so at most a few hundred values). It issues one bound query per dimension
**present in the result**, not one per dimension in the catalog.

### Why after, and not inside the pivot templates

Joining inside `pivot_segment.sql` / `pivot_route.sql` — the use `join_dim`/`join_key` were
originally added for — would change what the pivot emits. That reopens the M3a contract:
all 17 goldens regenerate, and `pipeline/pivot.py` and the TypeScript renderer must change in
lockstep or silently drift. Two milestones were spent making that contract verifiable in two
languages. Resolution is a display concern and does not justify reopening it.

So: **resolution is additive and display-only.** The ID column stays on the row. Sorting,
filtering, and the permalink format continue to operate on IDs exactly as today. The codec,
both implementations, and every golden are untouched. Sorting or filtering *by code* is
explicitly not in this milestone.

The cost is one extra round trip per dimension present. Accepted: these are small indexed
lookups against dimension tables of 1,776 / 20,267 / 6,177 / 450 rows, run against an
in-process DuckDB with no network hop.

### Query logic stays in `.sql`

Per CLAUDE.md's hard rule, each resolver is a file. The only TypeScript is the merge —
collect distinct IDs, bind, attach the returned columns to rows.

---

## Correctness

Measured against the built database on 2026-07-30. These numbers belong in
`docs/data/invariants.md` next to the rules they justify.

### The `is_latest` filter is load-bearing

`dim_airport` is keyed on `airport_seq_id`, the point-in-time key. **5,033 `airport_id`s have
more than one `seq_id` row.** A resolver that omits `WHERE is_latest` fans out and silently
*multiplies* result rows — a wrong total rendered under a `DATA AS OF` badge, which this
project treats as worse than an error.

Exactly one `is_latest` row exists per `airport_id`: 0 IDs have none, 0 have more than one.
So the filtered join is 1:1 today, and a test must keep it that way.

**Test:** for each dimension, assert the row count is identical before and after resolution.
A fan-out fails loudly instead of inflating a total.

The other three are naturally 1:1 — `dim_carrier`, `dim_aircraft_type` and `dim_city_market`
each have zero keys with more than one row.

### Unresolvable IDs degrade to the raw ID, never to `—`

Measured orphans across the full 2015–2026 window: **0 carriers, 0 airports, 0 aircraft
types.** The path still has to be defined, because a future BTS refresh can introduce one.

An unresolved ID renders as the ID. It must **not** render as `—`: that reads as "no data"
when we have data and merely lack a name, inverting the rule `app/src/lib/format.ts` opens
with — *"Null is absence, zero is a measurement. Never render one as the other."* Showing the
raw ID is the honest degradation and consistent with surfacing quarantined rows rather than
hiding them.

### Code collisions: an M4b invariant, recorded now

`carrier_code` is reused — **112 codes map to more than one `airline_id`** across the whole of
`dim_carrier`, which is why CLAUDE.md keys everything on IDs. Scoped to the 114 carriers that
actually operated in-window, **0 codes collide.** Airports: 60 colliding codes table-wide, **0
in-window.** Aircraft type codes are unique outright.

**This does not affect M4a.** `19790 → DL` is a function; collisions break only the *reverse*
lookup, which M4b needs for URL resolution. The invariant is asserted and documented now
because M4b will depend on it and because a data refresh could break it silently — but it
guards a future capability, not this milestone's display path. Recording the distinction so
the test is not later mistaken for a guard on rendering.

---

## What visibly changes

`/explore` renders `DL`, `SEA`, `B737-7` in place of `19790`, `14747`, `612`.

### Exactly what a cell contains

Ambiguous on first drafting, so pinned here. **The resolved cell shows the code alone.** The
name is not rendered in the cell — the table is dense by rule (`system.md`: density over
whitespace, hairline rules, no card soup), and a full carrier name per row would dominate a
column sized for a two-letter code.

| Dimension | Cell renders | Name used for |
|---|---|---|
| `op_airline_id` | `DL` | the `abbr title`, same mechanism as the reason-code gutter |
| `origin/dest_airport_id` | `SEA` | as above |
| `origin/dest_city_market_id` | `Seattle, WA` | no code exists — the name **is** the display value |
| `aircraft_type` | `B737-7` | as above |
| `route` | `PDX–SEA` | nothing — `__route` is a synthetic column with no `dimKey`, so no `abbr title` renders for it; `docs/design/system.md` describes this correctly and this row was wrong |

`route` joins its two resolved codes with an en dash, matching `features.md`'s `/route/PDX-AUS`
and the mockups' `PDX–SEA`.

**On putting the name in a `title`.** During design this was raised as an objection —
hover is invisible to keyboard and touch users, and the quality floor requires visible
keyboard focus. It is acceptable *here* and was not acceptable for the point-in-time case,
and the distinction is worth stating: `<abbr title>` is the semantically correct element for
an abbreviation, and screen readers announce the expansion. The code itself is the real
content and is fully visible; the name is a convenience gloss. Nothing is only available on
hover. Had the name been the sole carrier of meaning — as a point-in-time name would have
been — a `title` would have been the wrong home for it.

Where a dimension has no code (`city_market`), the name is rendered directly as the cell
value, not as a `title`, for exactly that reason.

**The ID column is not rendered as a separate column.** The ID remains on the row object —
sorting, filtering and the permalink continue to use it, and it is the fallback when
resolution finds nothing — but it does not get a column of its own. Adding one would widen
every table for a value the reader was never meant to read.

The legend rail — the methodology surface, signature element 3 of 3 — gains one line:

> Codes and names are current identity, not point-in-time filings. A carrier that changed
> code, or an airport that was renamed, shows its present-day form on every row.

This is required, not decorative. `dim_carrier` holds the **current** code (v0 collapses
Carrier Decode to one row per airline), so a 2015 row labelled `DL` is showing today's
identity. CLAUDE.md: *"don't present it as historical fact."* The label is how that rule is
satisfied while keeping display consistent and permalinks stable.

`dim_airport` *does* carry point-in-time history, and this design deliberately does not use
it: an airport renamed mid-window would otherwise appear under two names in one table, and
`/airport/<code>` would resolve to more than one name. Consistency and stable permalinks won.

---

## Testing

Matching the codebase's existing style — the app suite queries the real `upgauge.duckdb`
rather than mocking it (`db.test.ts` has no mocks at all).

| Level | What it pins |
|---|---|
| Resolver unit tests | Each `.sql` returns the expected code/name for known IDs (`19790 → DL`); an unknown ID returns no row rather than erroring |
| Cardinality tests | Row count identical before and after resolution, per dimension — the fan-out guard |
| Degradation test | An ID with no dim row renders as the ID, not as `—` |
| Invariant test | 0 in-window collisions for carrier and airport codes; 1:1 `is_latest` per `airport_id` |
| Catalog test | Every dimension whose `column_expr` names an ID column has non-null `join_dim`/`join_key` — the check that would have caught `route` |
| `make app-smoke` | `/explore` renders a real code and does **not** render the bare ID |

That last one matters disproportionately. Six bugs on M3b had the shape *green tests, broken
production*, and the unit suite caught none of them. Resolution is exactly the kind of change
that can pass every unit test and render nothing in a built app.

---

## Documentation, in the same commit

- **CLAUDE.md** — delete the "Known gap, not yet fixed" paragraph. It is fixed, not amended.
- **`docs/architecture/pipeline.md`** — same deletion where the gap is restated.
- **`docs/data/invariants.md`** — the measured counts above, each next to the rule it
  justifies: 112/0 carrier collisions, 60/0 airport, 5,033 multi-seq airports with 1:1
  `is_latest`, 0 orphans.
- **`docs/design/system.md`** — the legend rail's current-identity line.
- **`docs/product/features.md`** — that `/explore` displays codes.

---

## Out of scope

Deliberately excluded, each with a reason:

| Excluded | Why |
|---|---|
| Any `/route`, `/airport`, `/carrier`, `/aircraft` route | M4b onward. M4a ships no new URL. |
| code → ID reverse lookup | Nothing needs it until a URL does. Built in M4b, where it can be exercised. |
| 404 / canonical-case redirect rules | Same — designing them before a page exercises them is speculative. |
| Sorting or filtering by code | Would reopen the codec and the permalink format. Display-only is the point. |
| Point-in-time airport names | See above: consistency and stable permalinks won. |
| M9, the duplicate `loadAllowlist` per request | The review triaged it "fine to defer". Unrelated perf work would blur what this layer is responsible for. |

## Definition of done

- [x] `resolve_{carrier,airport,city_market,aircraft_type}.sql` exist and are bound-parameter only
- [x] `route` has `join_dim`/`join_key` in `meta_pivot_dimensions`
- [x] `runPivot()` returns code and name alongside every resolvable dimension
- [x] `/explore` shows `DL`, `SEA`, `B737-7` — not `19790`, `14747`, `612`
- [x] Legend rail states codes are current identity
- [x] Every test in the table above passes
- [x] `make check`, `make app-check`, `make app-smoke`, `make verify` all green
- [x] All five docs updated; the known-gap notes deleted
- [x] Goldens byte-identical after `make goldens` — proof the M3a contract never moved
