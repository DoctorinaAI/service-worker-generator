import { expect, test, type Page } from '@playwright/test';

const BASE_URL = 'http://localhost:8089';

/**
 * Wait until our worker controls the page, so the next navigation is served
 * by the SW rather than going straight to the origin.
 */
async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    undefined,
    { timeout: 15_000 },
  );
}

async function clearSiteData(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  });
}

test.describe('app shell', () => {
  test.beforeEach(async ({ page }) => {
    await clearSiteData(page);
    await page.goto(BASE_URL);
    await waitForController(page);
    await page.waitForTimeout(2000);
  });

  test('is pre-cached under its manifest key', async ({ page }) => {
    const cached = await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const hit = await (await caches.open(name)).match(
          new Request('index.html', { cache: 'no-store' }),
        );
        if (hit) return await hit.text();
      }
      return null;
    });
    expect(cached).toContain('data-sw-bootstrap');
  });

  test('answers a navigation while offline', async ({ page, context }) => {
    await context.setOffline(true);
    const response = await page.goto(BASE_URL);
    await context.setOffline(false);

    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(200);
    // Offline the app never boots, so the shell markup is still the document.
    await expect(page.locator('script[data-sw-bootstrap]')).toHaveCount(1);
  });

  test('answers a route the origin does not serve', async ({ page }) => {
    // An SPA deep link. The test server has no such file and answers 404,
    // standing in for a host without an index.html rewrite; the pre-cached
    // shell is what keeps the route loadable.
    const response = await page.goto(`${BASE_URL}/deep/route`);

    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(200);
    // The shell's own title, on the deep URL: the navigation committed and
    // what committed was index.html. Flutter boots here and takes the body
    // over, so the markup itself is no longer there to assert on.
    expect(page.url()).toBe(`${BASE_URL}/deep/route`);
    await expect(page).toHaveTitle('Service Worker');
  });
});
