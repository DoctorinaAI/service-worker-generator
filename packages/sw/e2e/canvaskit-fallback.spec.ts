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
    // Polled, not asserted once: `__buildMarker` is a top-level statement
    // in `main.dart.js`, so it is set when that script *loads* — before
    // the engine it then asks for has been fetched.
    await expect.poll(() => fromCdn.length, { timeout: 30_000 }).toBeGreaterThan(0);
  });

  test('falls back to the local engine when it is blocked', async ({ page }) => {
    test.setTimeout(60_000);
    // A proxy that refuses the host outright, probe and all.
    await page.route(CDN, (route) => route.abort());

    await page.goto(host.origin);

    // The app still boots, on the engine the build ships. Counted at the
    // origin, not on the page: a request the worker answers is not
    // reported to `page.on('request')` in every engine (WebKit does not),
    // while the origin sees it in all of them. Polled, because the marker
    // is set when `main.dart.js` loads, which is before the engine is
    // fetched.
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    await expect
      .poll(
        () =>
          host.requests.filter((request) =>
            request.pathname.startsWith('/canvaskit/'),
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
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
    await expect.poll(() => probes, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    const afterFirst = probes;

    await page.reload();
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    // Long enough for a second probe to have been made, had there been one.
    await page.waitForTimeout(2_000);

    // The session flag is what spares the second load the wait: the probe
    // costs up to a 3 s deadline where gstatic.com is blocked.
    expect(probes).toBe(afterFirst);
  });
});
