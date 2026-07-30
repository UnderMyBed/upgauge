import { describe, expect, it } from "vitest";
import { formatSeats, formatLoadFactor, formatGauge, formatCount } from "@/lib/format";

describe("formatters hold the fixed-decimal rule", () => {
  it("formats seats with thousands separators and no decimals", () => {
    expect(formatSeats(706767)).toBe("706,767");
    expect(formatSeats(0)).toBe("0");
  });

  it("formats load factor to exactly 2dp with a percent sign", () => {
    expect(formatLoadFactor(0.8998)).toBe("89.98%");
    expect(formatLoadFactor(0)).toBe("0.00%"); // flew, carried nobody -- a fact
    expect(formatLoadFactor(1)).toBe("100.00%");
  });

  it("formats gauge to exactly 1dp", () => {
    expect(formatGauge(73.58)).toBe("73.6");
    expect(formatGauge(190)).toBe("190.0");
  });

  it("renders null as an em dash, never as zero", () => {
    expect(formatLoadFactor(null)).toBe("—");
    expect(formatGauge(null)).toBe("—");
    expect(formatCount(null)).toBe("—");
  });
});
