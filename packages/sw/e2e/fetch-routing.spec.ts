import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  cachedText,
  expectShellIntact,
  Host,
  settle,
  WEB_ROOT,
  workerVersion,
} from './support/host';

/**
 * Which requests the worker answers, and how, in every engine. The scenarios
 * follow the WPT service-worker suite (`fetch-event-redirect`,
 * `navigation-preload`) and the strategies Workbox tests, against our build.
 */
test.describe('fetch routing', () => {
  let host: Host;

  test.beforeEach(async () => {
    host = new Host();
    await host.start();
    host.deploy('a');
  });

  test.afterEach(async () => {
    await host.stop();
  });

  test('a redirecting navigation is followed', async ({ page }) => {
    await settle(page, host.origin);
    host.fault = ({ pathname }, res) => {
      if (pathname !== '/old') return false;
      res.writeHead(302, { Location: '/offline.html' }).end();
      return true;
    };

    await page.goto(`${host.origin}/old`);

    expect(page.url()).toBe(`${host.origin}/offline.html`);
  });

  test('a redirect answering a request for the shell does not replace it', async ({ page }) => {
    await settle(page, host.origin);
    // A sign-in gateway in front of the app. `/` is the one navigation allowed
    // to refresh the shell, so this is the one that could store its target.
    host.fault = ({ pathname }, res) => {
      if (pathname !== '/') return false;
      res.writeHead(302, { Location: '/offline.html' }).end();
      return true;
    };

    await page.goto(host.origin);

    expect(page.url()).toBe(`${host.origin}/offline.html`);
    await expectShellIntact(page);
  });

  test('a Range request goes to the network even with the file cached', async ({ page }) => {
    await settle(page, host.origin);
    const file = fs.readFileSync(path.join(WEB_ROOT, 'favicon.png'));
    const cachedSize = () =>
      page.evaluate(async () => {
        for (const name of await caches.keys()) {
          const hit = await (await caches.open(name)).match(new Request('favicon.png'));
          if (hit) return (await hit.arrayBuffer()).byteLength;
        }
        return null;
      });
    await page.evaluate(async () => {
      await (await fetch('favicon.png')).arrayBuffer();
    });
    await expect.poll(cachedSize).toBe(file.length);
    host.fault = ({ pathname, headers }, res) => {
      if (pathname !== '/favicon.png' || !headers.range) return false;
      res
        .writeHead(206, {
          'Content-Range': `bytes 0-1/${file.length}`,
          'Content-Length': '2',
        })
        .end('ok');
      return true;
    };

    const status = await page.evaluate(
      async () => (await fetch('favicon.png', { headers: { Range: 'bytes=0-1' } })).status,
    );

    // Answered from cache, this would be a 200 with the whole file.
    expect(status).toBe(206);
    expect(host.seen('/favicon.png').some((r) => r.headers.range)).toBe(true);
    expect(await cachedSize()).toBe(file.length);
  });

  test('POST and unlisted requests pass through uncached', async ({ page }) => {
    await settle(page, host.origin);
    host.fault = ({ pathname }, res) => {
      if (!pathname.startsWith('/api/')) return false;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return true;
    };

    const statuses = await page.evaluate(async () => [
      (await fetch('api/save', { method: 'POST', body: '{}' })).status,
      (await fetch('api/list')).status,
      (await fetch('api/list')).status,
    ]);

    expect(statuses).toEqual([200, 200, 200]);
    expect(host.seen('/api/save').map((r) => r.method)).toEqual(['POST']);
    expect(host.seen('/api/list')).toHaveLength(2);
    expect(await cachedText(page, 'api/list')).toBeNull();
  });

  test('an optional file is cached on first fetch and then served from cache', async ({ page }) => {
    await settle(page, host.origin);
    const key = 'icons/Icon-512.png';
    const expected = fs.statSync(path.join(WEB_ROOT, key)).size;
    const fetchSize = () =>
      page.evaluate(async (k) => (await (await fetch(k)).arrayBuffer()).byteLength, key);

    expect(await fetchSize()).toBe(expected);
    await expect
      .poll(() => cachedText(page, key).then((text) => text !== null))
      .toBe(true);

    const served = host.seen(`/${key}`).length;
    expect(await fetchSize()).toBe(expected);
    expect(host.seen(`/${key}`)).toHaveLength(served);
  });

  test('navigations use navigation preload', async ({ page }) => {
    await settle(page, host.origin);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.ready;
          return (await reg.navigationPreload.getState()).enabled;
        }),
      )
      .toBe(true);

    host.requests.length = 0;
    await page.goto(`${host.origin}/index.html`);

    expect(
      host.seen('/index.html').some((r) => r.headers['service-worker-navigation-preload']),
    ).toBe(true);
  });

  test('the worker reports the deployed version over its message protocol', async ({ page }) => {
    await settle(page, host.origin);
    const sw = fs.readFileSync(path.join(host.root, 'sw.js'), 'utf8');
    const version = /"version":"([^"]+)"/.exec(sw)?.[1];

    expect(version).toBeTruthy();
    expect(await workerVersion(page)).toBe(version);
  });
});
