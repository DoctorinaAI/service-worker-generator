/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../fetch-handler';
import { createProgressReporter, type ProgressReporter } from '../progress';
import { notifyClients } from '../notify';
import type { ResourceManifest, SWProgressMessage } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';
import { BODY_STALL_TIMEOUT_MS } from '../../shared/constants';
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

const mockedNotify = vi.mocked(notifyClients);

const ORIGIN = self.location.origin;

interface FakeFetchEvent {
  request: Request;
  preloadResponse: Promise<Response | undefined>;
  respondWith: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  _responded?: Promise<Response>;
  /** Resolves once the response and every `waitUntil` promise settle. */
  _settled: () => Promise<void>;
}

function makeEvent(
  url: string,
  options: {
    method?: string;
    mode?: RequestMode;
    preload?: Response;
    headers?: Record<string, string>;
  } = {},
): FakeFetchEvent {
  // Build an underlying Request without the mode option (undici rejects
  // mode: 'navigate'), then overlay mode as a plain property.
  const baseInit: RequestInit = {};
  if (options.method) baseInit.method = options.method;
  if (options.headers) baseInit.headers = options.headers;
  const baseRequest = new Request(url, baseInit);
  const requestLike = new Proxy(baseRequest, {
    get(target, prop) {
      if (prop === 'mode' && options.mode) return options.mode;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const extended: Promise<unknown>[] = [];
  const event: FakeFetchEvent = {
    request: requestLike as Request,
    preloadResponse: Promise.resolve(options.preload),
    respondWith: vi.fn((promise: Response | Promise<Response>) => {
      event._responded = Promise.resolve(promise);
    }),
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      extended.push(promise);
    }),
    _settled: async () => {
      await event._responded;
      // A write may be registered only once the response is ready.
      for (let i = 0; i < extended.length; i++) await extended[i];
    },
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

/** Reporter over the same manifest the handler is given. */
function progress(): ProgressReporter {
  return createProgressReporter('v1', manifest());
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
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores cross-origin requests', () => {
    const event = makeEvent('https://other.example/lib.js');
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores unknown resources that are not index.html or navigation', () => {
    const event = makeEvent(`${ORIGIN}/does-not-exist.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores files in NEVER_CACHE_FILES (bootstrap.js)', () => {
    const event = makeEvent(`${ORIGIN}/bootstrap.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores files in NEVER_CACHE_FILES (sw.js)', () => {
    const event = makeEvent(`${ORIGIN}/sw.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('ignores Ignore-category entries', () => {
    const event = makeEvent(`${ORIGIN}/bg.png`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('uses cacheFirst for Core manifest entries', async () => {
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('main.dart.js'), textResponse('cached-core'));
    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).toHaveBeenCalledOnce();
    const response = await event._responded!;
    expect(await response.text()).toBe('cached-core');
  });

  it('serves a file whose name has a space from the cache', async () => {
    // The manifest is keyed by the name on disk; the request URL carries
    // it percent-encoded.
    const spaced: ResourceManifest = {
      ...manifest(),
      'assets/my photo.png': {
        name: 'assets/my photo.png',
        size: 30,
        hash: 'h-photo',
        category: ResourceCategory.Required,
      },
    };
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('assets/my photo.png'), textResponse('cached-photo'));
    const event = makeEvent(`${ORIGIN}/assets/my%20photo.png`);
    handleFetch(
      event as unknown as FetchEvent,
      spaced,
      'app',
      'v1',
      createProgressReporter('v1', spaced),
    );
    expect(event.respondWith).toHaveBeenCalledOnce();
    expect(await (await event._responded!).text()).toBe('cached-photo');
  });

  it('routes index.html through networkFirst', async () => {
    installMockFetch(async () => textResponse('<html>fresh-index</html>'));
    await mockCaches.open('app-v1');
    const event = makeEvent(`${ORIGIN}/index.html`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).toHaveBeenCalledOnce();
    const response = await event._responded!;
    expect(await response.text()).toBe('<html>fresh-index</html>');
  });

  it('routes root "/" through networkFirst (it maps to index.html)', async () => {
    installMockFetch(async () => textResponse('<html>root</html>'));
    await mockCaches.open('app-v1');
    const event = makeEvent(`${ORIGIN}/`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).toHaveBeenCalledOnce();
    const response = await event._responded!;
    expect(await response.text()).toBe('<html>root</html>');
  });

  it('routes navigate mode on a manifest entry through networkFirst', async () => {
    installMockFetch(async () => textResponse('net'));
    await mockCaches.open('app-v1');
    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
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

  it('returns the network response when it is ok', async () => {
    installMockFetch(async () => textResponse('<html>fresh</html>'));
    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>fresh</html>');
  });

  it('refreshes the shell from a request for the shell', async () => {
    installMockFetch(async () => textResponse('<html>fresh-shell</html>'));
    const event = makeEvent(`${ORIGIN}/`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    await event._settled();

    // Stored under the canonical shell key so a pre-cached `index.html`
    // and a cached navigation are the same entry.
    const cache = mockCaches.peek('app-v1');
    const stored = await cache!.match(new Request('index.html'));
    expect(await stored!.text()).toBe('<html>fresh-shell</html>');
  });

  it('does not refresh the shell from a navigation that is not the shell', async () => {
    installMockFetch(async () => textResponse('<html>some other page</html>'));
    await mockCaches.open('app-v1');
    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    await event._responded!;

    const cache = mockCaches.peek('app-v1');
    expect(await cache!.match(new Request('index.html'))).toBeUndefined();
  });

  it('prefers navigationPreload response when provided', async () => {
    const fetchSpy = installMockFetch(async () => textResponse('fallthrough-fetch'));
    const event = makeEvent(`${ORIGIN}/main.dart.js`, {
      mode: 'navigate',
      preload: textResponse('preloaded'),
    });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(await response.text()).toBe('preloaded');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to cache when the network throws', async () => {
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('index.html'), textResponse('cached-fallback'));
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(await response.text()).toBe('cached-fallback');
  });

  it('falls back to cache on 5xx rather than caching the broken response', async () => {
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('index.html'), textResponse('good-cache'));
    installMockFetch(async () => textResponse('bad-gateway', 502));

    const event = makeEvent(`${ORIGIN}/main.dart.js`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(await response.text()).toBe('good-cache');

    const stored = await cache.match(new Request('index.html'));
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
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
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
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(await response.text()).toBe('from-cache');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches and caches on cache miss for Core/Required', async () => {
    installMockFetch(async () => textResponse('fetched-core'));
    const cache = await mockCaches.open('app-v1');

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
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
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
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
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(response.status).toBe(503);
  });

  it('does not cache non-ok fetch responses on cache miss', async () => {
    installMockFetch(async () => textResponse('nope', 404));
    const cache = await mockCaches.open('app-v1');

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(response.status).toBe(404);
    expect(await cache.match(new Request('main.dart.js'))).toBeUndefined();
  });

  it('emits an error progress event when the fetch returns a non-ok status', async () => {
    mockedNotify.mockClear();
    installMockFetch(async () => textResponse('bad', 500));
    await mockCaches.open('app-v1');

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    await event._responded!;

    const errorCall = mockedNotify.mock.calls.find(
      ([, msg]) =>
        (msg as { status?: string; resourceKey?: string }).status === 'error' &&
        (msg as { resourceKey?: string }).resourceKey === 'main.dart.js',
    );
    expect(errorCall).toBeDefined();
    expect((errorCall![1] as { error?: string }).error).toMatch(/HTTP 500/);
  });
});

describe('handleFetch — progress set membership', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
    mockedNotify.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every `counted` flag reported for `key`, in order. */
  function countedFlagsFor(key: string): boolean[] {
    return mockedNotify.mock.calls
      .map((call) => call[1] as SWProgressMessage)
      .filter((msg) => msg.resourceKey === key)
      .map((msg) => msg.counted);
  }

  it('marks pre-cached resources as counted when served from cache', async () => {
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('main.dart.js'), textResponse('cached'));
    installMockFetch(async () => textResponse('net'));

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    await event._responded!;

    expect(countedFlagsFor('main.dart.js')).toEqual([true]);
  });

  it('marks lazily-cached resources as not counted', async () => {
    installMockFetch(async () => textResponse('png-bytes'));

    const event = makeEvent(`${ORIGIN}/logo.png`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    await event._responded!;

    // `loading` then `completed` — an Optional resource is reported so the
    // UI can name it, but it is outside the denominator.
    expect(countedFlagsFor('logo.png')).toEqual([false, false]);
  });

  it('serves a navigation from the pre-cached shell while offline', async () => {
    // What install-time precache leaves behind: the shell under its
    // manifest key, not under the URL the browser will navigate to.
    const cache = await mockCaches.open('app-v1');
    await cache.put(new Request('index.html'), textResponse('<html>shell</html>'));
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);

    const event = makeEvent(`${ORIGIN}/some/deep/route`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    expect(await response.text()).toBe('<html>shell</html>');
    expect(countedFlagsFor('index.html')).toEqual([true]);
  });
});

describe('handleFetch — unusable CacheStorage', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves a cache-first resource from the network when the cache cannot be opened', async () => {
    // Evicted storage or a privacy mode: the app's own files must still load.
    installMockFetch(async () => textResponse('from-network'));
    vi.spyOn(caches, 'open').mockRejectedValue(new Error('SecurityError'));

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('from-network');
    // No write is attempted into a cache that could not be read.
    expect(caches.open).toHaveBeenCalledOnce();
  });

  it('still returns the network response when the lazy cache write fails', async () => {
    installMockFetch(async () => textResponse('fetched-core'));
    const cache = await mockCaches.open('app-v1');
    vi.spyOn(cache, 'put').mockRejectedValue(new Error('QuotaExceededError'));

    const event = makeEvent(`${ORIGIN}/main.dart.js`);
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fetched-core');
  });

  it('answers 503 for an offline navigation when the shell cache cannot be opened', async () => {
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => origSetTimeout(fn, 0)) as unknown as typeof setTimeout);
    vi.spyOn(caches, 'open').mockRejectedValue(new Error('SecurityError'));

    const event = makeEvent(`${ORIGIN}/some/route`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Offline');
  });
});

describe('handleFetch — audit #30', () => {
  let mockCaches: MockCacheStorage;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCaches = installMockCaches();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bytes = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(2);

  /** Make put read the body fully, like the real Cache API. */
  function consumeOnPut(cache: Cache): void {
    const original = cache.put.bind(cache);
    vi.spyOn(cache, 'put').mockImplementation(async (req, response) => {
      const r = response as Response;
      const buf = await r.arrayBuffer();
      await original(req, new Response(buf, { status: r.status, headers: r.headers }));
    });
  }

  function instantTimers(): void {
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
      origSetTimeout(fn, 0)) as unknown as typeof setTimeout);
  }

  describe('Range requests', () => {
    it('passes a Range request straight to the network, even for a cached entry', async () => {
      const cache = await mockCaches.open('app-v1');
      await cache.put(new Request('logo.png'), textResponse('cached'));
      const event = makeEvent(`${ORIGIN}/logo.png`, { headers: { Range: 'bytes=0-0' } });
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      expect(event.respondWith).not.toHaveBeenCalled();
    });

    it('passes a Range request for a Core entry through as well', () => {
      const event = makeEvent(`${ORIGIN}/main.dart.js`, { headers: { range: 'bytes=10-' } });
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      expect(event.respondWith).not.toHaveBeenCalled();
    });

    it('does not store a 206 that reaches the cache-first path', async () => {
      installMockFetch(async () => new Response('x', { status: 206 }));
      const cache = await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/logo.png`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      const response = await event._responded!;
      expect(response.status).toBe(206);
      expect(await cache.match(new Request('logo.png'))).toBeUndefined();
    });
  });

  describe('lazy size check', () => {
    it('does not store a truncated body, but still serves it', async () => {
      installMockFetch(async () => new Response(bytes(7)));
      const cache = await mockCaches.open('app-v1');
      consumeOnPut(cache);
      const event = makeEvent(`${ORIGIN}/logo.png`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      const response = await event._responded!;
      await event._settled();
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(7);
      expect(await cache.match(new Request('logo.png'))).toBeUndefined();
      expect(warnSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n')).toMatch(
        /logo\.png.*expected 30 bytes.*received 7/,
      );
    });

    it('stores a body of the right size', async () => {
      installMockFetch(async () => new Response(bytes(30)));
      const cache = await mockCaches.open('app-v1');
      consumeOnPut(cache);
      const event = makeEvent(`${ORIGIN}/logo.png`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      const response = await event._responded!;
      await event._settled();
      expect((await response.arrayBuffer()).byteLength).toBe(30);
      expect(await cache.match(new Request('logo.png'))).toBeDefined();
    });
  });

  describe('background cache write', () => {
    /** A 200 that sends a few bytes and then nothing, ever. */
    const stalled = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes(10));
          },
        }),
      );

    afterEach(() => {
      vi.useRealTimers();
    });

    it('answers a Core refill without waiting for the cache write', async () => {
      // An evicted main.dart.js refilled from a stream that stalls. Awaiting
      // the write before answering held the request until the browser gave
      // up; the page must get its response with the headers.
      vi.useFakeTimers();
      installMockFetch(async () => stalled());
      consumeOnPut(await mockCaches.open('app-v1'));
      const event = makeEvent(`${ORIGIN}/main.dart.js`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      let answered: Response | undefined;
      void event._responded!.then((r) => {
        answered = r;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(answered?.status).toBe(200);
      expect(event.waitUntil).toHaveBeenCalledOnce();

      // The write itself is cut off by the stall watchdog and stores nothing.
      const settled = event._settled();
      await vi.advanceTimersByTimeAsync(BODY_STALL_TIMEOUT_MS + 1);
      await settled;
      expect(await (await caches.open('app-v1')).match(new Request('main.dart.js'))).toBeUndefined();
      expect(warnSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n')).toMatch(
        /Cache write failed for main\.dart\.js.*stalled/,
      );
    });

    it('answers a shell navigation without waiting for the cache write', async () => {
      vi.useFakeTimers();
      installMockFetch(async () => stalled());
      consumeOnPut(await mockCaches.open('app-v1'));
      const event = makeEvent(`${ORIGIN}/`, { mode: 'navigate' });
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      let answered: Response | undefined;
      void event._responded!.then((r) => {
        answered = r;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(answered?.status).toBe(200);

      const settled = event._settled();
      await vi.advanceTimersByTimeAsync(BODY_STALL_TIMEOUT_MS + 1);
      await expect(settled).resolves.toBeUndefined();
    });
  });

  describe('quota diagnostics', () => {
    it('logs a quota error on the lazy write distinctly and still serves', async () => {
      installMockFetch(async () => new Response(bytes(30)));
      const cache = await mockCaches.open('app-v1');
      vi.spyOn(cache, 'put').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
      const event = makeEvent(`${ORIGIN}/logo.png`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      const response = await event._responded!;
      await event._settled();
      expect(response.status).toBe(200);
      expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
        /quota exceeded.*logo\.png/i,
      );
    });

    it('logs a quota error on the shell write distinctly', async () => {
      installMockFetch(async () => textResponse('<html></html>'));
      const cache = await mockCaches.open('app-v1');
      vi.spyOn(cache, 'put').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
      const event = makeEvent(`${ORIGIN}/`, { mode: 'navigate' });
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      const response = await event._responded!;
      await event._settled();
      expect(await response.text()).toBe('<html></html>');
      expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
        /quota exceeded.*index\.html/i,
      );
    });
  });

  describe('lazy refill of Core/Required', () => {
    it('refills a Core entry with the hash-busted URL and cache: reload', async () => {
      const spy = installMockFetch(async () => new Response(bytes(100)));
      await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/main.dart.js`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      await event._responded!;
      expect(spy).toHaveBeenCalledOnce();
      const sent = spy.mock.calls[0]![0] as Request;
      expect(sent.url).toBe(`${ORIGIN}/main.dart.js?v=h-main`);
      expect(sent.cache).toBe('reload');
    });

    it('refills a Required entry the same way', async () => {
      const spy = installMockFetch(async () => new Response(bytes(50)));
      await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/AssetManifest.json`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      await event._responded!;
      const sent = spy.mock.calls[0]![0] as Request;
      expect(sent.url).toBe(`${ORIGIN}/AssetManifest.json?v=h-am`);
      expect(sent.cache).toBe('reload');
    });

    it('keeps the query string the page sent', async () => {
      const spy = installMockFetch(async () => new Response(bytes(100)));
      await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/main.dart.js?token=abc`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      await event._responded!;
      const sent = spy.mock.calls[0]![0] as Request;
      expect(sent.url).toBe(`${ORIGIN}/main.dart.js?token=abc&v=h-main`);
    });

    it('fetches Optional entries with the page request, as before', async () => {
      const spy = installMockFetch(async () => new Response(bytes(30)));
      await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/logo.png`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      await event._responded!;
      const sent = spy.mock.calls[0]![0] as Request;
      expect(sent.url).toBe(`${ORIGIN}/logo.png`);
    });

    it('falls back to the page request when the busted URL is refused', async () => {
      const spy = installMockFetch(async (req) =>
        req.url.includes('v=') ? textResponse('forbidden', 403) : new Response(bytes(100)),
      );
      await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/main.dart.js`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      const response = await event._responded!;
      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
      expect((spy.mock.calls[1]![0] as Request).url).toBe(`${ORIGIN}/main.dart.js`);
    });

    it('falls back to one plain attempt when the busted fetch throws', async () => {
      instantTimers();
      const spy = installMockFetch(async (req) => {
        if (req.url.includes('v=')) throw new TypeError('Failed to fetch');
        return new Response(bytes(100));
      });
      await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/main.dart.js`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      const response = await event._responded!;
      expect(response.status).toBe(200);
      // Three busted attempts (the existing retry budget), then one plain.
      expect(spy).toHaveBeenCalledTimes(4);
    });

    it('answers 503 offline after the fallback attempt also fails', async () => {
      instantTimers();
      installMockFetch(async () => {
        throw new TypeError('Failed to fetch');
      });
      await mockCaches.open('app-v1');
      const event = makeEvent(`${ORIGIN}/main.dart.js`);
      handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
      expect((await event._responded!).status).toBe(503);
    });
  });
});
