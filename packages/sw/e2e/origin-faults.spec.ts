import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  cachedText,
  controllerUrl,
  expectShellIntact,
  Host,
  markerOf,
  settle,
  workerVersion,
} from './support/host';

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
   *
   * Pins exactly that failure, so these tests report the day it stops being
   * true, and any other failure in Firefox stays a failure. Returns whether
   * the engine has this behaviour, and the test has nothing left to check.
   */
  async function firefoxRefusesNavigation(
    page: Page,
    url: string,
    browserName: string,
  ): Promise<boolean> {
    if (browserName !== 'firefox') return false;
    await expect(page.goto(url)).rejects.toThrow(/NS_ERROR/);
    return true;
  }

  /**
   * Answers a fault is holding back. Cleared after every test, not at the
   * end of its body: a test that fails first would leave them to fire
   * after `host.stop()`, inside the next test or its retry.
   */
  let held: NodeJS.Timeout[] = [];

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
    host.deploy('a');
  });

  test.afterEach(async () => {
    for (const timer of held) clearTimeout(timer);
    held = [];
    await host.stop();
  });

  test('answers a navigation from cache when the origin is down', async ({ page, browserName }) => {
    await settle(page, host.origin);

    await host.down();
    if (await firefoxRefusesNavigation(page, host.origin, browserName)) return;
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
    await settle(page, host.origin);

    await host.down();
    const deepLink = `${host.origin}/chat/42`;
    if (await firefoxRefusesNavigation(page, deepLink, browserName)) return;
    const response = await page.goto(deepLink);

    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`${host.origin}/chat/42`);
    await expect(page.locator('script[data-sw-bootstrap]')).toHaveCount(1);
  });

  test('boots from the cached shell when the origin is merely slow', async ({ page }) => {
    // The deadline the worker gives a navigation has to race the *navigation
    // preload*, which `activate` enables: the browser starts that request
    // before the worker wakes, and awaiting it first made the deadline dead
    // code in every engine that has preload. The origin here accepts the
    // connection and then says nothing for far longer than the deadline —
    // an overloaded backend, a cold serverless function.
    test.setTimeout(60_000);
    await settle(page, host.origin);

    host.fault = ({ pathname }, res) => {
      if (pathname !== '/' && pathname !== '/index.html') return false;
      held.push(
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>late</html>');
        }, 20_000),
      );
      return true;
    };

    const started = Date.now();
    const response = await page.goto(`${host.origin}/index.html`, {
      waitUntil: 'commit',
    });
    const waited = Date.now() - started;

    expect(response?.status()).toBe(200);
    // Comfortably under the origin's 20 s, and not the 3 s deadline on the
    // nose: engines differ in when they start the preload.
    expect(waited).toBeLessThan(12_000);
    await expect(page).toHaveTitle('Service Worker');
  });

  test('a navigation answered from the shell does not hold the next build back', async ({
    context,
  }) => {
    // After the deadline the worker waits, under `waitUntil`, for the
    // origin's late answer to store as the next shell. WebKit never
    // settles `preloadResponse` for a navigation the worker already
    // answered, so that wait never ended: the worker stayed busy, a newer
    // build sat in `waiting` with every tab closed, and Safari eventually
    // failed a navigation with "Service Worker context closed".
    test.setTimeout(150_000);
    const page = await context.newPage();
    await settle(page, host.origin);

    // The real shell, told apart by its title, and read now: by the time
    // the timer fires the test may be over and `host.root` gone.
    const late = fs
      .readFileSync(path.join(host.root, 'index.html'), 'utf8')
      .replace(/<title>[^<]*<\/title>/, '<title>Late shell</title>');
    expect(late).toContain('Late shell');
    const HOLD_MS = 5_000;
    host.fault = ({ pathname }, res) => {
      if (pathname !== '/' && pathname !== '/index.html') return false;
      held.push(
        setTimeout(() => {
          res
            .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
            .end(late);
        }, HOLD_MS),
      );
      return true;
    };
    // From another document: WebKit treats a load of the URL already shown
    // differently, and that one may never reach the worker's deadline.
    await page.goto('about:blank');
    const started = Date.now();
    await page.goto(host.origin, { waitUntil: 'commit' });
    // The deadline fired: the page committed before the origin answered,
    // on the cached shell. Without this the test passed just as well with
    // no deadline at all, and with no late shell to wait for.
    expect(Date.now() - started).toBeLessThan(HOLD_MS);
    await expect(page).toHaveTitle('Service Worker');
    host.fault = undefined;

    host.deploy('b', { suffix: '-b' });
    await page.reload();
    await expect.poll(() => markerOf(page), { timeout: 60_000 }).toBe('b');
    await expect
      .poll(
        () =>
          page
            .evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);

    // Nothing is controlled by the old worker any more. The bound on the
    // late-shell wait is `LATE_SHELL_TIMEOUT_MS` (30 s); the new worker
    // has to be in charge well within the minute after it.
    const next = await context.newPage();
    await page.close();
    const deadline = Date.now() + 90_000;
    let controller: string | null = null;
    while (Date.now() < deadline && !controller?.includes('-b')) {
      await next.goto('about:blank');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await next.goto(host.origin);
      await expect.poll(() => markerOf(next), { timeout: 30_000 }).toBe('b');
      controller = await controllerUrl(next);
    }
    expect(controller).toContain('-b');
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
    await expectShellIntact(page);
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
    host.requests.length = 0;
    host.fault = ({ pathname }, res) => {
      if (pathname !== '/main.dart.js') return false;
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('broken');
      return true;
    };
    await page.reload();

    // Nothing is installing until the browser has seen the new `sw.js`, so
    // first make sure the new worker really met the fault.
    await expect
      .poll(() => host.seen('/main.dart.js').filter((r) => r.url.includes('v=')).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

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
