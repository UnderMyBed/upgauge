import { describe, expect, it } from "vitest";
import { collectIds, resolveRows, resolutionKey } from "@/lib/resolve";
import { loadAllowlist } from "@/lib/db";

describe("collectIds", () => {
  // Pure, no connect() -- these defend properties resolveRows's own tests can't: "dedup"
  // asserted only via post-query map.size can't tell "bound once" from "bound N times with
  // the same value" (IN (...) would return one row either way), and "no query issued"
  // asserted the same way can't tell "no query ran" from "a query ran and matched nothing".
  it("deduplicates repeated ids into a single-element set", async () => {
    const allowlist = await loadAllowlist();
    const rows = [{ op_airline_id: 19790 }, { op_airline_id: 19790 }, { op_airline_id: 19790 }];
    const wanted = collectIds(rows, allowlist);
    expect(wanted.get("op_airline_id")?.ids.size).toBe(1);
  });

  it("yields an empty map for a row with no resolvable dimension", async () => {
    const allowlist = await loadAllowlist();
    const wanted = collectIds([{ year_month: "2025-05", seats: 10 }], allowlist);
    expect(wanted.size).toBe(0);
  });
});

describe("resolveRows", () => {
  it("resolves a carrier id to its current code and name", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ op_airline_id: 19790 }], allowlist);
    expect(map.get(resolutionKey("op_airline_id", 19790))).toEqual({
      code: "DL",
      name: "Delta Air Lines Inc.",
    });
  });

  it("resolves an airport id to exactly one row despite multi-seq history", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ origin_airport_id: 14747 }], allowlist);
    expect(map.get(resolutionKey("origin_airport_id", 14747))?.code).toBe("SEA");
  });

  it("resolves an aircraft type code to a name, keeping the key a string", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ aircraft_type: "612" }], allowlist);
    const hit = map.get(resolutionKey("aircraft_type", "612"));
    // '612' is the 737-700, not the A321. The cell shows the SHORT name; the BTS code is
    // never displayed -- rendering '612' is the thing this milestone removes.
    expect(hit?.code).toBe("B737-7");
    expect(hit?.name).toBe("BOEING 737-700/700LR/MAX 7");
  });

  it("gives a city market a name and a null code", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ origin_city_market_id: 30559 }], allowlist);
    const hit = map.get(resolutionKey("origin_city_market_id", 30559));
    expect(hit?.name).toBeTruthy();
    expect(hit?.code).toBeNull();
  });

  it("resolves BOTH route keys through dim_airport", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ route_key_low: 10140, route_key_high: 14747 }], allowlist);
    expect(map.get(resolutionKey("route_key_low", 10140))?.code).toBeTruthy();
    expect(map.get(resolutionKey("route_key_high", 14747))?.code).toBe("SEA");
  });

  it("omits an unresolvable id rather than inventing a value", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ op_airline_id: 999999999 }], allowlist);
    expect(map.has(resolutionKey("op_airline_id", 999999999))).toBe(false);
  });

  it("issues no query for a result with no resolvable dimension", async () => {
    const allowlist = await loadAllowlist();
    const map = await resolveRows([{ year_month: "2025-05", seats: 10 }], allowlist);
    expect(map.size).toBe(0);
  });

  it("deduplicates repeated ids", async () => {
    const allowlist = await loadAllowlist();
    const rows = [{ op_airline_id: 19790 }, { op_airline_id: 19790 }, { op_airline_id: 19790 }];
    const map = await resolveRows(rows, allowlist);
    expect(map.size).toBe(1);
  });
});
