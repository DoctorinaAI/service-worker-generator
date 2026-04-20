import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    Bootstrap?: { progress?: unknown };
  }
}

const BASE_URL = 'http://localhost:8089';

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
