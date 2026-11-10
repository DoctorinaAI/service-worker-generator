import { expect, test } from '@playwright/test';
import { controllerUrl, Host, markerOf } from './support/host';

/**
 * Audit #30, item 4.6: a second tab open during a deploy had no coverage.
 *
 * A worker cannot activate while any client is still controlled by the old
 * one, so the new build's worker sits in `waiting` for as long as the other
 * tab is open — which is exactly the state the update flow is built around,
 * and the state a page that reloads into it has to cope with.
 */
test.describe('a second tab open during a deploy', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
  });

  test.afterEach(async () => {
    await host.stop();
  });

  test('both tabs run the new build, and the worker takes over once they are gone', async ({
    context,
  }) => {
    test.setTimeout(120_000);
    host.deploy('a');

    const first = await context.newPage();
    await first.goto(host.origin);
    await expect.poll(() => markerOf(first), { timeout: 30_000 }).toBe('a');
    await expect.poll(() => controllerUrl(first), { timeout: 30_000 }).not.toBeNull();

    const second = await context.newPage();
    await second.goto(host.origin);
    await expect.poll(() => markerOf(second), { timeout: 30_000 }).toBe('a');

    // The deploy lands while both tabs are open.
    host.deploy('b', { suffix: '-b' });
    await first.reload();

    // The reloaded tab runs the new code even though the old worker is
    // still in control — it has to be, because the other tab holds it
    // there (issue #40).
    await expect.poll(() => markerOf(first), { timeout: 60_000 }).toBe('b');
    expect(await controllerUrl(first)).not.toContain('-b');

    // The tab that was not reloaded keeps running the build it loaded.
    expect(await markerOf(second)).toBe('a');

    // The new worker is installed and waiting for the old one to be let go.
    await expect
      .poll(
        () =>
          first
            .evaluate(async () => {
              const registration = await navigator.serviceWorker.getRegistration();
              return !!registration?.waiting;
            })
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);

    // Close the holdout and reload: nothing is controlled by the old
    // worker any more, so the new one takes over.
    await second.close();
    let controller: string | null = null;
    for (let load = 0; load < 3 && !controller?.includes('-b'); load++) {
      await first.reload();
      await expect.poll(() => markerOf(first), { timeout: 30_000 }).toBe('b');
      controller = await controllerUrl(first);
    }
    expect(controller).toContain('-b');
  });
});
