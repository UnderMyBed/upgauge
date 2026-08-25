import { describe, expect, it } from "vitest";
import { greatCircle, MAX_STEPS, MIN_STEPS, stepsFor } from "./greatCircle";

describe("greatCircle", () => {
  it("returns steps + 1 points", () => {
    expect(
      greatCircle({ lat: 47.45, lon: -122.31 }, { lat: 40.64, lon: -73.78 }, 12),
    ).toHaveLength(13);
  });

  it("starts at a and ends at b", () => {
    const path = greatCircle({ lat: 47.45, lon: -122.31 }, { lat: 40.64, lon: -73.78 }, 8);
    expect(path[0].lat).toBeCloseTo(47.45, 4);
    expect(path[8].lat).toBeCloseTo(40.64, 4);
  });

  it("bows away from the straight line between the endpoints", () => {
    // Catches: returning a linear interpolation. A great circle between two points
    // at equal latitude passes POLEWARD of them; a straight line does not. Asserting
    // only the endpoints passes under a linear implementation.
    const path = greatCircle({ lat: 45, lon: -120 }, { lat: 45, lon: -75 }, 16);
    expect(path[8].lat).toBeGreaterThan(45.5);
  });

  it("handles coincident endpoints without dividing by zero", () => {
    // Catches: NaN from sin(0) in the interpolation. Same-airport rows are excluded
    // upstream (Task 6), but 359 of 1,047 airports have them, so this must be safe.
    const path = greatCircle({ lat: 47.45, lon: -122.31 }, { lat: 47.45, lon: -122.31 }, 8);
    expect(path.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))).toBe(true);
  });
});

describe("stepsFor", () => {
  it("gives more points to a long arc than a short one", () => {
    // Catches: reverting to a fixed step count, which is worse in both directions -- it
    // over-samples the many short arcs and under-samples the few long ones. `greatCircle.ts`'s
    // `stepsFor` header carries the measured byte counts, and is the one place they are stated.
    expect(stepsFor(900)).toBeGreaterThan(stepsFor(40));
  });

  it("never drops below 4 steps or exceeds 48", () => {
    expect(stepsFor(0)).toBe(4);
    expect(stepsFor(1)).toBe(4);
    expect(stepsFor(100_000)).toBe(48);
    expect(MIN_STEPS).toBe(4);
    expect(MAX_STEPS).toBe(48);
  });
});
