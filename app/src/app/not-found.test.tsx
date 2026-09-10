// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RootNotFoundView } from "./not-found";

// Headings copied verbatim from each segment view's own <h1> (read, not guessed):
// route/[pair]/not-found.tsx:64, airport/[code]/not-found.tsx:144,
// carrier/[code]/not-found.tsx:224, aircraft/[name]/not-found.tsx:387-389 (interpolated on
// outcome.kind), watch/[preset]/not-found.tsx:473. All six are distinct -- ambiguous aircraft
// ("More than one aircraft type") and not-found aircraft ("Aircraft type not found") differ
// from each other and from every other family's heading.
describe("RootNotFoundView", () => {
  it.each([
    ["/carrier/ZZZ", "Carrier not found"],
    ["/route/ZZZZ-LAX", "Route not found"],
    ["/airport/ZZZZ", "Airport not found"],
    ["/aircraft/NOPE-1", "Aircraft type not found"],
    ["/watch/nope", "Preset not found"],
    ["/explore/filter/nope", "No such dimension"],
  ])("dispatches %s to its own view", async (pathname, heading) => {
    render(await RootNotFoundView({ pathname, rawQuery: "" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
  });

  // THE BUG THIS EXISTS TO CATCH: a dispatcher that falls through to the generic view for a
  // family it does not recognise would erase the whole point of the split -- CLAUDE.md's "a 404
  // names which way it failed, and names every holder". Asserting only that SOME h1 rendered
  // would pass under that bug, so each case asserts ITS OWN heading.
  it("renders the generic view, and reads no database, when the path header is absent", async () => {
    const db = await import("@/lib/db");
    const spy = vi.spyOn(db, "dataAsOf");
    render(await RootNotFoundView({ pathname: null, rawQuery: "" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
    expect(spy).not.toHaveBeenCalled();
  });
});
