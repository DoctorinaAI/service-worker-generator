import { expect, test } from '@playwright/test';
import { cachedText, Host, markerOf, settle, workerVersion } from './support/host';

/**
 * What the worker does when the origin misbehaves, in every engine. Faults
 * are injected at the origin, so they also reach the worker's own fetches.
 */
test.describe('origin faults', () => {
  let host: Host;

  /**
   * In Firefox, with navigation preload enabled, a refused connection fails
   * the navigation even though the worker catches the rejected
   * `preloadResponse` and answers from cache. A minimal worker does the same,
   * and turning preload off fixes it, so the cause is in the engine.
   * `test.fail` makes this test report the day that stops being true.
   */
  function expectFirefoxPreloadFailure(browserName: string): void {
    test.fail(browserName === 'firefox', 'Firefox fails the navigation when preload is refused');
  }

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
    host.deploy('a');
  });

  test.afterEach(async () => {
    await host.stop();
  });

  test('answers a navigation from cache when the origin is down', async ({ page, browserName }) => {
    expectFirefoxPreloadFailure(browserName);
    await settle(page, host.origin);

    await host.down();
    const response = await page.goto(host.origin);

    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(200);
    // bootstrap.js is never cached, so the app does not boot: the shell
    // markup is still the document.
    await expect(page.locator('script[data-sw-bootstrap]')).toHaveCount(1);
  });

  test('answers a deep link from cache when the origin is down', async ({
    page,
    browserName,
  }) => {
    expectFirefoxPreloadFailure(browserName);
    await settle(page, host.origin);

    await host.down();
    const response = await page.goto(`${host.origin}/chat/42`);

    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`${host.origin}/chat/42`);
    await expect(page.locator('script[data-sw-bootstrap]')).toHaveCount(1);
  });

  test('a 500 from the origin does not replace the cached shell', async ({ page }) => {
    await settle(page, host.origin);

    host.fault = ({ pathname }, res) => {
      if (pathname !== '/' && pathname !== '/index.html') return false;
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('broken');
      return true;
    };
    const response = await page.goto(`${host.origin}/index.html`);

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Service Worker');
    expect(await cachedText(page, 'index.html')).toContain('data-sw-bootstrap');
  });

  test('retries a precache request that failed once', async ({ page }) => {
    test.setTimeout(60_000);
    let failed = false;
    host.fault = ({ pathname, url }, res) => {
      // Only the worker's hash-busted fetch: the page's own load is not the
      // subject here.
      if (failed || pathname !== '/main.dart.js' || !url.includes('v=')) return false;
      failed = true;
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('try later');
      return true;
    };

    await settle(page, host.origin);

    expect(failed).toBe(true);
    await expect
      .poll(() => cachedText(page, 'main.dart.js').then((text) => text?.length ?? 0))
      .toBeGreaterThan(0);
  });

  test('a deploy whose core file cannot be fetched leaves the old worker in charge', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await settle(page, host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    const before = await workerVersion(page);
    expect(before).not.toBeNull();

    host.deploy('b', { suffix: '-b' });
    host.fault = ({ pathname }, res) => {
      if (pathname !== '/main.dart.js') return false;
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('broken');
      return true;
    };
    await page.reload();

    // The failed install ends `redundant`, leaving nothing to hand over to.
    await expect
      .poll(
        () =>
          page
            .evaluate(async () => {
              const reg = await navigator.serviceWorker.getRegistration();
              return reg ? !reg.installing && !reg.waiting : false;
            })
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(await workerVersion(page)).toBe(before);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
  });
});
