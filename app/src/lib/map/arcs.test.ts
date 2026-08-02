import { describe, expect, it } from "vitest";
import { arcOrder, strokeFor, DEPARTURE_FLOOR, LOAD_FACTOR_FLOOR, type ArcDatum } from "./arcs";

function arc(overrides: Partial<ArcDatum> = {}): ArcDatum {
  return {
    code: "SEA",
    lat: 47.45,
    lon: -122.31,
    seats: 100_000,
    departures: 200,
    loadFactor: 0.85,
    ...overrides,
  };
}

describe("arcOrder", () => {
  it("sorts ascending by seats", () => {
    const arcs = [arc({ code: "A", seats: 9000 }), arc({ code: "B", seats: 100 }), arc({ code: "C", seats: 400 })];
    expect(arcOrder(arcs).map((a) => a.code)).toEqual(["B", "C", "A"]);
  });

  it("does not mutate its input", () => {
    const arcs = [arc({ code: "A", seats: 9000 }), arc({ code: "B", seats: 100 })];
    const copy = [...arcs];
    arcOrder(arcs);
    expect(arcs).toEqual(copy);
  });

  it("breaks a seat tie deterministically by code", () => {
    const arcs = [arc({ code: "ZZZ", seats: 500 }), arc({ code: "AAA", seats: 500 })];
    expect(arcOrder(arcs).map((a) => a.code)).toEqual(["AAA", "ZZZ"]);
  });
});

describe("strokeFor", () => {
  it("scales width by seats relative to the max", () => {
    const heavy = strokeFor(arc({ seats: 9000 }), 9000);
    const light = strokeFor(arc({ seats: 100 }), 9000);
    expect(heavy.width).toBeGreaterThan(light.width);
    expect(heavy.stroke).toBe("var(--ink)");
    expect(heavy.dash).toBe("");
    expect(heavy.opacity).toBe(0.62);
  });

  it("dashes an arc below the load-factor floor", () => {
    const s = strokeFor(arc({ departures: 200, loadFactor: 0.62 }), 100_000);
    expect(s.dash).toBe("5 3");
  });

  it("does not dash an arc with an unknown load factor", () => {
    // Catches: treating null as "low". There is no evidence either way for a null
    // load factor, and dashing it would fabricate a claim the same way a bare
    // greatest()/least() would fabricate a NULL-meaningful column (CLAUDE.md).
    const s = strokeFor(arc({ departures: 200, loadFactor: null }), 100_000);
    expect(s.dash).toBe("");
  });

  it("overrides width and dash below the departure floor, ignoring load factor", () => {
    const s = strokeFor(arc({ departures: DEPARTURE_FLOOR - 1, seats: 9000, loadFactor: 0.95 }), 9000);
    expect(s.width).toBe(1);
    expect(s.dash).toBe("1 3");
    expect(s.opacity).toBe(0.75);
    expect(s.stroke).toBe("var(--ink-3)");
  });

  it("treats the load-factor floor as exclusive", () => {
    const atFloor = strokeFor(arc({ departures: 200, loadFactor: LOAD_FACTOR_FLOOR }), 100_000);
    expect(atFloor.dash).toBe("");
  });

  it("never divides by zero when every arc carries zero seats", () => {
    const s = strokeFor(arc({ seats: 0 }), 0);
    expect(Number.isFinite(s.width)).toBe(true);
  });
});
