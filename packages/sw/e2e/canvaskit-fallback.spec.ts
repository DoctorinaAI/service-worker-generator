import { expect, test } from '@playwright/test';
import { Host, markerOf } from './support/host';

/**
 * Audit #30, item 4.6: the CanvasKit CDN fallback had no browser coverage.
 *
 * The engine comes from `gstatic.com` when it answers and from the copy the
 * build ships when it does not — a corporate proxy, a country that blocks
 * it, an ad blocker, or a revision the CDN has never heard of.
 *
 * The CDN is told apart from the local copy by *where the request goes*,
 * not by intercepting it: `page.route` does not catch this fetch in every
 * engine — WebKit lets it through, which turns "the fallback works" into
 * "the CDN answered" without failing. A build whose engine revision the
 * CDN does not have fails the probe for real, in every engine. The
 * session flag that spares later loads the probe is unit-tested, where a
 * failure can be arranged exactly.
 */
test.describe('the CanvasKit CDN', () => {
  let host: Host;

  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
  });

  test.afterEach(async () => {
    await host.stop();
  });

  /** Requests the origin saw for the engine it ships itself. */
  const localEngineRequests = (): number =>
    host.requests.filter((request) => request.pathname.startsWith('/canvaskit/'))
      .length;

  test('is used when it answers', async ({ page }) => {
    host.deploy('a');
    const fromCdn: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('gstatic.com/flutter-canvaskit')) {
        fromCdn.push(request.url());
      }
    });

    await page.goto(host.origin);

    // Polled, not asserted once: `__buildMarker` is a top-level statement
    // in `main.dart.js`, so it is set when that script *loads* — before the
    // engine it then asks for has been fetched.
    await expect.poll(() => fromCdn.length, { timeout: 60_000 }).toBeGreaterThan(0);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
  });

  test('falls back to the engine the build ships', async ({ page }) => {
    // An engine revision gstatic.com does not have: the probe really 404s,
    // which is what a blocked or partial CDN looks like from here.
    host.deploy('a', { engine: 'e2e-engine-the-cdn-does-not-have' });

    await page.goto(host.origin);

    // The app still boots, on the engine from the origin. Counted at the
    // origin, not on the page: a request the worker answers is not reported
    // to `page.on('request')` in every engine, while the origin sees it in
    // all of them.
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    await expect.poll(localEngineRequests, { timeout: 60_000 }).toBeGreaterThan(0);
  });
});
