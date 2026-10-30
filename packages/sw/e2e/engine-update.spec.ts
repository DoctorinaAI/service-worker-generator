import { expect, test, type Page } from '@playwright/test';
import { controllerUrl, Host, markerOf } from './support/host';

/**
 * The first load after a deploy, while the previous build's worker still
 * controls the page.
 *
 * That worker serves its cached `main.dart.*`; `index.html` and
 * `bootstrap.js` come from the new build, and the bootstrap loads the
 * engine for the new build's revision. Both "deploys" here are the example
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

  test('boots at once with the current worker when the engine is the same', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await settleOnBuildA(page);

    host.deploy('b', { suffix: '-b' });
    await page.reload();

    // Build A's code on the same engine: compatible, and nothing to wait
    // for. The new worker takes over on the next load.
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');

    // The handover on a later load can lose its race with a request the
    // page makes, which leaves it for the load after; a few loads settle it.
    let marker: string | undefined;
    for (let load = 0; load < 3 && marker !== 'b'; load++) {
      await page.reload();
      await expect.poll(() => markerOf(page), { timeout: 30_000 }).toMatch(/^[ab]$/);
      marker = await markerOf(page);
    }
    expect(marker).toBe('b');
  });
});
