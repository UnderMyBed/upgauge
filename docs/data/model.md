# Data model

```
fct_segment_month     grain: (year_month, op_airline_id, origin_airport_id,
                              dest_airport_id, aircraft_type)
                      departures_scheduled, departures_performed, seats, passengers,
                      freight, mail, distance, air_time, ramp_to_ramp_time,
                      aircraft_config, service_class,
                      origin_airport_seq_id, dest_airport_seq_id,   -- point-in-time attrs
                      origin_city_market_id, dest_city_market_id,   -- city-market rollup
                      download_date,                                -- amended-filing resolution
                      is_quarantined, quarantine_reason

fct_route_month       grain: (year_month, op_airline_id, origin_airport_id, dest_airport_id)

dim_airport           airport_id, airport_seq_id, code, name, city, state, lat, lon,
                      effective_from, effective_to
                      -- airport_id = identity; airport_seq_id = point-in-time attributes
dim_carrier           airline_id, code, name, is_regional, ownership_type,
                      bts_carrier_group   -- BTS's OWN revenue-based reporting class.
                                          -- NOT our rollup. Preserved under a distinct
                                          -- name so the collision is impossible.
dim_aircraft_type     code, name, manufacturer, family, seats_typical

map_mainline_group    airline_id, parent_airline_id, effective_from, effective_to
                      -- DATE-RANGED. Wholly-owned subsidiaries ONLY.

mart_route_health     one row per (op_airline_id, origin_airport_id, dest_airport_id)
mart_leaderboards     precomputed JSON, built at pipeline time
```

`op_airline_id` is the **operating carrier** throughout — the DOT `AIRLINE_ID`, not the
letter code. See [carrier-model.md](carrier-model.md) and [invariants.md](invariants.md).

---

## Naming: don't reuse `carrier_group`

T-100 already ships `CARRIER_GROUP` and `CARRIER_GROUP_NEW` — BTS's own revenue-based
reporting classification, which drives filing requirements. Confirmed populated in live
data:

```
CARRIER_GROUP      {'3': 26715, '1': 4666, '2': 4555}
CARRIER_GROUP_NEW  {'3': 26715, '2': 4555, '5': 3072, '6': 1070, '4': 267, '1': 247, '9': 10}
```

Nothing to do with mainline rollup. **Ours is `mainline_group`; theirs is preserved as
`bts_carrier_group`** so the collision is impossible.

## No `is_freighter` on `dim_aircraft_type`

Freighter/passenger is a property of *the operation*, not the type — the same airframe flies
both. `AIRCRAFT_CONFIG` on the fact row is the truth.

---

## Measures

**Additive (store these):** departures_scheduled, departures_performed, seats, passengers,
freight, mail, air_time, ramp_to_ramp_time

**Derived (compute at query time):** load_factor, asm, rpm, completion_factor, avg_gauge
(seats/departure), block_hours, avg_stage_length, frequency

> 🔴 **Derived measures are computed from summed numerators and denominators — never
> averaged.**
>
> ```sql
> -- WRONG. Silently produces plausible-looking garbage.
> AVG(load_factor)
> -- RIGHT. Always.
> SUM(passengers)::DOUBLE / NULLIF(SUM(seats), 0)
> ```
>
> Enforce it structurally: **do not store a `load_factor` column on any fact table.** Can't
> average what doesn't exist. This is the #1 bug in every homemade T-100 tool.
