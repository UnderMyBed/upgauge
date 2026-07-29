# Feature set

## The Explorer — the base layer (build this first)

A pivot surface: pick dimensions, measures, filters, time range → table + chart.

**Dimensions:** month/quarter/year · operating carrier · **carrier grouping (operating vs.
mainline-group toggle)** · origin · dest · route · **city market** · origin/dest state ·
aircraft type · aircraft group · distance group

**Then the things that make it good:**

1. **URL-encoded query state.** Every view is a permalink. The entire growth mechanic for a
   nerd tool — people paste links into forums and Discords. Don't skip it.
2. **CSV / Parquet export of any result.** Nerds want the data, not just the picture.
3. **Compare mode.** Pin 2–5 entities (routes, carriers, airports, *aircraft types*) and
   overlay on one chart. Most-requested feature in every data explorer ever built.
4. **Rolling-12 toggle.** Month / quarter / rolling-12. Rolling-12 kills seasonality and
   makes trends legible. Skipping it gives unreadable sawtooth charts.
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

Per (op_airline_id, route), trailing 12 months vs. prior 12:

| Component | Signal |
|---|---|
| `lf_delta` | Δ load factor |
| `capacity_delta` | Δ total seats |
| `gauge_delta` | Δ mean seats-per-departure (negative = downgauge) |
| `frequency_delta` | Δ departures performed |
| `completion` | departures_performed / departures_scheduled |

Score = weighted z-score composite. Exclude routes with <30 departures in trailing 12mo.

**Show the components in the UI, not just the score.** The components are the insight; the
score is a sort key. Label it plainly as a heuristic. Do not over-engineer this.
