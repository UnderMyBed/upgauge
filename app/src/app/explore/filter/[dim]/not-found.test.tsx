// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NotFoundView } from "@/app/explore/filter/[dim]/not-found";
import { FilterListView } from "@/app/explore/filter/[dim]/page";

const SEGMENT = "v=1&k=seg&d=op_airline_id&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op";
const ROUTE = "v=1&k=route&d=route&m=seats&t=2025-05:2026-04&s=-seats&n=25&g=op";

async function render404(pathname: string, rawQuery = SEGMENT) {
  return render(await NotFoundView({ pathname, rawQuery }));
}

describe("/explore/filter/[dim] not-found", () => {
  // TWO FINDINGS, WORDED APART. These two cases are the reason this file exists: an unknown slug
  // and a real dimension this grain does not carry are different facts about the request, and
  // collapsing them is the silent-pick failure `/carrier/PA`'s split refuses.
  it("names an unknown slug as not a dimension, and lists what is", async () => {
    const { container } = await render404("/explore/filter/not_a_dimension");
    expect(container.querySelector("h1")!.textContent).toBe("No such dimension");
    expect(container.querySelector("[role=alert]")!.textContent).toContain("not_a_dimension");
    const candidates = [...container.querySelectorAll("li a")].map((a) => a.textContent!);
    expect(candidates.length).toBe(15);
    expect(candidates.some((c) => c.includes("aircraft_type"))).toBe(true);
  });

  it("names a wrong-grain dimension as filed elsewhere, and links the repaired query", async () => {
    const { container } = await render404("/explore/filter/aircraft_type", ROUTE);
    expect(container.querySelector("h1")!.textContent).toBe("Not filed at this grain");
    const alert = container.querySelector("[role=alert]")!.textContent!;
    expect(alert).toContain("Aircraft type");
    expect(alert).toContain("segment");
    expect(alert).toContain("route");
    // NOT the unknown-dimension sentence, and no candidate list: this slug is a real dimension.
    expect(alert).not.toContain("not a dimension");
    expect(container.querySelectorAll("li a").length).toBe(0);
  });

  // THE CLAIM IS "RECOVERS", SO THE TEST RECOVERS. A link that merely LOOKS repaired -- same
  // grain, same everything -- lands on this same 404 again, and an assertion over the href's
  // bytes cannot tell the two apart. So the emitted href is fed back through the real page.
  it("the repaired link renders the list rather than 404ing again", async () => {
    const { container } = await render404("/explore/filter/aircraft_type", ROUTE);
    const target = container
      .querySelector("a[href^='/explore/filter/aircraft_type']")!
      .getAttribute("href")!;
    const [path, rawQuery] = target.split("?");
    expect(path).toBe("/explore/filter/aircraft_type");
    expect(rawQuery).toContain("k=seg");
    const recovered = render(await FilterListView({ rawQuery, dim: "aircraft_type" }));
    expect(recovered.container.querySelectorAll(".mp-list li").length).toBeGreaterThan(0);
  });

  it("still names the slug when the permalink itself is unreadable", async () => {
    const { container } = await render404(
      "/explore/filter/not_a_dimension",
      "v=1&k=seg&d=junk&m=seats&t=2025-05:2026-04&n=5&g=op",
    );
    expect(container.querySelector("[role=alert]")!.textContent).toContain("not_a_dimension");
    // No grain, so no candidate links -- a list of hrefs built from a query that does not parse
    // would be a list of dead links.
    expect(container.querySelectorAll("li a").length).toBe(0);
  });

  it("shows DATA AS OF, the same as every other view", async () => {
    const { container } = await render404("/explore/filter/not_a_dimension");
    expect(container.textContent).toContain("DATA AS OF");
  });
});
