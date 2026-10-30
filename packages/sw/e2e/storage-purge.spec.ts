import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cachedText, controllerUrl, Host, markerOf, settle } from './support/host';

/**
 * Coming back after the browser reclaimed storage.
 *
 * Safari's tracking prevention deletes script-writable storage, the worker
 * registration included, after seven days of browser use without interaction
 * with the site, and any browser may evict caches under disk pressure. Waiting
 * that out is not an option in a test, so these remove the same state directly
 * and check the next load recovers.
 */
async function purgeCaches(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all((await caches.keys()).map((name) => caches.delete(name)));
  });
}

async function evictMainDartJs(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      await (await caches.open(name)).delete(new Request('main.dart.js'));
    }
  });
}

/** The files the deployed worker stores on install, from its manifest. */
function precachedFiles(root: string): string[] {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const entry = /"([^"]+)":\{"name":"[^"]+","size":\d+,"hash":"[^"]+","category":"(?:core|required)"/g;
  return [...sw.matchAll(entry)].map((match) => match[1]!);
}

test.describe('storage purge', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
    host.deploy('a');
  });

  test.afterEach(async () => {
    await host.stop();
  });

  test('recovers when caches are gone but the worker is still registered', async ({ page }) => {
    await settle(page, host.origin);
    await purgeCaches(page);
    host.requests.length = 0;

    await page.reload();

    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    // A self-healing refill names this build's bytes by hash, so that no
    // intermediate cache can pin another build's file under this version.
    expect(host.seen('/main.dart.js').some((r) => r.url.includes('v='))).toBe(true);
    await expect
      .poll(() => cachedText(page, 'main.dart.js').then((text) => text !== null))
      .toBe(true);
  });

  test('recovers when caches and the registration are both gone', async ({ page }) => {
    await settle(page, host.origin);
    await purgeCaches(page);
    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    });

    await settle(page, host.origin);

    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    expect(await controllerUrl(page)).not.toBeNull();
  });

  test('refills one evicted file without refetching the rest', async ({ page }) => {
    await settle(page, host.origin);
    await evictMainDartJs(page);
    host.requests.length = 0;

    await page.reload();

    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    await expect
      .poll(() => cachedText(page, 'main.dart.js').then((text) => text !== null))
      .toBe(true);
    expect(host.seen('/main.dart.js').length).toBeGreaterThan(0);
    // Every other file install stored must still come from the cache. The shell
    // is network-first, so it is the one exception.
    const stored = precachedFiles(host.root).filter(
      (file) => file !== 'main.dart.js' && file !== 'index.html',
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.filter((file) => host.seen(`/${file}`).length > 0)).toEqual([]);
  });

  test('retries the refill when the origin answers 503 once', async ({ page }) => {
    await settle(page, host.origin);
    await evictMainDartJs(page);
    host.requests.length = 0;
    let failed = false;
    host.fault = ({ pathname }, res) => {
      if (failed || pathname !== '/main.dart.js') return false;
      failed = true;
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('try later');
      return true;
    };

    await page.reload();

    await expect.poll(() => markerOf(page), { timeout: 30_000 }).toBe('a');
    // Both by hash: without the retry, the second would be the plain fallback,
    // which can be answered with another build's file.
    const refills = host.seen('/main.dart.js');
    expect(refills).toHaveLength(2);
    expect(refills.every((r) => r.url.includes('v='))).toBe(true);
  });
});
