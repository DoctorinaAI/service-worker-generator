import { expect, test } from '@playwright/test';
import { cachedText, controllerUrl, Host, markerOf } from './support/host';

/**
 * Audit #30, item 2.1: what a deploy costs the people who already have the
 * app.
 *
 * A content cache is named after its version, so every deploy used to start
 * from an empty one and download every Core and Required file again. The
 * install of a new version now copies the files whose hash this build did
 * not change out of the previous version's cache.
 *
 * The origin is where this is visible: the worker's own fetches never reach
 * `page.route()`, and precache asks for `?v={hash}` — a query the page
 * itself never sends, so the two are easy to tell apart.
 */
test.describe('a deploy that changed nothing but its version', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
  });

  test.afterEach(async () => {
    await host.stop();
  });

  /** Requests the worker made for [pathname] by hash. */
  const precacheRequests = (pathname: string): number =>
    host.seen(pathname).filter((request) => request.url.includes('v=')).length;

  test('does not download the code again', async ({ page }) => {
    test.setTimeout(90_000);
    host.deploy('a');
    await page.goto(host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toBeNull();
    await expect
      .poll(() => cachedText(page, 'main.dart.js').catch(() => null), { timeout: 30_000 })
      .toContain('__buildMarker');

    // The same build under a new version: an assets-only deploy, or a
    // release whose Dart code happens not to have changed.
    host.deploy('a', { suffix: '-b' });
    host.requests.length = 0;
    await page.reload();

    // The new worker installs during this load. Wait for it to get far
    // enough to have fetched anything it was going to fetch: its manifest
    // entries other than the code are small, and `index.html` is one of
    // them.
    await expect
      .poll(() => host.seen('/sw.js').length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          page
            .evaluate(async () => {
              const registration = await navigator.serviceWorker.getRegistration();
              return !!registration?.waiting;
            })
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);

    // The install is done and it never asked the origin for the code.
    expect(precacheRequests('/main.dart.js')).toBe(0);

    // And the new worker serves it: the app runs on the next load, where
    // that worker is in control.
    await page.reload();
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    await expect
      .poll(() => cachedText(page, 'main.dart.js').catch(() => null), { timeout: 30_000 })
      .toContain('__buildMarker');
  });

  test('downloads the code when it did change', async ({ page }) => {
    // The control: without it, "nothing was fetched" could mean the install
    // never ran.
    test.setTimeout(90_000);
    host.deploy('a');
    await page.goto(host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toBeNull();

    host.deploy('b', { suffix: '-b' });
    host.requests.length = 0;
    await page.reload();

    await expect
      .poll(() => precacheRequests('/main.dart.js'), { timeout: 60_000 })
      .toBeGreaterThan(0);
  });
});
