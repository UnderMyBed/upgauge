# Feature set

## The Explorer — the base layer (build this first)

A pivot surface: pick dimensions, measures, filters, time range → table + chart.

**Dimensions:** month/quarter/year · operating carrier · **carrier grouping (operating vs.
mainline-group toggle)** · origin · dest · route · **city market** · origin/dest state ·
aircraft type · aircraft group · distance group

**Then the things that make it good:**

1. **URL-encoded query state.** Every view is a permalink. The entire growth mechanic for a
   nerd tool — people paste links into forums and Discords. Don't skip it.

   **The encoding is a frozen public contract from the first shipped link.** Once permalinks are
   in forum posts, changing the format breaks them, and nobody will report it. So:

   - **Short, stable keys**, frozen from the first shipped link. Not a base64 JSON blob: that
     is opaque in a forum, unreadable at a glance, and impossible to hand-edit — and
     hand-editing a permalink is exactly what this audience does. Reference implementation:
     `pipeline/urlstate.py` (`encode`/`decode`); M3b's TypeScript port must match it exactly.

     | Key | Meaning | Example |
     |---|---|---|
     | `v` | version | `v=1` |
     | `k` | grain | `k=seg` / `k=route` |
     | `d` | dimensions, comma-separated | `d=year_month,op_airline_id` |
     | `m` | measures, comma-separated | `m=seats,load_factor` |
     | `t` | time range | `t=2024-01:2024-12` |
     | `f` | filter, repeatable | `f=origin_airport_id:14771,13487` |
     | `s` | sort, `-` prefix = descending | `s=-seats` |
     | `n` | limit | `n=50` |
     | `g` | grouping | `g=op` / `g=ml` |

   - **Versioned** (`v=1`), so a future incompatible change can migrate rather than silently
     misread an old link.
   - **Decode is total.** An unknown key, or a dimension not on the allowlist, is a rejection
     with a message — never a silent drop to a default. A permalink that quietly renders a
     *different* query than it encodes is worse than one that errors, because the screenshot
     still looks authoritative. Identifier/structural validation (unknown dimension, measure,
     sort key, grain, grouping, empty lists, non-positive limit) is reused as-is from
     `pipeline.pivot.render_pivot` — one allowlist, not two. URL syntax that `render_pivot`
     can't see (`v` itself, unknown query-string keys, the shape of `t` and `f`, `n` as an
     integer) is validated in the codec.
   - Round-trip tested both directions: `state → url → state` and `url → state → url`.
2. **CSV / Parquet export of any result.** Nerds want the data, not just the picture.
3. **Compare mode.** Pin 2–5 entities (routes, carriers, airports, *aircraft types*) and
   overlay on one chart. Most-requested feature in every data explorer ever built.
4. **Rolling-12 toggle.** Month / quarter / rolling-12. Rolling-12 kills seasonality and
   makes trends legible. Skipping it gives unreadable sawtooth charts. **Deferred to M3b**: it
   is a window over the pre-aggregate rather than a plain `GROUP BY`, so it is a different query
   shape, and its only consumer is the time-series chart. Building it before the chart exists
   means guessing what the chart needs.
5. **Seasonality heatmap.** Year × month grid per route. Cheap, satisfying, and the *honest*
   way to present an "empty plane" claim.
6. **Generic Top-N builder.** "Top N `<dimension>` by `<measure>` in `<period>`." The
   `/watch` presets are all saved instances of this. Build the generic thing once.
7. **The omnibox.** One field resolving `PDX` · `Portland` · `Alaska` · `AS` · `A220` ·
   `PDX-AUS`. Sounds trivial. It is the whole UX.
8. **Methodology surface.** The class filter, operating-carrier keying, the lag, the
   quarantine rules. Trust feature; also free SEO content. The design session may fold this
   into the UI rather than a standalone page.

## Entity pages (canonical hubs, good for SEO)

| Route | Contents |
|---|---|
| `/route/PDX-AUS` | LF over time by carrier · seats & departures · **aircraft type mix over time (stacked area)** · competitor list |
| `/airport/PDX` | Route map · top routes by seats · capacity YoY · carrier share · routes added/dropped last 12mo |
| `/carrier/DL` | Network map · fleet mix over time · capacity trend · biggest gainers/losers. Offers the **operating vs. mainline-group toggle**: default shows DL metal; grouped shows DL + Endeavor, labeled *"mainline + wholly-owned subsidiaries."* Note `/carrier/OO` (SkyWest) is operating metal across *all* the mainlines it flies for — label clearly, and it is never rolled into any group. **`/carrier/AS` is the one to get right:** its group composition changes twice in-window (VX from 2016-12, HA from 2024-09), so the grouped series must annotate both boundaries as ownership events. |
| `/aircraft/A220` | **Underserved. Possibly the real differentiator.** Where it flies, who flies it, stage length, is it growing? Pure T-100, nobody does it well. |

> **Build the aircraft-type-mix chart before the load-factor chart.** Everyone does load
> factor. The gauge story is what makes this yours.

## Maps

Tied to entities, never global. A global all-routes map is a hairball.

| Map | Encoding | Why |
|---|---|---|
| **Airport network** `/airport/PDX` | Arcs from one node; weight = seats, style = LF | Add a **year slider** → watch the network grow/contract. The screenshot people post. |
| **Carrier network** `/carrier/OO` | Full network, **filterable by aircraft type** | "Every route SkyWest flies the E175 on" is one filter and a legible map. |
| **Aircraft type** `/aircraft/A220` | All routes flown by a type | Genuinely novel. |
| **Diff map** | new vs. dropped vs. downgauged | Death Watch + Birth Tracker rendered *spatially*. 10× more visceral. |

**Skip:** a map on the route detail page. A single arc is not information.

**Tech:** deck.gl `GreatCircleLayer` over MapLibre.

> 💰 **No tiled basemap.** Mapbox tiles are usage-priced. Render a **Natural Earth
> coastline/state GeoJSON** as a static layer beneath the arcs — zero tile cost. If you later
> want real tiles, use **PMTiles**: one file on object storage, no tile server.

## Insight presets (`/watch`)

Saved Explorer queries with editorial framing. Each row links back into the Explorer with its
filters pre-applied. Ship whichever three are ready first; **lead with Gauge Watch.**

- **Gauge Watch** — biggest upgauges/downgauges, trailing 12mo. *The differentiator.*
- **Empty Planes** — lowest seasonally-adjusted LF (min 30 departures/mo). *The hook.*
- **Route Birth Tracker** — first appearance of a carrier × O&D pair **since 2015**. Label it
  that way. It is *not* "first ever" — the window starts in 2015, so a route flown in 2014 and
  resumed in 2019 looks new. Claiming "first ever" is exactly the false precision the honesty
  rules forbid. *Cheap + fun.*
- **Route Death Watch** — risk score desc. *Follows once the score model's in.*
- **Time-machine diff** — "PDX, Jul 2019 vs Jul 2025." Added/dropped/upgauged side by side,
  table + diff map. *Most shareable artifact in the product.*

---

## Route Health score (v0 — deliberately dumb)

Per (op_airline_id, **undirected** route), trailing 12 months vs. prior 12 — `mart_route_health`,
see [../data/model.md](../data/model.md) for the SQL-level rules:

| Component | Signal | Oriented so higher = healthier |
|---|---|---|
| `lf_delta` | Δ load factor | as-is |
| `capacity_delta` | Δ total seats | as-is |
| `gauge_delta` | Δ mean seats-per-departure | as-is (a **downgauge is the warning sign**) |
| `frequency_delta` | Δ departures performed | as-is |
| `completion_factor` | departures_performed / departures_scheduled (trailing 12mo) | as-is |

`health_score` = **equal 0.20-weighted** z-score composite of the five. Equal weights, not
fitted — this is v0 and deliberately dumb; any other weighting would be an invented number.
Windows are the latest 12 calendar months present (globally, not per-route) vs. the 12 before
that. Excludes routes with **<30 departures *performed*** (not scheduled) in the trailing
12mo.

**A route with no prior-12mo data gets `NULL` deltas and a `NULL` score, never an enormous
"improvement."** It still appears as a row — that row is the Route Birth Tracker's input.
Measured on the real 2015–2017 warehouse: 767 of 7,336 routes are new in exactly this sense
(`p12_months_present = 0`).

**Show the components in the UI, not just the score.** The components are the insight; the
score is a sort key. Label it plainly as a heuristic. Do not over-engineer this.

### `health_score` is `NULL` for three reasons — a route unrankable for lack of a filed schedule must not render as unhealthy

Measured on the real 2015–2017 warehouse, **1,348 of 7,336 routes** have `health_score IS
NULL`, for three distinct reasons (SQL-level accounting and evidence:
[../data/model.md § Window rule, floor, and the NULL-prior-window trap](../data/model.md#window-rule-floor-and-the-null-prior-window-trap)):

1. **767 — no prior window.** A genuinely new route (`p12_months_present = 0`). Correctly
   has no deltas to show.
2. **1 — zero-measure prior window.** The prior window is technically "present" but filed
   zero seats and zero departures, so the ratio is undefined the same way division by zero
   is.
3. **580 — zero scheduled departures, the larger group.** `completion_factor` is undefined
   when `t12_departures_scheduled = 0`, which BTS allows for on-demand/charter-style
   operators that file real performed flights against no filed schedule at all. Unlike the
   other two, this route usually has known `lf_delta`, `gauge_delta`, `capacity_delta`, and
   `frequency_delta` — only `completion_factor` (and therefore the composite score) is
   unknown.

**UI requirement: a `NULL` `health_score` must never render as "unhealthy."** All three
groups are `NULL` for a data-availability reason, not a low-score reason — sorting or
filtering that silently treats `NULL` as the bottom of the range would misrepresent 580
routes (the largest of the three groups) as failing on completion when the real story is
"no schedule was ever filed to complete." Render these rows with an explicit "insufficient
data" state, distinguishable from a genuinely low score, and — for the 580-route group —
still show the four known components even though the composite can't be computed.
