import { defineConfig } from '@playwright/test';

// Opt into Firefox/WebKit by passing SW_E2E_BROWSERS=all (or a comma list)
// at invocation time. In CI we run only Chromium by default to keep the
// job fast; the full matrix still runs on demand and before releases.
const requested = (process.env.SW_E2E_BROWSERS ?? 'chromium')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const all = ['chromium', 'firefox', 'webkit'] as const;
const enabled = requested.includes('all')
  ? all
  : all.filter((name) => requested.includes(name));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  projects: (enabled.length > 0 ? enabled : ['chromium']).map((name) => ({
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
