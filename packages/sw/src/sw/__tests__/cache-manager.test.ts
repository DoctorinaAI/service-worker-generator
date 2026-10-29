/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getContentCacheName,
  getTempCacheName,
  getManifestCacheName,
  precacheResources,
  swapCaches,
  cleanupOldCaches,
  lazyCacheResponse,
  cleanupOrphanedTempCaches,
} from '../cache-manager';
import type { ResourceManifest } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';
import { BODY_STALL_TIMEOUT_MS } from '../../shared/constants';
import {
  installMockCaches,
  installMockFetch,
  textResponse,
  type MockCacheStorage,
} from '../../__tests__/helpers';
import { resetQuotaReportThrottle } from '../quota';

describe('cache naming', () => {
  describe('getContentCacheName', () => {
    it('combines prefix and version', () => {
      expect(getContentCacheName('my-app', 'v1')).toBe('my-app-v1');
    });

    it('handles numeric version', () => {
      expect(getContentCacheName('app', '12345')).toBe('app-12345');
    });
  });

  describe('getTempCacheName', () => {
    it('includes temp suffix', () => {
      expect(getTempCacheName('my-app', 'v1')).toBe('my-app-temp-v1');
    });
  });

  describe('getManifestCacheName', () => {
    it('includes manifest suffix', () => {
      expect(getManifestCacheName('my-app')).toBe('my-app-manifest');
    });
  });
});

function buildManifest(entries: Partial<ResourceManifest>): ResourceManifest {
  return entries as ResourceManifest;
}

describe('precacheResources', () => {
  let mockCaches: MockCacheStorage;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCaches = installMockCaches();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('caches matching entries with cache-busted URLs but stores under the plain path', async () => {
    const fetchSpy = installMockFetch(async (req) => textResponse(`body of ${req.url}`));
    const manifest = buildManifest({
      'main.dart.js': {
        name: 'main.dart.js',
        size: 100,
        hash: 'abc',
        category: ResourceCategory.Core,
      },
      'AssetManifest.json': {
        name: 'AssetManifest.json',
        size: 50,
        hash: 'def',
        category: ResourceCategory.Required,
      },
      'logo.png': {
        name: 'logo.png',
        size: 30,
        hash: 'ghi',
        category: ResourceCategory.Optional,
      },
    });

    await precacheResources('temp-v1', manifest, [
      ResourceCategory.Core,
      ResourceCategory.Required,
    ]);

    const calls = fetchSpy.mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('main.dart.js?v=abc'),
        expect.stringContaining('AssetManifest.json?v=def'),
      ]),
    );
    expect(calls.some((u) => u.includes('logo.png'))).toBe(false);

    const cache = mockCaches.peek('temp-v1');
    expect(cache).toBeDefined();
    expect(await cache!.match('main.dart.js')).toBeDefined();
    expect(await cache!.match('AssetManifest.json')).toBeDefined();
    expect(await cache!.match('logo.png')).toBeUndefined();
  });

  it('calls onEach callback per successful resource', async () => {
    installMockFetch(async () => textResponse('ok'));
    const manifest = buildManifest({
      'a.js': {
        name: 'a.js',
        size: 10,
        hash: 'h1',
        category: ResourceCategory.Core,
      },
      'b.json': {
        name: 'b.json',
        size: 20,
        hash: 'h2',
        category: ResourceCategory.Required,
      },
    });

    const seen: string[] = [];
    await precacheResources(
      'temp-v1',
      manifest,
      [ResourceCategory.Core, ResourceCategory.Required],
      (path) => {
        seen.push(path);
      },
    );

    expect(seen.sort()).toEqual(['a.js', 'b.json']);
  });

  it('does not fail a stored Core entry when its progress report throws', async () => {
    // Telemetry must not decide whether the install succeeds: the entry is
    // already in the cache when the callback runs.
    installMockFetch(async () => textResponse('core'));
    const manifest = buildManifest({
      'main.dart.js': {
        name: 'main.dart.js',
        size: 10,
        hash: 'h1',
        category: ResourceCategory.Core,
      },
    });

    await expect(
      precacheResources('temp-v1', manifest, [ResourceCategory.Core], () => {
        throw new Error('no clients');
      }),
    ).resolves.toBeUndefined();

    expect(await mockCaches.peek('temp-v1')!.match('main.dart.js')).toBeDefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws aggregated error when any Core resource fails', async () => {
    // 5xx is retried with backoff now; collapse the delays.
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);
    installMockFetch(async (req) => {
      if (req.url.includes('core.js')) return textResponse('nope', 500);
      return textResponse('ok');
    });
    const manifest = buildManifest({
      'core.js': {
        name: 'core.js',
        size: 100,
        hash: 'c',
        category: ResourceCategory.Core,
      },
      'ok.js': {
        name: 'ok.js',
        size: 100,
        hash: 'o',
        category: ResourceCategory.Core,
      },
    });

    await expect(
      precacheResources('temp-v1', manifest, [ResourceCategory.Core]),
    ).rejects.toThrow(/core\.js/);
  });

  it('fails a Core entry whose body stalls, rather than hanging the install', async () => {
    vi.useFakeTimers();
    // Headers arrive fine and the body starts, then the stream goes silent
    // forever. Before the stall guard this hung `cache.put` — and therefore
    // `install`, and therefore every later `register()` on the origin.
    installMockFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'));
            },
          }),
          { status: 200 },
        ),
    );

    // The real Cache reads the body to completion; MockCache only clones it,
    // which would never notice a stalled stream.
    const cache = await caches.open('temp-v1');
    vi.spyOn(cache, 'put').mockImplementation(async (_req, response) => {
      await (response as Response).arrayBuffer();
    });

    const manifest = buildManifest({
      'main.dart.js': {
        name: 'main.dart.js',
        size: 9_800_000,
        hash: 'abc',
        category: ResourceCategory.Core,
      },
    });

    const promise = precacheResources('temp-v1', manifest, [
      ResourceCategory.Core,
    ]);
    const assertion = expect(promise).rejects.toThrow(/stalled/);
    await vi.advanceTimersByTimeAsync(BODY_STALL_TIMEOUT_MS + 1);
    await assertion;
  });

  it('does not throw when Required/Optional resources fail (just warns)', async () => {
    // Collapse retry backoff to zero so this test is fast.
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    installMockFetch(async (req) => {
      if (req.url.includes('bad.json')) throw new Error('offline');
      return textResponse('ok');
    });
    const manifest = buildManifest({
      'good.js': {
        name: 'good.js',
        size: 10,
        hash: 'g',
        category: ResourceCategory.Core,
      },
      'bad.json': {
        name: 'bad.json',
        size: 20,
        hash: 'b',
        category: ResourceCategory.Required,
      },
    });

    await expect(
      precacheResources('temp-v1', manifest, [
        ResourceCategory.Core,
        ResourceCategory.Required,
      ]),
    ).resolves.toBeUndefined();

    const cache = mockCaches.peek('temp-v1');
    expect(await cache!.match('good.js')).toBeDefined();
    expect(await cache!.match('bad.json')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('treats non-ok HTTP response as failure', async () => {
    installMockFetch(async () => textResponse('bad', 404));
    const manifest = buildManifest({
      'only.js': {
        name: 'only.js',
        size: 10,
        hash: 'x',
        category: ResourceCategory.Core,
      },
    });

    await expect(
      precacheResources('temp-v1', manifest, [ResourceCategory.Core]),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('fails a Core entry the host answered with its HTML shell', async () => {
    // An SPA rewrite answers a file the deploy lacks with index.html and
    // status 200. Cached, it would be served as the script until the next
    // deploy.
    installMockFetch(
      async () =>
        new Response('<!DOCTYPE html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    );
    const manifest = buildManifest({
      'main.dart.mjs': {
        name: 'main.dart.mjs',
        size: 10,
        hash: 'x',
        category: ResourceCategory.Core,
      },
    });

    await expect(
      precacheResources('temp-v1', manifest, [ResourceCategory.Core]),
    ).rejects.toThrow(/served as HTML/);
    expect(await mockCaches.peek('temp-v1')?.match('main.dart.mjs')).toBeUndefined();
  });

  it('still precaches the shell itself, which is HTML', async () => {
    installMockFetch(
      async () =>
        new Response('<!DOCTYPE html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const manifest = buildManifest({
      'index.html': {
        name: 'index.html',
        size: 15,
        hash: 'x',
        category: ResourceCategory.Required,
      },
    });

    await precacheResources('temp-v1', manifest, [ResourceCategory.Required]);
    expect(await mockCaches.peek('temp-v1')?.match('index.html')).toBeDefined();
  });

  it('filters out entries outside requested categories', async () => {
    const fetchSpy = installMockFetch(async () => textResponse('ok'));
    const manifest = buildManifest({
      'a.js': {
        name: 'a.js',
        size: 10,
        hash: 'a',
        category: ResourceCategory.Core,
      },
      'b.map': {
        name: 'b.map',
        size: 20,
        hash: 'b',
        category: ResourceCategory.Ignore,
      },
    });

    await precacheResources('temp-v1', manifest, [ResourceCategory.Core]);
    const urls = fetchSpy.mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(urls.some((u) => u.includes('a.js'))).toBe(true);
    expect(urls.some((u) => u.includes('b.map'))).toBe(false);
  });
});

describe('lazyCacheResponse', () => {
  it('stores a clone of the response in the specified cache', async () => {
    const mockCaches = installMockCaches();
    const response = textResponse('payload');
    await lazyCacheResponse('content-v1', new Request('file.js'), response);

    const cache = mockCaches.peek('content-v1');
    expect(cache).toBeDefined();
    const stored = await cache!.match('file.js');
    expect(stored).toBeDefined();
    expect(await stored!.text()).toBe('payload');
  });

  it('does not consume the original response body', async () => {
    installMockCaches();
    const response = textResponse('payload');
    await lazyCacheResponse('content-v1', new Request('file.js'), response);
    expect(await response.text()).toBe('payload');
  });
});

describe('lazyCacheResponse with an HTML fallback', () => {
  it('does not cache an HTML page served for a non-HTML file', async () => {
    const mockCaches = installMockCaches();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = new Response('<!DOCTYPE html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    await lazyCacheResponse('content-v1', new Request('assets/logo.png'), response);
    expect(await mockCaches.peek('content-v1')?.match('assets/logo.png')).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('swapCaches', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
  });

  it('copies all temp entries into the content cache and deletes temp', async () => {
    const temp = await mockCaches.open('app-temp-v2');
    await temp.put(new Request('a.js'), textResponse('A'));
    await temp.put(new Request('b.js'), textResponse('B'));

    const manifest: ResourceManifest = {
      'a.js': { name: 'a.js', size: 1, hash: 'a', category: ResourceCategory.Core },
      'b.js': { name: 'b.js', size: 1, hash: 'b', category: ResourceCategory.Core },
    };

    await swapCaches('app', 'v2', manifest);

    const content = mockCaches.peek('app-v2');
    expect(content).toBeDefined();
    expect(await content!.match('a.js')).toBeDefined();
    expect(await content!.match('b.js')).toBeDefined();
    expect(mockCaches.peek('app-temp-v2')).toBeUndefined();
  });

  it('keeps the freshly-precached entry when its hash changed vs previous manifest', async () => {
    // Regression: copy must run BEFORE eviction so a re-precached hash-
    // changed entry is present in content when eviction walks the old
    // manifest, and thus survives the pass.
    const content = await mockCaches.open('app-v1');
    await content.put(new Request('main.dart.js'), textResponse('old-body'));

    const manifestCache = await mockCaches.open('app-manifest');
    const previousManifest: ResourceManifest = {
      'main.dart.js': {
        name: 'main.dart.js',
        size: 1,
        hash: 'h-old',
        category: ResourceCategory.Core,
      },
    };
    await manifestCache.put(
      new Request('manifest'),
      new Response(JSON.stringify(previousManifest), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const temp = await mockCaches.open('app-temp-v1');
    await temp.put(new Request('main.dart.js'), textResponse('new-body'));

    const newManifest: ResourceManifest = {
      'main.dart.js': {
        name: 'main.dart.js',
        size: 1,
        hash: 'h-new',
        category: ResourceCategory.Core,
      },
    };

    await swapCaches('app', 'v1', newManifest);

    const updated = mockCaches.peek('app-v1');
    const stored = await updated!.match('main.dart.js');
    expect(stored).toBeDefined();
    expect(await stored!.text()).toBe('new-body');
  });

  it('evicts hash-changed entries when no fresh version was precached', async () => {
    // An Optional resource whose hash changed but wasn't re-precached:
    // the stale content must be evicted so cacheFirst refetches it lazily
    // instead of serving the old bytes.
    const content = await mockCaches.open('app-v1');
    await content.put(new Request('logo.png'), textResponse('old-logo'));

    const manifestCache = await mockCaches.open('app-manifest');
    await manifestCache.put(
      new Request('manifest'),
      new Response(
        JSON.stringify({
          'logo.png': {
            name: 'logo.png',
            size: 1,
            hash: 'h-old',
            category: ResourceCategory.Optional,
          },
        } as ResourceManifest),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    // Empty temp cache — nothing was re-precached.
    await mockCaches.open('app-temp-v1');

    const newManifest: ResourceManifest = {
      'logo.png': {
        name: 'logo.png',
        size: 1,
        hash: 'h-new',
        category: ResourceCategory.Optional,
      },
    };
    await swapCaches('app', 'v1', newManifest);

    const updated = mockCaches.peek('app-v1');
    expect(await updated!.match('logo.png')).toBeUndefined();
  });

  it('evicts entries that are no longer in the new manifest', async () => {
    const content = await mockCaches.open('app-v1');
    await content.put(new Request('old.js'), textResponse('old'));
    await content.put(new Request('kept.js'), textResponse('kept-content'));

    const manifestCache = await mockCaches.open('app-manifest');
    const previousManifest: ResourceManifest = {
      'old.js': {
        name: 'old.js',
        size: 1,
        hash: 'h-old',
        category: ResourceCategory.Core,
      },
      'kept.js': {
        name: 'kept.js',
        size: 1,
        hash: 'h-kept',
        category: ResourceCategory.Core,
      },
    };
    await manifestCache.put(
      new Request('manifest'),
      new Response(JSON.stringify(previousManifest), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // No new temp entries this swap — just validate the eviction pass.
    await mockCaches.open('app-temp-v1');

    const newManifest: ResourceManifest = {
      'kept.js': {
        name: 'kept.js',
        size: 1,
        hash: 'h-kept',
        category: ResourceCategory.Core,
      },
    };

    await swapCaches('app', 'v1', newManifest);

    const updated = mockCaches.peek('app-v1');
    expect(await updated!.match('old.js')).toBeUndefined();
    expect(await updated!.match('kept.js')).toBeDefined();
  });

  it('persists the current manifest for future swaps', async () => {
    const temp = await mockCaches.open('app-temp-v3');
    await temp.put(new Request('x.js'), textResponse('x'));

    const manifest: ResourceManifest = {
      'x.js': { name: 'x.js', size: 1, hash: 'h', category: ResourceCategory.Core },
    };

    await swapCaches('app', 'v3', manifest);

    const manifestCache = mockCaches.peek('app-manifest');
    expect(manifestCache).toBeDefined();
    const stored = await manifestCache!.match('manifest');
    expect(stored).toBeDefined();
    const parsed = JSON.parse(await stored!.text()) as ResourceManifest;
    expect(parsed['x.js'].hash).toBe('h');
  });

  it('is a no-op on outdated eviction when no previous manifest exists', async () => {
    const temp = await mockCaches.open('app-temp-v1');
    await temp.put(new Request('a.js'), textResponse('A'));

    const manifest: ResourceManifest = {
      'a.js': { name: 'a.js', size: 1, hash: 'a', category: ResourceCategory.Core },
    };

    await swapCaches('app', 'v1', manifest);

    const content = mockCaches.peek('app-v1');
    expect(await content!.match('a.js')).toBeDefined();
  });

  it('tolerates a corrupt previous manifest payload', async () => {
    const manifestCache = await mockCaches.open('app-manifest');
    await manifestCache.put(
      new Request('manifest'),
      new Response('{not json', { headers: { 'Content-Type': 'application/json' } }),
    );

    const temp = await mockCaches.open('app-temp-v1');
    await temp.put(new Request('a.js'), textResponse('A'));

    const manifest: ResourceManifest = {
      'a.js': { name: 'a.js', size: 1, hash: 'a', category: ResourceCategory.Core },
    };

    await expect(swapCaches('app', 'v1', manifest)).resolves.toBeUndefined();
    const content = mockCaches.peek('app-v1');
    expect(await content!.match('a.js')).toBeDefined();
  });
});

describe('cleanupOldCaches', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
  });

  it('deletes older versioned caches but preserves current and manifest', async () => {
    await mockCaches.open('app-v1');
    await mockCaches.open('app-v2');
    await mockCaches.open('app-v3');
    await mockCaches.open('app-manifest');
    await mockCaches.open('other-v1');

    await cleanupOldCaches('app', 'v3');

    const keys = await mockCaches.keys();
    expect(keys.sort()).toEqual(['app-manifest', 'app-v3', 'other-v1']);
  });

  it('also deletes temp caches from previous installs', async () => {
    await mockCaches.open('app-temp-v2');
    await mockCaches.open('app-v3');
    await mockCaches.open('app-manifest');

    await cleanupOldCaches('app', 'v3');
    const keys = await mockCaches.keys();
    expect(keys).not.toContain('app-temp-v2');
    expect(keys).toContain('app-v3');
  });

  it('keeps the temp caches of pending versions', async () => {
    await mockCaches.open('app-temp-v4');
    await mockCaches.open('app-temp-v2');
    await mockCaches.open('app-v3');
    await cleanupOldCaches('app', 'v3', ['v4']);
    const keys = await mockCaches.keys();
    expect(keys).toContain('app-temp-v4');
    expect(keys).not.toContain('app-temp-v2');
  });

  it('does not claim caches of a longer prefix', async () => {
    // `app-cache` must not reach into `app-cache2`'s caches.
    await mockCaches.open('app-cache2-v1');
    await mockCaches.open('app-cache-v1');
    await mockCaches.open('app-cache-v2');
    await cleanupOldCaches('app-cache', 'v2');
    const keys = await mockCaches.keys();
    expect(keys.sort()).toEqual(['app-cache-v2', 'app-cache2-v1']);
  });

  it('does nothing when no matching caches exist', async () => {
    const mockCaches2 = installMockCaches();
    await mockCaches2.open('other-thing');
    await cleanupOldCaches('app', 'v1');
    const keys = await mockCaches2.keys();
    expect(keys).toEqual(['other-thing']);
  });
});

/**
 * Make `cache.put` read the body to completion before storing it, the way
 * the real Cache API does. MockCache only clones, which would never notice
 * a body that errors part-way.
 */
function consumeOnPut(cache: Cache): void {
  const original = cache.put.bind(cache);
  vi.spyOn(cache, 'put').mockImplementation(async (req, response) => {
    const r = response as Response;
    const body = await r.arrayBuffer();
    await original(
      req,
      new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers }),
    );
  });
}

/** Collapse every backoff/timeout delay to zero, recording requested delays. */
function instantTimers(): number[] {
  const delays: number[] = [];
  const origSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    delays.push(ms ?? 0);
    return origSetTimeout(fn, 0);
  }) as unknown as typeof setTimeout);
  return delays;
}

const body = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(1);

describe('precacheResources — audit #30', () => {
  let mockCaches: MockCacheStorage;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetQuotaReportThrottle();
    mockCaches = installMockCaches();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const core = (size: number, name = 'main.dart.wasm'): ResourceManifest => ({
    [name]: { name, size, hash: 'h', category: ResourceCategory.Core },
  });

  it('retries a transient 503 for a Core entry instead of failing the install', async () => {
    instantTimers();
    let n = 0;
    const spy = installMockFetch(async () =>
      ++n === 1 ? textResponse('busy', 503) : new Response(body(10)),
    );
    await expect(
      precacheResources('temp-v1', core(10), [ResourceCategory.Core]),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await mockCaches.peek('temp-v1')!.match('main.dart.wasm')).toBeDefined();
  });

  it('retries a 429 and honours its Retry-After', async () => {
    const delays = instantTimers();
    let n = 0;
    installMockFetch(async () =>
      ++n === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '1' } })
        : new Response(body(10)),
    );
    await precacheResources('temp-v1', core(10), [ResourceCategory.Core]);
    expect(delays).toContain(1_000);
  });

  it('does not retry a 404: it is final', async () => {
    instantTimers();
    const spy = installMockFetch(async () => textResponse('nope', 404));
    await expect(
      precacheResources('temp-v1', core(10), [ResourceCategory.Core]),
    ).rejects.toThrow(/HTTP 404/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails a Core entry whose body comes back short with a different length each time', async () => {
    // A transfer cut off at random: caching it would break the app until
    // the next deploy.
    const sizes = [60, 70, 80];
    installMockFetch(async () => new Response(body(sizes.shift() ?? 90)));
    consumeOnPut(await caches.open('temp-v1'));
    await expect(
      precacheResources('temp-v1', core(100), [ResourceCategory.Core]),
    ).rejects.toThrow(/main\.dart\.wasm/);
    expect(await mockCaches.peek('temp-v1')!.match('main.dart.wasm')).toBeUndefined();
    const logged = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toMatch(/main\.dart\.wasm.*expected 100 bytes.*received 60/);
    expect(logged).toMatch(/60 bytes, then 70.*cut short/);
  });

  it('stores a Core entry the host serves short the same way twice, with a warning', async () => {
    // A host that rewrites the file. Failing it would fail every install
    // and leave the page on its previous worker for good.
    installMockFetch(async () => new Response(body(60)));
    consumeOnPut(await caches.open('temp-v1'));
    await expect(
      precacheResources('temp-v1', core(100), [ResourceCategory.Core]),
    ).resolves.toBeUndefined();
    const stored = await mockCaches.peek('temp-v1')!.match('main.dart.wasm');
    expect(stored).toBeDefined();
    expect((await stored!.arrayBuffer()).byteLength).toBe(60);
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
      /main\.dart\.wasm: the host serves 60 bytes where the build has 100/,
    );
  });

  it('stores a body longer than the build has, since truncation cannot cause it', async () => {
    installMockFetch(async () => new Response(body(120)));
    consumeOnPut(await caches.open('temp-v1'));
    await expect(
      precacheResources('temp-v1', core(100), [ResourceCategory.Core]),
    ).resolves.toBeUndefined();
    const stored = await mockCaches.peek('temp-v1')!.match('main.dart.wasm');
    expect((await stored!.arrayBuffer()).byteLength).toBe(120);
  });

  it('stores a Core entry of the length the host declares in one fetch', async () => {
    const spy = installMockFetch(
      async () => new Response(body(80), { headers: { 'Content-Length': '80' } }),
    );
    consumeOnPut(await caches.open('temp-v1'));
    await precacheResources('temp-v1', core(100), [ResourceCategory.Core]);
    const stored = await mockCaches.peek('temp-v1')!.match('main.dart.wasm');
    expect((await stored!.arrayBuffer()).byteLength).toBe(80);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails a second copy that falls short of its own Content-Length', async () => {
    // The same short length twice looks like a host rewrite, but the host
    // declared the full file the second time: the wire cut it both times.
    let n = 0;
    installMockFetch(async () =>
      ++n === 1
        ? new Response(body(60))
        : new Response(body(60), { headers: { 'Content-Length': '100' } }),
    );
    consumeOnPut(await caches.open('temp-v1'));
    await expect(
      precacheResources('temp-v1', core(100), [ResourceCategory.Core]),
    ).rejects.toThrow(/main\.dart\.wasm/);
    expect(await mockCaches.peek('temp-v1')!.match('main.dart.wasm')).toBeUndefined();
    const logged = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toMatch(/declares 100 bytes and 60 were received.*cut short/);
  });

  it('stores the second copy without a warning when it has the right size', async () => {
    const sizes = [60];
    installMockFetch(async () => new Response(body(sizes.shift() ?? 100)));
    consumeOnPut(await caches.open('temp-v1'));
    await precacheResources('temp-v1', core(100), [ResourceCategory.Core]);
    const stored = await mockCaches.peek('temp-v1')!.match('main.dart.wasm');
    expect((await stored!.arrayBuffer()).byteLength).toBe(100);
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toMatch(
      /the host serves/,
    );
  });

  it('skips (warns about) a Required entry that comes back short at random', async () => {
    const sizes = [5, 7];
    installMockFetch(async () => new Response(body(sizes.shift() ?? 9)));
    consumeOnPut(await caches.open('temp-v1'));
    const manifest: ResourceManifest = {
      'AssetManifest.json': {
        name: 'AssetManifest.json',
        size: 50,
        hash: 'h',
        category: ResourceCategory.Required,
      },
    };
    await expect(
      precacheResources('temp-v1', manifest, [ResourceCategory.Required]),
    ).resolves.toBeUndefined();
    expect(await mockCaches.peek('temp-v1')!.match('AssetManifest.json')).toBeUndefined();
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
      /AssetManifest\.json.*expected 50 bytes.*received 5/,
    );
  });

  it('logs the sizes even when the Cache API rejects with a generic error', async () => {
    // Browsers may reject cache.put with a TypeError for a body that
    // errored, without the guard's own error.
    const sizes = [60, 70];
    installMockFetch(async () => new Response(body(sizes.shift() ?? 80)));
    const cache = await caches.open('temp-v1');
    const realPut = cache.put.bind(cache);
    cache.put = vi.fn(async (req: RequestInfo | URL, res: Response) => {
      try {
        await res.arrayBuffer();
      } catch {
        throw new TypeError('Failed to execute put on Cache');
      }
      return realPut(req, res);
    }) as typeof cache.put;
    await expect(
      precacheResources('temp-v1', core(100), [ResourceCategory.Core]),
    ).rejects.toThrow(/expected 100 bytes/);
  });

  it('stores entries whose size matches, including a zero-size one', async () => {
    installMockFetch(async (req) =>
      req.url.includes('empty.json') ? new Response(null) : new Response(body(10)),
    );
    consumeOnPut(await caches.open('temp-v1'));
    const manifest: ResourceManifest = {
      ...core(10),
      'empty.json': { name: 'empty.json', size: 0, hash: 'e', category: ResourceCategory.Required },
    };
    await precacheResources('temp-v1', manifest, [
      ResourceCategory.Core,
      ResourceCategory.Required,
    ]);
    const temp = mockCaches.peek('temp-v1')!;
    expect(await temp.match('main.dart.wasm')).toBeDefined();
    expect(await temp.match('empty.json')).toBeDefined();
  });

  it('does not size-check the app shell, which hosts may rewrite', async () => {
    installMockFetch(
      async () =>
        new Response('<!DOCTYPE html><script>injected</script>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    consumeOnPut(await caches.open('temp-v1'));
    const manifest: ResourceManifest = {
      'index.html': { name: 'index.html', size: 15, hash: 'x', category: ResourceCategory.Required },
    };
    await precacheResources('temp-v1', manifest, [ResourceCategory.Required]);
    expect(await mockCaches.peek('temp-v1')!.match('index.html')).toBeDefined();
  });

  it('fails a redirected Core entry whose body stalls, rather than hanging', async () => {
    vi.useFakeTimers();
    installMockFetch(async () => {
      const r = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body(3));
          },
        }),
        { status: 200 },
      );
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    });
    consumeOnPut(await caches.open('temp-v1'));
    const promise = precacheResources('temp-v1', core(9_800_000), [ResourceCategory.Core]);
    const assertion = expect(promise).rejects.toThrow(/stalled/);
    await vi.advanceTimersByTimeAsync(BODY_STALL_TIMEOUT_MS + 1);
    await assertion;
  });

  it('stores a redirected shell without the redirected flag', async () => {
    installMockFetch(async () => {
      const r = new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    });
    const manifest: ResourceManifest = {
      'index.html': { name: 'index.html', size: 13, hash: 'x', category: ResourceCategory.Required },
    };
    await precacheResources('temp-v1', manifest, [ResourceCategory.Required]);
    const stored = await mockCaches.peek('temp-v1')!.match('index.html');
    expect(stored!.redirected).toBe(false);
    expect(await stored!.text()).toBe('<html></html>');
  });

  it('logs a quota error distinctly, with the storage estimate', async () => {
    installMockFetch(async () => new Response(body(10)));
    const cache = await caches.open('temp-v1');
    vi.spyOn(cache, 'put').mockRejectedValue(
      new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    );
    const estimate = vi.fn(async () => ({ usage: 900, quota: 1000 }));
    Object.defineProperty(navigator, 'storage', {
      value: { estimate },
      configurable: true,
    });
    try {
      await expect(
        precacheResources('temp-v1', core(10), [ResourceCategory.Core]),
      ).rejects.toThrow(/Precache failed/);
      await vi.waitFor(() => {
        const all = [...errorSpy.mock.calls, ...warnSpy.mock.calls]
          .map((c: unknown[]) => c.map(String).join(' '))
          .join('\n');
        expect(all).toMatch(/quota exceeded/i);
        expect(all).toMatch(/900 B.*1000 B|usage.*900.*quota.*1000/i);
      });
      expect(estimate).toHaveBeenCalled();
    } finally {
      delete (navigator as unknown as { storage?: unknown }).storage;
    }
  });

  it('never lets a throwing storage.estimate break the failure path', async () => {
    installMockFetch(async () => new Response(body(10)));
    const cache = await caches.open('temp-v1');
    vi.spyOn(cache, 'put').mockRejectedValue(
      new DOMException('full', 'QuotaExceededError'),
    );
    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: () => {
          throw new Error('nope');
        },
      },
      configurable: true,
    });
    try {
      await expect(
        precacheResources('temp-v1', core(10), [ResourceCategory.Core]),
      ).rejects.toThrow(/Precache failed/);
    } finally {
      delete (navigator as unknown as { storage?: unknown }).storage;
    }
  });
});

describe('lazyCacheResponse — audit #30', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caches only status 200', async () => {
    for (const status of [203, 204, 206]) {
      const response = new Response(status === 204 ? null : 'x', { status });
      await lazyCacheResponse('content-v1', new Request(`f${status}.js`), response);
      expect(await mockCaches.peek('content-v1')?.match(`f${status}.js`)).toBeUndefined();
    }
  });

  it('does not store a body whose size differs from the manifest', async () => {
    const cache = await caches.open('content-v1');
    consumeOnPut(cache);
    const response = new Response(body(4));
    await expect(
      lazyCacheResponse('content-v1', new Request('logo.png'), response, 30),
    ).rejects.toThrow(/logo\.png.*expected 30 bytes.*received 4/);
    expect(await mockCaches.peek('content-v1')!.match('logo.png')).toBeUndefined();
    // The page's copy is untouched.
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  });

  it('stores a body whose size matches', async () => {
    consumeOnPut(await caches.open('content-v1'));
    await lazyCacheResponse('content-v1', new Request('logo.png'), new Response(body(30)), 30);
    expect(await mockCaches.peek('content-v1')!.match('logo.png')).toBeDefined();
  });
  it('stores an image the host re-encoded, when it declares the new length', async () => {
    // Image optimisation on the host: a smaller file, sent whole. It was
    // cached before the size check existed, and still is.
    consumeOnPut(await caches.open('content-v1'));
    const response = new Response(body(4), { headers: { 'Content-Length': '4' } });
    await lazyCacheResponse('content-v1', new Request('logo.png'), response, 30);
    const stored = await mockCaches.peek('content-v1')!.match('logo.png');
    expect((await stored!.arrayBuffer()).byteLength).toBe(4);
  });
});

describe('cleanupOrphanedTempCaches', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes temp caches of versions not kept, and nothing else', async () => {
    for (const name of [
      'app-temp-v1',
      'app-temp-v2',
      'app-temp-v3',
      'app-temp-v4',
      'app-v1',
      'app-manifest',
      'app2-temp-v1',
      'other-temp-v1',
    ]) {
      await mockCaches.open(name);
    }
    await cleanupOrphanedTempCaches('app', ['v3', 'v4']);
    expect((await mockCaches.keys()).sort()).toEqual(
      ['app-manifest', 'app-temp-v3', 'app-temp-v4', 'app-v1', 'app2-temp-v1', 'other-temp-v1'].sort(),
    );
    expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).toMatch(
      /app-temp-v1.*app-temp-v2|app-temp-v2.*app-temp-v1/,
    );
  });

  it('is silent when there is nothing to remove', async () => {
    await mockCaches.open('app-temp-v3');
    await cleanupOrphanedTempCaches('app', ['v3']);
    expect(await mockCaches.keys()).toEqual(['app-temp-v3']);
    expect(console.log).not.toHaveBeenCalled();
  });
});
