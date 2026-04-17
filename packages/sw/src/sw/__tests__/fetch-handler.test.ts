/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../fetch-handler';
import type { ResourceManifest } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';
import {
  installMockCaches,
  installMockFetch,
  textResponse,
  type MockCacheStorage,
} from '../../__tests__/helpers';

// Silence the module that posts to clients — we'll assert on the mock.
vi.mock('../notify', () => ({
  notifyClients: vi.fn(async () => undefined),
}));

const ORIGIN = self.location.origin;

interface FakeFetchEvent {
  request: Request;
  preloadResponse: Promise<Response | undefined>;
  respondWith: ReturnType<typeof vi.fn>;
  _responded?: Promise<Response>;
}

function makeEvent(
  url: string,
  options: { method?: string; mode?: RequestMode; preload?: Response } = {},
): FakeFetchEvent {
  // Build an underlying Request without the mode option (undici rejects
  // mode: 'navigate'), then overlay mode as a plain property.
  const baseInit: RequestInit = {};
  if (options.method) baseInit.method = options.method;
  const baseRequest = new Request(url, baseInit);
  const requestLike = new Proxy(baseRequest, {
    get(target, prop) {
      if (prop === 'mode' && options.mode) return options.mode;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const event: FakeFetchEvent = {
    request: requestLike as Request,
    preloadResponse: Promise.resolve(options.preload),
    respondWith: vi.fn((promise: Response | Promise<Response>) => {
      event._responded = Promise.resolve(promise);
    }),
  };
  return event;
}

function manifest(): ResourceManifest {
  return {
    'main.dart.js': {
      name: 'main.dart.js',
      size: 100,
      hash: 'h-main',
      category: ResourceCategory.Core,
    },
    'AssetManifest.json': {
      name: 'AssetManifest.json',
      size: 50,
      hash: 'h-am',
      category: ResourceCategory.Required,
    },
    'logo.png': {
      name: 'logo.png',
      size: 30,
      hash: 'h-logo',
      category: ResourceCategory.Optional,
    },
    'index.html': {
      name: 'index.html',
      size: 200,
      hash: 'h-index',
      category: ResourceCategory.Required,
    },
    'bg.png': {
      name: 'bg.png',
      size: 30,
      hash: 'h-bg',
      category: ResourceCategory.Ignore,
    },
  };
}

describe('handleFetch — routing', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
    installMockFetch(async () => textResponse('fresh'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores non-GET requests', () => {
    const event = makeEvent(`${ORIGIN}/main.dart.js`, { method: 'POST' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores cross-origin requests', () => {
    const event = makeEvent('https://other.example/lib.js');
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores unknown resources that are not index.html or navigation', () => {
    const event = makeEvent(`${ORIGIN}/does-not-exist.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores files in NEVER_CACHE_FILES (bootstrap.js)', () => {
    const event = makeEvent(`${ORIGIN}/bootstrap.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores files in NEVER_CACHE_FILES (sw.js)', () => {
    const event = makeEvent(`${ORIGIN}/sw.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores Ignore-category entries', () => {
    const event = makeEvent(`${ORIGIN}/bg.png`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('uses cacheFirst for Core manifest entries', async () => {
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('main.dart.js'), textResponse('cached-core'));
    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).toHaveBeenCalledOnce();
    const response = await event._responded!;
    expect(await response.text()).toBe('cached-core');
  });

  it('routes index.html through networkFirst', async () => {
    installMockFetch(async () => textResponse('<html>fresh-index</html>'));
    await mockCaches.open('app-v1');
    const event = makeEvent(`${ORIGIN}/index.html`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).toHaveBeenCalledOnce();
    const response = await event._responded!;
    expect(await response.text()).toBe('<html>fresh-index</html>');
  });

  it('routes root "/" through networkFirst (it maps to index.html)', async () => {
    installMockFetch(async () => textResponse('<html>root</html>'));
    await mockCaches.open('app-v1');
    const event = makeEvent(`${ORIGIN}/`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).toHaveBeenCalledOnce();
    const response = await event._responded!;
    expect(await response.text()).toBe('<html>root</html>');
  });

  it('routes navigate mode on a manifest entry through networkFirst', async () => {
    installMockFetch(async () => textResponse('net'));
    await mockCaches.open('app-v1');
    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    expect(event.respondWith).toHaveBeenCalledOnce();
    const response = await event._responded!;
    expect(await response.text()).toBe('net');
  });
});

describe('networkFirst (via handleFetch navigate)', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the network response when it is ok and caches it', async () => {
    installMockFetch(async () => textResponse('<html>fresh</html>'));
    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>fresh</html>');

    const cache = mockCaches.peek('app-v1');
    const stored = await cache!.match(event.request);
    expect(stored).toBeDefined();
  });

  it('prefers navigationPreload response when provided', async () => {
    const fetchSpy = installMockFetch(async () => textResponse('fallthrough-fetch'));
    const event = makeEvent(`${ORIGIN}/main.dart.js`, {
      mode: 'navigate',
      preload: textResponse('preloaded'),
    });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(await response.text()).toBe('preloaded');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to cache when the network throws', async () => {
    const cache = await mockCaches.open('app-v1');
    await cache.put(
      new Request(`${ORIGIN}/main.dart.js`),
      textResponse('cached-fallback'),
    );
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(await response.text()).toBe('cached-fallback');
  });

  it('falls back to cache on 5xx rather than caching the broken response', async () => {
    const cache = await mockCaches.open('app-v1');
    await cache.put(
      new Request(`${ORIGIN}/main.dart.js`),
      textResponse('good-cache'),
    );
    installMockFetch(async () => textResponse('bad-gateway', 502));

    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(await response.text()).toBe('good-cache');

    const stored = await cache.match(new Request(`${ORIGIN}/main.dart.js`));
    expect(await stored!.text()).toBe('good-cache');
  });

  it('returns a 503 response when neither network nor cache has the page', async () => {
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(response.status).toBe(503);
  });
});

describe('cacheFirst (via handleFetch for Core/Required/Optional)', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cache hit without calling the network', async () => {
    const fetchSpy = installMockFetch(async () => textResponse('from-network'));
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('main.dart.js'), textResponse('from-cache'));

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(await response.text()).toBe('from-cache');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches and caches on cache miss for Core/Required', async () => {
    installMockFetch(async () => textResponse('fetched-core'));
    const cache = await mockCaches.open('app-v1');

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(await response.text()).toBe('fetched-core');

    // Self-heals: cache now has the entry.
    const stored = await cache.match(new Request('main.dart.js'));
    expect(stored).toBeDefined();
  });

  it('fetches and caches Optional entries on first miss', async () => {
    installMockFetch(async () => textResponse('lazy-logo'));
    const cache = await mockCaches.open('app-v1');

    const event = makeEvent(`${ORIGIN}/logo.png`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(await response.text()).toBe('lazy-logo');
    expect(await cache.match(new Request('logo.png'))).toBeDefined();
  });

  it('returns 503 when fetch rejects on a cache miss', async () => {
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);
    await mockCaches.open('app-v1');

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(response.status).toBe(503);
  });

  it('does not cache non-ok fetch responses on cache miss', async () => {
    installMockFetch(async () => textResponse('nope', 404));
    const cache = await mockCaches.open('app-v1');

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', 0, 0);
    const response = await event._responded!;
    expect(response.status).toBe(404);
    expect(await cache.match(new Request('main.dart.js'))).toBeUndefined();
  });
});
