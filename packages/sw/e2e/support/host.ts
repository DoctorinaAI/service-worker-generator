import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

export const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../example/build/web',
);

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

/** A request as the origin saw it. */
export interface SeenRequest {
  method: string;
  /** Path and query. */
  url: string;
  pathname: string;
  headers: http.IncomingHttpHeaders;
}

/** Answers a request itself by returning true; false serves the file. */
export type Fault = (
  request: SeenRequest,
  response: http.ServerResponse,
) => boolean;

/**
 * A static host a test can redeploy, break and take down.
 *
 * A worker's own fetches never reach `page.route()`, and which of them an
 * engine exposes to Playwright differs per browser. The origin sees all of
 * them in every engine, so that is where these tests inject failures and
 * observe traffic.
 */
export class Host {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-deploy-'));
  readonly requests: SeenRequest[] = [];
  /** Installed by a test to make the origin misbehave. */
  fault?: Fault;
  origin = '';
  private server?: http.Server;
  private port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(this.port, '127.0.0.1', resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
    this.origin = `http://127.0.0.1:${this.port}`;
  }

  /** Take the origin off the network: connections are refused. */
  async down(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async stop(): Promise<void> {
    await this.down();
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** Requests for [pathname], query strings included. */
  seen(pathname: string): SeenRequest[] {
    return this.requests.filter((r) => r.pathname === pathname);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    const seen: SeenRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      pathname,
      headers: req.headers,
    };
    this.requests.push(seen);
    if (this.fault?.(seen, res)) return;

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
    // The worker refuses a body whose size differs from its manifest, so the
    // marked file gets a manifest entry of its own, as a real build would.
    const marked = fs.readFileSync(path.join(this.root, 'main.dart.js'));
    edit('sw.js', (js) =>
      js.replace(
        /("main\.dart\.js":\{"name":"main\.dart\.js","size":)\d+(,"hash":")[0-9a-f]+/,
        `$1${marked.length}$2${crypto.createHash('md5').update(marked).digest('hex')}`,
      ),
    );

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

declare global {
  interface Window {
    __buildMarker?: string;
  }
}

/** The marker of the Dart code that ran, surviving a reload in between. */
export async function markerOf(page: Page): Promise<string | undefined> {
  try {
    return await page.evaluate(() => window.__buildMarker);
  } catch {
    // The bootstrap reloaded the page while we were asking.
    return undefined;
  }
}

export async function controllerUrl(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
  } catch {
    return null;
  }
}

/**
 * Whatever is stored under [key] in any cache, as text, or null.
 *
 * Asked from the page because that works in every engine:
 * `context.serviceWorkers()` is Chromium-only.
 */
export async function cachedText(page: Page, key: string): Promise<string | null> {
  return page.evaluate(async (k) => {
    for (const name of await caches.keys()) {
      const hit = await (await caches.open(name)).match(new Request(k));
      if (hit) return hit.text();
    }
    return null;
  }, key);
}

/** Load [page] and wait until the worker controls it with the shell stored. */
export async function settle(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect.poll(() => controllerUrl(page), { timeout: 30_000 }).not.toBeNull();
  await expect
    .poll(() => cachedText(page, 'index.html').catch(() => null), { timeout: 30_000 })
    .toContain('data-sw-bootstrap');
}

/** The version the controlling worker reports, over its message protocol. */
export async function workerVersion(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const worker = navigator.serviceWorker;
        const timer = setTimeout(() => resolve(null), 5_000);
        worker.addEventListener('message', function onMessage(event) {
          if ((event as MessageEvent).data?.type !== 'version') return;
          worker.removeEventListener('message', onMessage);
          clearTimeout(timer);
          resolve((event as MessageEvent).data.version as string);
        });
        worker.controller?.postMessage({ type: 'getVersion' });
      }),
  );
}
