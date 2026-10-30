import { expect, test, type Page } from '@playwright/test';
import { expectShellIntact, settle } from './support/host';

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

async function clearSiteData(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  });
}

test.describe('app-shell integrity', () => {
  test.beforeEach(async ({ page }) => {
    await clearSiteData(page);
    await settle(page, BASE_URL);
  });

  test('a same-origin page outside the SPA does not replace the shell', async ({
    page,
  }) => {
    await page.goto(FOREIGN_PAGE);

    await expectShellIntact(page);
  });

  test('a deep route still gets the app after such a page was visited', async ({
    page,
  }) => {
    // The origin 404s this route (no SPA rewrite on the test server), so the
    // SW answers it from cache — which is exactly the path that turns a
    // poisoned shell into a page that never boots.
    await page.goto(FOREIGN_PAGE);
    await expectShellIntact(page);

    const response = await page.goto(`${BASE_URL}/deep/route`);

    expect(response?.fromServiceWorker()).toBe(true);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Service Worker');
  });
});
