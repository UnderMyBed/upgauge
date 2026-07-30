import type { Allowlist } from "@/lib/pivot/allowlist";

/** The allowlist as M3a's catalog views define it. Task 7 loads the real thing from DuckDB
 * at runtime; this fixture lets the renderer and codec be tested without a database. If it
 * drifts from the catalog, the golden tests fail -- which is the point. */
export const FIXTURE: Allowlist = {
  dims: new Map([
    ["year_month", { key: "year_month", label: "Month", columnExpr: "year_month", grain: "both", joinDim: null, joinKey: null }],
    ["quarter", { key: "quarter", label: "Quarter", columnExpr: "quarter", grain: "both", joinDim: null, joinKey: null }],
    ["year", { key: "year", label: "Year", columnExpr: "year", grain: "both", joinDim: null, joinKey: null }],
    ["op_airline_id", { key: "op_airline_id", label: "Carrier", columnExpr: "op_airline_id", grain: "both", joinDim: "dim_carrier", joinKey: "airline_id" }],
    ["origin_airport_id", { key: "origin_airport_id", label: "Origin", columnExpr: "origin_airport_id", grain: "both", joinDim: "dim_airport", joinKey: "airport_id" }],
    ["dest_airport_id", { key: "dest_airport_id", label: "Destination", columnExpr: "dest_airport_id", grain: "both", joinDim: "dim_airport", joinKey: "airport_id" }],
    ["route", { key: "route", label: "Route", columnExpr: "route_key_low, route_key_high", grain: "both", joinDim: null, joinKey: null }],
    ["origin_city_market_id", { key: "origin_city_market_id", label: "Origin market", columnExpr: "origin_city_market_id", grain: "both", joinDim: "dim_city_market", joinKey: "city_market_id" }],
    ["dest_city_market_id", { key: "dest_city_market_id", label: "Dest market", columnExpr: "dest_city_market_id", grain: "both", joinDim: "dim_city_market", joinKey: "city_market_id" }],
    ["origin_state", { key: "origin_state", label: "Origin state", columnExpr: "origin_state", grain: "segment", joinDim: null, joinKey: null }],
    ["dest_state", { key: "dest_state", label: "Dest state", columnExpr: "dest_state", grain: "segment", joinDim: null, joinKey: null }],
    ["aircraft_type", { key: "aircraft_type", label: "Aircraft type", columnExpr: "aircraft_type", grain: "segment", joinDim: "dim_aircraft_type", joinKey: "code" }],
    ["aircraft_group", { key: "aircraft_group", label: "Aircraft group", columnExpr: "aircraft_group", grain: "segment", joinDim: null, joinKey: null }],
    ["distance_group", { key: "distance_group", label: "Distance group", columnExpr: "distance_group", grain: "segment", joinDim: null, joinKey: null }],
  ]),
  meas: new Map([
    ["departures_scheduled", { key: "departures_scheduled", label: "Dep. scheduled", isAdditive: true, expr: "SUM(departures_scheduled) FILTER (WHERE NOT is_quarantined)" }],
    ["departures_performed", { key: "departures_performed", label: "Dep. performed", isAdditive: true, expr: "SUM(departures_performed) FILTER (WHERE NOT is_quarantined)" }],
    ["seats", { key: "seats", label: "Seats", isAdditive: true, expr: "SUM(seats) FILTER (WHERE NOT is_quarantined)" }],
    ["passengers", { key: "passengers", label: "Passengers", isAdditive: true, expr: "SUM(passengers) FILTER (WHERE NOT is_quarantined)" }],
    ["freight", { key: "freight", label: "Freight", isAdditive: true, expr: "SUM(freight) FILTER (WHERE NOT is_quarantined)" }],
    ["mail", { key: "mail", label: "Mail", isAdditive: true, expr: "SUM(mail) FILTER (WHERE NOT is_quarantined)" }],
    ["air_time", { key: "air_time", label: "Air time", isAdditive: true, expr: "SUM(air_time) FILTER (WHERE NOT is_quarantined)" }],
    ["load_factor", { key: "load_factor", label: "Load factor", isAdditive: false, expr: "SUM(passengers) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(seats) FILTER (WHERE NOT is_quarantined), 0)" }],
    ["avg_gauge", { key: "avg_gauge", label: "Avg gauge", isAdditive: false, expr: "SUM(seats) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(departures_performed) FILTER (WHERE NOT is_quarantined), 0)" }],
    ["completion_factor", { key: "completion_factor", label: "Completion", isAdditive: false, expr: "SUM(departures_performed) FILTER (WHERE NOT is_quarantined)::DOUBLE / NULLIF(SUM(departures_scheduled) FILTER (WHERE NOT is_quarantined), 0)" }],
    ["asm", { key: "asm", label: "ASM", isAdditive: false, expr: "SUM(seats * distance) FILTER (WHERE NOT is_quarantined)" }],
    ["rpm", { key: "rpm", label: "RPM", isAdditive: false, expr: "SUM(passengers * distance) FILTER (WHERE NOT is_quarantined)" }],
  ]),
};
