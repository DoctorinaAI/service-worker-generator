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
} from '../cache-manager';
import type { ResourceManifest } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';
import {
  installMockCaches,
  installMockFetch,
  textResponse,
  type MockCacheStorage,
} from '../../__tests__/helpers';

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

    const calls = fetchSpy.mock.calls.map((c) => (c[0] as Request).url);
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

  it('throws aggregated error when any Core resource fails', async () => {
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
    const urls = fetchSpy.mock.calls.map((c) => (c[0] as Request).url);
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
    // Regression: the previous eviction pass ran AFTER the temp→content
    // copy, so a hash-changed entry that had just been re-precached was
    // incorrectly deleted. The fix reorders so eviction runs first.
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

  it('does nothing when no matching caches exist', async () => {
    const mockCaches2 = installMockCaches();
    await mockCaches2.open('other-thing');
    await cleanupOldCaches('app', 'v1');
    const keys = await mockCaches2.keys();
    expect(keys).toEqual(['other-thing']);
  });
});
