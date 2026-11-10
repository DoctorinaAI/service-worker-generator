import { defineConfig } from '@playwright/test';

// Chromium by default, to keep local runs fast. Pass SW_E2E_BROWSERS=all (or
// a comma list) for the other engines; CI runs all of them.
const requested = (process.env.SW_E2E_BROWSERS ?? 'chromium')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const all = ['chromium', 'firefox', 'webkit'] as const;
const enabled: readonly (typeof all)[number][] = requested.includes('all')
  ? all
  : all.filter((name) => requested.includes(name));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    // A retried test leaves its trace in the report, so a flaky pass can
    // still be read afterwards rather than only counted.
    trace: 'on-first-retry',
  },
  projects: (enabled.length > 0 ? enabled : (['chromium'] as const)).map((name) => ({
    name,
    use: { browserName: name },
    // WebKit only, and on CI only. On a runner it takes its time activating
    // a worker: two of ten runs of one unchanged tree failed in `settle`
    // waiting for one, on a different spec each time. Retries hide the
    // other kind of failure too — a WebKit worker that never stopped being
    // busy looked exactly like that, and was a bug — so the other engines,
    // which showed no such flakes, get none, and a flaky WebKit pass is
    // still something to read in the report.
    retries: process.env.CI && name === 'webkit' ? 2 : 0,
  })),
  webServer: {
    // Node, not `python3 -m http.server`: that one serves a single request
    // at a time, so three browser projects loading a multi-megabyte build
    // while the worker pre-caches it queue behind each other until the
    // specs' own 30 s budget runs out. It is also absent on Windows.
    command: 'node e2e/support/serve.mjs 8089',
    port: 8089,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
