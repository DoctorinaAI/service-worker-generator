import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare global {
  interface Window {
    Bootstrap?: { progress?: unknown };
  }
}

const BASE_URL = 'http://localhost:8089';

/** The directory `playwright.config.ts` serves on BASE_URL. */
const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../example/build/web',
);

test.describe('Bootstrap E2E', () => {
  test('page loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE_URL);
    // Wait for bootstrap.js to start executing
    await page.waitForTimeout(1000);

    // No critical JS errors (filter out Flutter-specific ones)
    const criticalErrors = errors.filter(
      (e) => !e.includes('flutter') && !e.includes('Flutter'),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('bootstrap.js is loaded', async ({ page }) => {
    await page.goto(BASE_URL);

    const bootstrapScript = await page.$('script[data-sw-bootstrap]');
    expect(bootstrapScript).not.toBeNull();

    const src = await bootstrapScript?.getAttribute('src');
    expect(src).toBe('bootstrap.js');
  });

  test('loading widget appears', async ({ page }) => {
    await page.goto(BASE_URL);

    // The loading widget container has id="sw-loading"
    const widget = await page.waitForSelector('#sw-loading', {
      timeout: 5000,
    });
    expect(widget).not.toBeNull();
  });

  test('data-config is parsed correctly', async ({ page }) => {
    await page.goto(BASE_URL);

    const dataConfig = await page.$eval(
      'script[data-sw-bootstrap]',
      (el) => el.getAttribute('data-config'),
    );

    expect(dataConfig).not.toBeNull();
    const config = JSON.parse(dataConfig!);
    expect(config.logo).toBe('icons/Icon-192.png');
    expect(config.title).toBe('Service Worker');
    expect(config.theme).toBe('auto');
    expect(config.color).toBe('#25D366');
  });

  test('console shows version banner', async ({ page }) => {
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      consoleLogs.push(msg.text());
    });

    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    // Bootstrap should log version info to console
    const hasBootstrapLog = consoleLogs.some(
      (log) =>
        log.includes('Bootstrap') ||
        log.includes('SW') ||
        log.includes('Service Worker') ||
        log.includes('engine'),
    );
    expect(hasBootstrapLog).toBe(true);
  });

  test('window.Bootstrap API is exposed', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    const hasBootstrapAPI = await page.evaluate(() => {
      return typeof window.Bootstrap === 'object' && window.Bootstrap !== null;
    });
    expect(hasBootstrapAPI).toBe(true);
  });

  test('window.Bootstrap.progress returns state', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    const progress = await page.evaluate(() => window.Bootstrap?.progress);

    expect(progress).toBeDefined();
    expect(progress).toHaveProperty('phase');
    expect(progress).toHaveProperty('percent');
    expect(progress).toHaveProperty('message');
  });

  test('service worker registers', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3000);

    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registrations =
        await navigator.serviceWorker.getRegistrations();
      return registrations.length > 0;
    });

    expect(swRegistered).toBe(true);
  });
});

test.describe('Bootstrap E2E — wedged service worker job queue', () => {
  // A worker whose install never settles. Its registration job therefore
  // never finishes, and every later job on the same scope — including the
  // bootstrap's own `register()` — stays queued behind it until the browser
  // times the install out minutes later. This is what a precache body that
  // stalls mid-stream does to a real deployment.
  const STALL_SW = `self.addEventListener('install', (event) => {
  event.waitUntil(new Promise(() => {}));
});
`;
  const stallSwPath = path.join(WEB_ROOT, 'stall-sw.js');

  test.beforeAll(() => {
    fs.writeFileSync(stallSwPath, STALL_SW);
  });

  test.afterAll(() => {
    fs.rmSync(stallSwPath, { force: true });
  });

  test('boots the app anyway, without the service worker', async ({ page }) => {
    // The bootstrap waits out its full SW budget before moving on.
    test.setTimeout(90_000);

    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));

    // Claim the job queue before bootstrap.js gets to it.
    await page.addInitScript(() => {
      void navigator.serviceWorker?.register('stall-sw.js').catch(() => {});
    });

    await page.goto(BASE_URL);

    // The app reaches its first frame despite the queue never freeing up.
    await expect(page.locator('flutter-view')).toBeAttached({
      timeout: 60_000,
    });

    expect(logs.some((line) => line.includes('continuing without SW'))).toBe(
      true,
    );
  });
});
