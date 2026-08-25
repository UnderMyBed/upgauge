// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MapPicker } from "@/components/MapPicker";
import type { PickerOption } from "@/lib/map/picker";

const OPTS: PickerOption[] = [
  { value: "673", label: "CRJ-700", title: "CANADAIR RJ-700", seats: 90_000, href: "/carrier/OO?type=673", selected: false },
  { value: "629", label: "EMB-120", title: "EMBRAER-120 BRASILIA", seats: 50_000, href: "/carrier/OO?type=629", selected: true },
];

function pick(over: Partial<Parameters<typeof MapPicker>[0]> = {}) {
  return render(
    <MapPicker
      options={OPTS}
      filter={{ kind: "ok", code: "EMB-120", id: "629" }}
      legend="Aircraft type"
      truncated={false}
      {...over}
    />,
  ).container;
}

describe("MapPicker", () => {
  it("renders real anchors, so the picker works with JS off", () => {
    // The JS-off property, and nothing else in this suite asserts it. A <button> + handler
    // renders identically to a reader and is inert in the served HTML this project ships.
    const hrefs = [...pick({ filter: { kind: "none" } }).querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/carrier/OO?type=673", "/carrier/OO?type=629"]);
  });

  it("marks the showing view with aria-current, and only it", () => {
    const current = [...pick().querySelectorAll("[aria-current]")].map((el) => el.textContent);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain("EMB-120");
  });

  it("claims no current view when the filter did not resolve", () => {
    // `aria-current="page"` asserts "this IS the view you are looking at". On a refusal no view
    // resolved, so marking one is a false claim -- and the option carrying `selected: true` is
    // still in the list, so only the component's own guard can prevent it.
    const container = pick({
      filter: { kind: "ambiguous", raw: "PA", holders: ["Pan American World Airways", "Florida Coastal Airlines"] },
      legend: "Carrier",
    });
    expect(container.querySelectorAll("[aria-current]")).toHaveLength(0);
  });

  it("names every holder when the value is ambiguous, and picks none of them", () => {
    // `/carrier/PA` is the case this refusal exists for: PA holds three airline_ids, two Pan Am
    // eras plus an unrelated Florida Coastal. Naming only the plausible one IS the silent pick.
    const container = pick({
      filter: {
        kind: "ambiguous",
        raw: "PA",
        holders: ["Pan American World Airways", "Pan American World Airways", "Florida Coastal Airlines"],
      },
      legend: "Carrier",
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Florida Coastal Airlines");
    expect(text).toContain("Pan American World Airways");
    expect(container.querySelectorAll('[data-testid="mp-holder"]')).toHaveLength(3);
    expect(text).toContain("more than one");
  });

  it("says an unknown value is unknown, distinctly from an ambiguous one", () => {
    // Two different findings: a value that names NOTHING and a value that names SEVERAL. A 404
    // names which way it failed (CLAUDE.md), and so does a refused map filter.
    const container = pick({
      filter: { kind: "unknown", raw: "ZZZ", reason: "'ZZZ' is not a carrier code in this dataset" },
      legend: "Carrier",
    });
    const text = container.textContent ?? "";
    expect(text).toContain("ZZZ");
    expect(text).not.toContain("more than one");
  });

  it("wires the resolver's own reason through to the reader", () => {
    // The curated message must actually reach the user rather than being swallowed for a
    // generic one -- the reason is why THIS value failed, and mapFilter.ts words three of them.
    const container = pick({
      filter: { kind: "unknown", raw: "B999", reason: "'B999' is not the canonical spelling of an aircraft type ('B737-9' is)" },
    });
    expect(container.textContent).toContain("is not the canonical spelling of an aircraft type");
  });

  it("discloses a partial list when the page's own pivot was truncated", () => {
    expect(pick({ truncated: true }).textContent).toContain("not every");
  });

  it("makes no truncation claim when the list is complete", () => {
    // A disclosure that always renders is a disclosure that means nothing.
    expect(pick({ truncated: false }).textContent).not.toContain("not every");
  });

  it("hangs the full designation off the label, as every other resolved id in this app does", () => {
    const abbr = pick().querySelector("abbr");
    expect(abbr?.getAttribute("title")).toBe("CANADAIR RJ-700");
  });

  it("says so plainly when there is nothing to pick", () => {
    const container = pick({ options: [], filter: { kind: "none" } });
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toContain("Nothing to map");
  });
});
