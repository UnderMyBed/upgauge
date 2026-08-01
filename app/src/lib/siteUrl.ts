/** The scheme+host every fully-qualified URL this app emits is built from -- the four entity
 * pages' `<link rel="canonical">` (M5, Task 2) and, already, `app/sitemap.ts`'s `<loc>`
 * entries and `app/robots.ts`'s `Sitemap:` line (M5, Task 5). CLAUDE.md's portability rule
 * ("Docker + Parquet + env vars only ... No provider-specific runtimes") forbids a hardcoded
 * production hostname: a fork, a staging environment, or a `docker run` against a different
 * domain must all get canonical/sitemap URLs that match where THEY are actually served, not
 * `upgauge.shipman.dev`. `docs/architecture/hosting.md`'s environment-variable table
 * documents `UPGAUGE_BASE_URL`; this is that variable's one definition, so every consumer
 * imports it rather than re-declaring the same default in its own module. */
export const BASE_URL = process.env.UPGAUGE_BASE_URL ?? "http://localhost:3000";
