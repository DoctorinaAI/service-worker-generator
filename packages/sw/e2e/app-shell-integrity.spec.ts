import { expect, test, type Page } from '@playwright/test';

const BASE_URL = 'http://localhost:8089';

/**
 * The app shell is the one cache entry that a navigation is answered with
 * when the origin cannot be reached. Anything else landing in that slot is
 * a page that does not boot.
 *
 * `offline.html` stands in for the general case: a same-origin page the
 * host serves itself, outside any SPA rewrite. Real deployments have these
 * — Firebase Hosting serves `/__/auth/handler` and `/__/auth/iframe` for
 * Firebase Auth on the app's own domain, excluded from the `** ->
 * /index.html` rewrite.
 */
const FOREIGN_PAGE = `${BASE_URL}/offline.html`;

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

/** Whatever is currently stored under the canonical shell key. */
async function cachedShell(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const hit = await (await caches.open(name)).match(new Request('index.html'));
      if (hit) return await hit.text();
    }
    return null;
  });
}

test.describe('app-shell integrity', () => {
  test.beforeEach(async ({ page }) => {
    await clearSiteData(page);
    await page.goto(BASE_URL);
    await waitForController(page);
    await page.waitForTimeout(2000);
  });

  test('a same-origin page outside the SPA does not replace the shell', async ({
    page,
  }) => {
    expect(await cachedShell(page)).toContain('data-sw-bootstrap');

    await page.goto(FOREIGN_PAGE);
    await page.waitForTimeout(500);

    const shell = await cachedShell(page);
    expect(shell).toContain('data-sw-bootstrap');
  });

  test('a deep route still gets the app after such a page was visited', async ({
    page,
  }) => {
    // The origin 404s this route (no SPA rewrite on the test server), so the
    // SW answers it from cache — which is exactly the path that turns a
    // poisoned shell into a page that never boots.
    await page.goto(FOREIGN_PAGE);
    await page.waitForTimeout(500);

    const response = await page.goto(`${BASE_URL}/deep/route`);

    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Service Worker');
  });
});
