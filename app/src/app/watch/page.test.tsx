// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import WatchIndexPage from "@/app/watch/page";
import { PRESETS, presetBySlug } from "@/lib/watch";

describe("/watch", () => {
  it("shows DATA AS OF", async () => {
    render(await WatchIndexPage());
    expect(screen.getByText(/DATA AS OF/)).toBeDefined();
  });

  it("links to all four presets with their editorial frames", async () => {
    const { container } = render(await WatchIndexPage());
    for (const slug of PRESETS) {
      const preset = presetBySlug(slug)!;
      const link = container.querySelector(`a[href="/watch/${slug}"]`);
      expect(link).not.toBeNull();
      expect(link?.textContent).toContain(preset.title);
      expect(container.textContent).toContain(preset.frame);
    }
  });
});
