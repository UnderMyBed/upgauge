# The carrier model

The single most consequential modeling decision in the product. Getting it wrong produces
numbers that look plausible forever.

---

## Operating carrier is the grain and the truth

**The fact that drives this:** T-100 Segment is filed by the carrier that *operated the
metal*. A Delta-branded regional flight flown by Endeavor files under **9E**, not **DL**.
Mainlines do not file metal they didn't operate. Therefore:

- Summing all carriers on a route **does not double-count**. Each physical flight is
  reported once, by its operator.
- There is **no reliable marketing-carrier field**. You cannot tell, from T-100 alone, that
  a given SkyWest segment was sold as United Express vs. Delta Connection — because SkyWest
  flies for several mainlines simultaneously.

**Decision: operating carrier is the grain and the source of truth. A `mainline_group`
dimension provides an OPTIONAL rollup, but ONLY for wholly-owned subsidiaries**, where
single-parent exclusivity is guaranteed by ownership.

---

## ⚠️ The mapping is DATE-RANGED, not static

An earlier draft assumed ownership held for the entire window, so a flat `carrier → parent`
map would do. **It does not.** Alaska acquired Virgin America in 2016 and Hawaiian in 2024,
both *inside* the window. A static map is wrong before the acquisition; omitting them is
wrong after it.

The map is keyed `(airline_id, effective_from, effective_to) → parent`, and the ingest
joins on it by month.

| Parent | Wholly-owned subsidiary | From | To | Note |
|---|---|---|---|---|
| Delta | Endeavor (9E) | window start | present | Delta-owned since 2013, pre-window |
| American | Envoy (MQ) | window start | present | AAG-owned throughout |
| American | PSA (OH) | window start | present | AAG-owned throughout |
| American | Piedmont (PT) | window start | present | AAG-owned throughout |
| Alaska | Horizon (QX) | window start | present | Air Group-owned throughout |
| **Alaska** | **Virgin America (VX)** | **2016-12** | **2018-04 (exclusive)** | Acquisition closed Dec 2016; SOC Jan 2018; brand retired Apr 2018; last filing under VX is 2018-03 |
| **Alaska** | **Hawaiian (HA)** | **2024-09** | **present** | AAG acquired Hawaiian Holdings Sept 2024; SOC Oct 2025; `HA` flight numbers retire ~Apr 2026 |
| **United** | **— none —** | | | United owns no subsidiary operators; gets no rollup |

**The concept is ownership, not aircraft size.** This is no longer "wholly-owned
*regionals*" — Virgin America and Hawaiian are mainline carriers that became wholly-owned
subsidiaries.

### Rules for the map

- Key on `airline_id` (DOT ID), never the letter code. `VX` and `HA` are exactly the kind of
  codes that get reused — see [invariants.md](invariants.md).
- Boundaries, as the Explorer's pivot actually joins them (`sql/03_queries/
  pivot_mainline_join.sql`): **inclusive at `effective_from`, EXCLUSIVE at
  `effective_to`** — `year_month >= effective_from AND (effective_to IS NULL OR year_month <
  effective_to)`. `effective_from`/`effective_to` are `VARCHAR 'YYYY-MM'`, so the comparison
  is lexical, not a parsed date. A carrier whose `effective_to` is `'2018-04'` has already
  stopped rolling up *by* 2018-04, not after it — read it as "the first month it's back to
  itself," not "the last month it still rolls up." Ownership changes mid-month are
  attributed to the whole month; a stated approximation, not an accident.
  - Both boundaries are tested against the real 2015–2026 warehouse in
    `pipeline/tests/test_pivot_real_data.py`: Virgin America rolls up from 2016-12 (not
    2016-11) and Hawaiian from 2024-09 (not 2024-08) — real traffic straddles both months, so
    those two are observable through the pivot's aggregated output. The upper boundary is
    NOT observable that way for VX: it has zero `fct_segment_month` rows on or after
    2018-04 (its last real filing is 2018-03, consistent with the brand retiring), so a
    query filtered to VX at 2018-04 returns nothing regardless of `<` vs `<=` — there's
    nothing on the left side of the join to begin with. That gap is closed by a second test
    that loads the actual join fragment and probes it against one synthetic row standing in
    for a segment filed in VX's exclusive thru month. Verified by mutation: flipping `>=` to
    `>` breaks both real-traffic boundary tests; flipping `<` to `<=` breaks only the
    synthetic-probe test — proof the naive "real data will catch it" assumption was false for
    this specific boundary.
  - `pipeline/mainline_map.py`'s `MapEntry.covers()` (inclusive at *both* ends) uses
    different edge semantics than this SQL join. It is build-time validation only (checked-in
    CSV → parquet, overlap/totality checks) and never runs at query time, so it cannot
    produce wrong pivot output — but the mismatch means "does this month roll up" reads
    differently in the two layers. Worth reconciling if either layer changes.
- Verify all dates against filings at ingest. **Do not trust the table above as gospel** —
  it is a starting point, and the single most reviewable artifact in the pipeline. Keep it
  as a checked-in declarative file (CSV/YAML), not code, so a reviewer needn't read Python
  to audit it.
- **Assert the map is total:** every `(airline_id, year_month)` maps to exactly one parent
  or to itself. Overlapping ranges are a test failure, not a runtime tiebreak.

---

## Everyone else stays as operating carrier

Two distinct reasons:

- **Shared regionals** (SkyWest OO, Republic YX, Mesa YV, GoJet…) fly for several mainlines
  at once → not attributable at all, at any date.
- **Serially-exclusive contract regionals** (Air Wisconsin ZW, ExpressJet EV…) flew for one
  mainline *at a time* but *changed masters* mid-window. These are now **mechanically
  expressible** — the date-ranged map above is the same shape they need — but they stay out
  of v0 because sourcing the contract dates correctly is the hard part, not the schema.

**The rollup is a grouping layered on the operating-carrier grain, NOT a replacement.**
Aircraft type stays at the grain, so "Delta group downgauged PDX–SLC — mainline 737 seats
down, Endeavor CRJ seats up" is *still fully visible*.

---

## Three honesty caveats — enforce in the UI

1. **A group is not "all branded flying."** `Delta group` = DL + 9E. It does **not** include
   SkyWest/Republic flights also sold as Delta Connection (unattributable). Label precisely:
   *"Delta (mainline + wholly-owned subsidiaries)"* — never imply it's every flight painted
   as Delta. Misattribution-by-omission is still misattribution.
2. **United looks artificially small in group view** because it owns no subsidiary operators
   while the others do. A naive group-vs-group comparison is apples-to-oranges. Annotate it,
   and always keep operating-carrier truth one toggle away.
3. **Group composition changes over time, and a time series must show that.** `Alaska group`
   means AS+QX in 2015, AS+QX+VX in 2017, and AS+QX+HA from late 2024. Group capacity steps
   up at each acquisition, and **that step is an ownership event, not organic growth.**
   Annotate the boundary on any grouped series that crosses it. An unannotated step change
   here is the single most misleading chart this product can draw.

Default view is **operating carrier**; `mainline_group` is an opt-in toggle.

---

## 📌 Backlog (v1+): full mainline attribution

The rollup above covers only wholly-owned metal. To attribute the rest:

1. **Serially-exclusive contract carriers** (Air Wisconsin, ExpressJet, CommutAir…) need a
   date-ranged `(airline_id × period → parent)` mapping. **v0 now ships exactly this
   mechanism**, so this is no longer a schema change — purely a data-sourcing job. Add rows,
   source the contract dates carefully, ship. Meaningfully smaller than originally scoped.
2. **Shared regionals** (SkyWest-type) need an external join — operator + flight number +
   date → marketing carrier, via a schedule feed (OAG/Cirium) or the DOT O&D survey. The
   only honest way to attribute them. Genuine v1+ scope. **No date-ranged map can fix
   these** — they fly for several mainlines on the same day.
