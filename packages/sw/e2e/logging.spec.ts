import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { Host, markerOf } from './support/host';

/**
 * Issue #38: what the artifacts print on the console has to be something a
 * deployment can turn off.
 *
 * Checked on the built bundles, through the level the generator injects —
 * the unit tests pin the logger's rules, this pins that every call site in
 * both artifacts really goes through it.
 */

/** Anything the worker, the bootstrap or the widget prints says so. */
const OURS = /\[SW\]|\[Bootstrap\]|\[Init\]|\[CanvasKit\]|\[Flutter\]|Service Worker Bootstrap/;

function collect(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (message: ConsoleMessage) => lines.push(message.text()));
  return lines;
}

test.describe('console output', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
  });

  test.afterEach(async () => {
    await host.stop();
  });

  test('is there by default', async ({ page }) => {
    // The control: without it, a silent run proves nothing.
    const lines = collect(page);
    host.deploy('a');
    await page.goto(host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');

    expect(lines.filter((line) => OURS.test(line)).length).toBeGreaterThan(0);
  });

  test('is silent at --log-level=silent, and the app still boots', async ({
    page,
  }) => {
    const lines = collect(page);
    host.deploy('a', { logLevel: 'silent' });
    await page.goto(host.origin);
    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');

    expect(lines.filter((line) => OURS.test(line))).toEqual([]);
  });
});
