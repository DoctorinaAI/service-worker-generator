import { expect, test } from '@playwright/test';
import { clearSiteData, settle } from './support/host';

const BASE_URL = 'http://localhost:8089';

test.describe('app shell', () => {
  // Every test here clears the site data and waits for a cold install to
  // finish: ~2.4 MB of pre-cache, a worker activation and a claim, which
  // on a loaded CI runner in WebKit does not fit the suite's 30 s default.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await clearSiteData(page, BASE_URL);
    await settle(page, BASE_URL);
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

  test('answers a navigation while offline', async ({ page, context, browserName }) => {
    // Playwright's WebKit fails the navigation under `setOffline` with an
    // internal error. Taking the origin down really works there; see
    // origin-faults.spec.ts.
    test.skip(browserName === 'webkit', 'setOffline breaks navigation in WebKit');
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
