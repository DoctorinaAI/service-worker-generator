import { expect, test } from '@playwright/test';
import { Host, markerOf } from './support/host';

/**
 * Audit #30, item 4.6: the CanvasKit CDN fallback had no browser coverage.
 *
 * The engine comes from `gstatic.com` when it answers and from the copy the
 * build ships when it does not — a corporate proxy, a country that blocks
 * it, an ad blocker. The probe is a page-side fetch, so `page.route` is
 * where it can be cut off.
 */
const CDN = 'https://www.gstatic.com/flutter-canvaskit/**';

test.describe('the CanvasKit CDN', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
    host.deploy('a');
  });

  test.afterEach(async () => {
    await host.stop();
  });

  test('is used when it answers', async ({ page }) => {
    test.setTimeout(60_000);
    const fromCdn: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('gstatic.com/flutter-canvaskit')) {
        fromCdn.push(request.url());
      }
    });

    await page.goto(host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');

    expect(fromCdn.length).toBeGreaterThan(0);
  });

  test('falls back to the local engine when it is blocked', async ({ page }) => {
    test.setTimeout(60_000);
    // A proxy that refuses the host outright, probe and all.
    await page.route(CDN, (route) => route.abort());

    await page.goto(host.origin);

    // The app still boots, on the engine the build ships. Counted at the
    // origin, not on the page: a request the worker answers is not
    // reported to `page.on('request')` in every engine (WebKit does not),
    // while the origin sees it in all of them.
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    const local = host.requests.filter((request) =>
      request.pathname.startsWith('/canvaskit/'),
    );
    expect(local.length).toBeGreaterThan(0);
  });

  test('is not probed again after it failed once in the session', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    let probes = 0;
    await page.route(CDN, (route) => {
      probes++;
      return route.abort();
    });

    await page.goto(host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    const afterFirst = probes;

    await page.reload();
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');

    // The session flag is what spares the second load the wait: the probe
    // costs up to a 3 s deadline where gstatic.com is blocked.
    expect(probes).toBe(afterFirst);
  });
});
