// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import RoutePage from "@/app/route/[pair]/page";
import { decode } from "@/lib/pivot/urlstate";
import { loadAllowlist } from "@/lib/db";

describe("/route/<pair>", () => {
  it("renders the route title and both airport names", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText(/JFK–LAX/)).toBeDefined();
    expect(screen.getByText(/Kennedy/i)).toBeDefined();
  });

  it("shows DATA AS OF", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("lists the carriers flying the route, by code", async () => {
    const { container } = render(
      await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }),
    );
    const codes = [...container.querySelectorAll("tbody td.id")].map((c) => c.textContent);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((c) => /^[A-Z0-9]{2}$/.test(c ?? ""))).toBe(true);
  });

  it("computes totals from summed parts, not by averaging the carrier rows", async () => {
    // The whole point: Sum(pax)/Sum(seats), never mean(per-carrier lf). Measured for this
    // route and window: seats 3,455,820, pax 2,998,796 -> 86.78%. A mean of the carrier
    // load factors gives a different number, so this assertion distinguishes them.
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText("86.78%")).toBeDefined();
  });

  // Fix round 1 (task-6, pre-implementation falsifiability check): the brief's own version of
  // this test asserted `link.getAttribute("href")).toContain("route%3A12478-12892")` -- i.e.
  // a percent-encoded ':' in the composite filter's key:value separator. Empirically false for
  // ANY href built through this codebase's actual machinery: a plain `<a href>` (verified) and
  // `next/link` (verified) both preserve a literal ':' through JSX -> DOM -> getAttribute, and
  // urlstate.ts's `encode()` never escapes that separator (only the key and values individually
  // go through `quote()` -- the ':' between them is a template-literal character). Forcing it
  // to `%3A` would require hand-encoding, which breaks the *real* link: `parseFilter` in
  // urlstate.ts finds the key:value separator via `raw.indexOf(":")` *before* unquoting, so a
  // pre-encoded `%3A` there makes `decode()` throw "malformed filter" the moment this link is
  // clicked -- exactly the "one click from the raw rows" promise this link exists to keep.
  // Round-tripping the real href through the real `decode()` is strictly more falsifiable than
  // pinning an encoding detail: it fails on a missing/extra filter, the wrong dimension, the
  // wrong measures, or -- the case this route specifically guards, per routePair.ts's own
  // header comment -- the id-order/alphabetical-order mismatch, since a swapped low/high would
  // decode to a *different*, wrong filter value rather than throwing.
  it("offers the same query in the Explorer", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    const link = screen.getByRole("link", { name: /Explorer/i });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("/explore?")).toBe(true);
    const allowlist = await loadAllowlist();
    const query = decode(href.slice("/explore?".length), allowlist);
    expect(query.dimensions).toEqual(["op_airline_id"]);
    expect(query.filters).toEqual([["route", ["12478-12892"]]]);
  });

  it("shows the legend rail", async () => {
    render(await RoutePage({ params: Promise.resolve({ pair: "JFK-LAX" }) }));
    expect(screen.getByText("Chart legend")).toBeDefined();
  });

  it("states the finding for two real airports with no service", async () => {
    // Both codes resolve; nobody flies between them. That is data, not an error.
    render(await RoutePage({ params: Promise.resolve({ pair: "BNH-JFK" }) }));
    expect(screen.getByText(/no scheduled service/i)).toBeDefined();
    expect(screen.getByRole("link", { name: /2015-01/ })).toBeDefined();
  });
});
