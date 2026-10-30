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
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  projects: (enabled.length > 0 ? enabled : (['chromium'] as const)).map((name) => ({
    name,
    use: { browserName: name },
  })),
  webServer: {
    command: 'python3 -m http.server 8089 --directory ../../example/build/web',
    port: 8089,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
