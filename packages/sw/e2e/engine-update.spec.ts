import { expect, test, type Page } from '@playwright/test';
import { controllerUrl, Host, markerOf } from './support/host';

/**
 * The first load after a deploy, while the previous build's worker still
 * controls the page.
 *
 * `index.html` and `bootstrap.js` come from the new build, and the
 * bootstrap loads the engine for the new build's revision, while the
 * worker in control still has the previous build's files in its cache —
 * which it stops serving while a newer worker is pending. Both "deploys"
 * here are the example
 * build with a marker appended to `main.dart.js`, so the test can see which
 * build's Dart code actually ran, and the second one with a new version and,
 * where the test says so, a different engine revision.
 */

test.describe('first load after a deploy', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
  });

  test.afterEach(async () => {
    await host.stop();
  });

  /** Load build A and wait until its worker controls the page. */
  async function settleOnBuildA(page: Page): Promise<void> {
    host.deploy('a');
    await page.goto(host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    // A first visit boots before the worker activates; it claims the page
    // once its install is done.
    await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toBeNull();
  }

  test('runs the new build when the engine changed', async ({ page }) => {
    test.setTimeout(90_000);
    await settleOnBuildA(page);

    host.deploy('b', { suffix: '-b', engine: 'e2e-engine-b' });
    await page.reload();

    // Without the switch, the old worker serves build A's Dart code to
    // build B's engine.
    await expect.poll(() => markerOf(page), { timeout: 60_000 }).toBe('b');
    // The page can run its code a moment before `controller` reflects the
    // worker that served it.
    await expect.poll(() => controllerUrl(page), { timeout: 10_000 }).toContain('-b');
  });

  test('runs the new build on the same engine without waiting for its worker', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await settleOnBuildA(page);

    host.deploy('b', { suffix: '-b' });
    await page.reload();

    // Issue #40: build B's `index.html` and `bootstrap.js` with build A's
    // Dart code, because the worker in control answered `main.dart.js`
    // from its own cache. It now goes to the network for as long as a
    // newer worker is installing or waiting beside it.
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('b');
    // Without waiting for the handover: this load still ran on the worker
    // it started with, which is why it booted as fast as any other.
    expect(await controllerUrl(page)).not.toContain('-b');

    // The handover on a later load can lose its race with a request the
    // page makes, which leaves it for the load after; a few loads settle it.
    let controller: string | null = null;
    for (let load = 0; load < 3 && !controller?.includes('-b'); load++) {
      await page.reload();
      await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('b');
      controller = await controllerUrl(page);
    }
    expect(controller).toContain('-b');
  });
});
