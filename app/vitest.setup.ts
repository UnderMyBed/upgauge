// Top-level `await` below makes this a module as far as the runtime is concerned; `export
// {}` tells tsc the same thing so it doesn't treat the file as a script (where top-level
// `await` is a type error).
export {};

// Belt-and-braces alongside db.ts's `file_search_path` fix: DuckDB no longer depends on
// process.cwd() to resolve the catalog's relative Parquet paths (see db.ts's header
// comment), but chdir-ing the test process to the repo root is still harmless and keeps any
// other repo-root-relative assumption (present or future) correct under `npm --prefix app
// test`, which starts Node with cwd already inside app/ rather than the repo root.
//
// Safe here specifically because Vitest 4's default pool is "forks" (worker *processes*,
// not worker *threads*) -- process.chdir() throws ERR_WORKER_UNSUPPORTED_OPERATION inside a
// Node `worker_threads` thread, which is exactly why db.ts does not do this chdir itself.
if (process.env.UPGAUGE_ROOT) {
  process.chdir(process.env.UPGAUGE_ROOT);
}

// jest-dom's matchers, and React Testing Library's automatic unmount-between-tests, only
// make sense where there is a DOM to assert against -- component test files opt into the
// jsdom environment individually via a `// @vitest-environment jsdom` docblock (see
// vitest.config.ts), so `document` is only defined there. Node-environment tests (db.test.ts,
// the pivot/urlstate suites) never see this branch.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  // This project does not set `test.globals: true` (deliberately -- `expect`/`it` stay
  // explicit imports throughout the suite), so @testing-library/react's own auto-cleanup
  // never fires: it detects a *global* `afterEach` and there isn't one. Without this, every
  // `render()` in a jsdom test file accumulates in the same `document.body` instead of being
  // unmounted between tests, and `screen.getByText` starts finding stale nodes from earlier
  // tests in the same file.
  const { afterEach } = await import("vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);
}
