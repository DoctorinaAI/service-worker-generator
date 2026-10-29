import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

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

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../example/build/web',
);

declare global {
  interface Window {
    __buildMarker?: string;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** A static host whose content a test can replace, like a deploy. */
class Host {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-deploy-'));
  private server?: http.Server;
  origin = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      let file = path.join(this.root, pathname === '/' ? 'index.html' : pathname);
      if (!file.startsWith(this.root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(this.root, 'index.html');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        // What the README asks hosts to send for the shell, bootstrap and
        // worker; harmless for the rest in a test.
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /**
   * Deploy the example build with [marker] in its Dart code. [suffix] makes
   * it a new version; [engine] replaces its engine revision.
   */
  deploy(marker: string, options: { suffix?: string; engine?: string } = {}): void {
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.cpSync(WEB_ROOT, this.root, { recursive: true });

    const edit = (name: string, change: (text: string) => string): void => {
      const file = path.join(this.root, name);
      fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
    };
    edit('main.dart.js', (js) => `${js}\n;window.__buildMarker=${JSON.stringify(marker)};\n`);

    const { suffix, engine } = options;
    if (suffix) {
      edit('sw.js', (js) => js.replace(/"version":"([^"]+)"/, `"version":"$1${suffix}"`));
      edit('bootstrap.js', (js) =>
        js.replace(/"swVersion":"([^"]+)"/, `"swVersion":"$1${suffix}"`),
      );
    }
    if (engine) {
      for (const name of ['sw.js', 'bootstrap.js']) {
        edit(name, (js) =>
          js.replace(/"engineRevision":"[^"]*"/, `"engineRevision":"${engine}"`),
        );
      }
    }
  }
}

/** The marker of the Dart code that ran, surviving a reload in between. */
async function markerOf(page: Page): Promise<string | undefined> {
  try {
    return await page.evaluate(() => window.__buildMarker);
  } catch {
    // The bootstrap reloaded the page while we were asking.
    return undefined;
  }
}

async function controllerUrl(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
  } catch {
    return null;
  }
}

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
    expect(await controllerUrl(page)).toContain('-b');
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
