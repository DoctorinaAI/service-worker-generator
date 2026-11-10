import { expect, test } from '@playwright/test';
import { cachedText, controllerUrl, Host, markerOf } from './support/host';

/**
 * Audit #30, item 4.6: an app deployed under a path was unit-tested only.
 *
 * Every lookup and every guard in the fetch handler is keyed by a path
 * relative to the worker's scope, because that is the space the manifest is
 * keyed in: a build under `<base href="/app/">` still ships
 * `main.dart.js`, not `app/main.dart.js`. Getting that wrong does not
 * merely lose cache hits — it disarms the reserved-prefix guard that keeps
 * the host's own `/__/` namespace away from the app shell.
 */
test.describe('an app deployed under a base path', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
    host.deploy('a', { basePath: 'app' });
  });

  test.afterEach(async () => {
    await host.stop();
  });

  test('boots, and its worker controls the page from that scope', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto(host.appUrl);

    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    await expect
      .poll(() => controllerUrl(page), { timeout: 30_000 })
      .toContain('/app/sw.js');
  });

  test('caches its files under the manifest’s own keys', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(host.appUrl);
    await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toBeNull();

    // `index.html` and `main.dart.js`, not `app/index.html`: the keys the
    // manifest ships and the fetch handler re-bases requests onto.
    await expect
      .poll(() => cachedText(page, 'index.html').catch(() => null), {
        timeout: 30_000,
      })
      .toContain('data-sw-bootstrap');
    await expect
      .poll(() => cachedText(page, 'main.dart.js').catch(() => null), {
        timeout: 30_000,
      })
      .toContain('__buildMarker');
  });

  test('serves a deep route under the base path from the shell', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto(host.appUrl);
    await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toBeNull();

    // The origin 404s it, as a host without an SPA rewrite does, so the
    // pre-cached shell is the only thing that can answer.
    host.fault = ({ pathname }, res) => {
      if (pathname !== '/app/deep/route') return false;
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('nope');
      return true;
    };
    const response = await page.goto(`${host.origin}/app/deep/route`);

    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`${host.origin}/app/deep/route`);
    await expect(page).toHaveTitle('Service Worker');
  });

  test('leaves the host’s own namespace under the base path alone', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto(host.appUrl);
    await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toBeNull();

    // Firebase Auth's handler, under a base href: `app/__/auth/handler`
    // re-bases to `__/auth/handler`, which the reserved-prefix guard
    // matches. Keyed by the absolute pathname it would not, and the app
    // shell would answer a sign-in navigation.
    host.fault = ({ pathname }, res) => {
      if (pathname !== '/app/__/auth/handler') return false;
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<html><head><title>firebase auth</title></head></html>');
      return true;
    };
    await page.goto(`${host.origin}/app/__/auth/handler`);

    await expect(page).toHaveTitle('firebase auth');
  });
});
