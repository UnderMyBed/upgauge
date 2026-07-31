import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_VAR = "UPGAUGE_BASE_URL";
const original = process.env[ENV_VAR];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = original;
  vi.resetModules();
});

describe("siteUrl", () => {
  it("defaults to http://localhost:3000 when UPGAUGE_BASE_URL is unset", async () => {
    // Matches app/sitemap.ts's and app/robots.ts's own default exactly -- this module is now
    // the one shared definition every consumer imports, rather than each re-declaring the
    // same literal (fix round 1, Critical 1's "one definition rather than three").
    delete process.env[ENV_VAR];
    vi.resetModules();
    const { BASE_URL } = await import("@/lib/siteUrl");
    expect(BASE_URL).toBe("http://localhost:3000");
  });

  it("reads UPGAUGE_BASE_URL when it is set, never a hardcoded production hostname", async () => {
    // The bug this guards against (fix round 1, Critical 1): a hardcoded
    // `https://upgauge.shipman.dev` would make every fork, staging environment, or
    // differently-hosted `docker run` emit canonical/sitemap URLs pointing at production
    // regardless of where it is actually served.
    process.env[ENV_VAR] = "https://staging.example.com";
    vi.resetModules();
    const { BASE_URL } = await import("@/lib/siteUrl");
    expect(BASE_URL).toBe("https://staging.example.com");
  });
});
