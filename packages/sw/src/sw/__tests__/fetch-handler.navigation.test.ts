/**
 * @vitest-environment jsdom
 *
 * Navigation handling is the one path where a service-worker mistake is
 * unrecoverable from the page: whatever the SW answers a navigation with
 * *is* the document. These tests pin the invariants that keep the app
 * shell in the cache the app shell.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../fetch-handler';
import { precacheResources } from '../cache-manager';
import { createProgressReporter, COUNTED_CATEGORIES, type ProgressReporter } from '../progress';
import type { ResourceManifest } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';
import {
  installMockCaches,
  installMockFetch,
  textResponse,
  type MockCacheStorage,
} from '../../__tests__/helpers';

vi.mock('../notify', () => ({
  notifyClients: vi.fn(async () => undefined),
}));

const ORIGIN = self.location.origin;
const CONTENT_CACHE = 'app-v1';

const SHELL = '<html><body><script data-sw-bootstrap src="bootstrap.js"></script></body></html>';
/** What Firebase Hosting serves at `/__/auth/**` — same origin, not the shell. */
const AUTH_PAGE = '<html><head><title>firebase auth</title></head></html>';

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
    'index.html': {
      name: 'index.html',
      size: 200,
      hash: 'h-index',
      category: ResourceCategory.Required,
    },
    'logo.png': {
      name: 'logo.png',
      size: 30,
      hash: 'h-logo',
      category: ResourceCategory.Optional,
    },
  };
}

function progress(): ProgressReporter {
  return createProgressReporter('v1', manifest());
}

/** The bytes currently stored under the canonical shell key. */
async function shellInCache(caches: MockCacheStorage): Promise<string | null> {
  const cache = caches.peek(CONTENT_CACHE);
  const hit = await cache?.match(new Request('index.html'));
  return hit ? await hit.text() : null;
}

/** Make retries instant so offline paths don't burn the test timeout. */
function fastRetries(): void {
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
    realSetTimeout(fn, 0)) as unknown as typeof setTimeout);
}

describe('navigation handling — app-shell integrity', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(async () => {
    mockCaches = installMockCaches();
    const cache = await mockCaches.open(CONTENT_CACHE);
    await cache.put(new Request('index.html'), textResponse(SHELL));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    '/__/auth/handler?providerId=google.com',
    '/__/auth/iframe?apiKey=abc',
  ])('leaves the host-reserved navigation %s alone', (path) => {
    // Firebase Hosting serves `/__/*` itself and excludes it from the SPA
    // rewrite; Firebase Auth puts its handler and its iframe there when
    // `authDomain` is the app's own domain. Answering those from the app's
    // cache — or running them through `fetchWithRetry`, which downgrades a
    // navigation request's mode — breaks sign-in.
    installMockFetch(async () => textResponse(AUTH_PAGE));

    const event = makeEvent(`${ORIGIN}${path}`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());

    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('keeps the cached shell when a same-origin non-shell page is navigated to', async () => {
    // Any page the host serves outside the SPA — a static privacy page, a
    // download, an OAuth callback. The response is not the app shell.
    installMockFetch(async () => textResponse(AUTH_PAGE));

    const event = makeEvent(`${ORIGIN}/legal/privacy.html`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    // The page itself must still get its real response...
    expect(await response.text()).toBe(AUTH_PAGE);
    // ...but the shell slot must be untouched.
    expect(await shellInCache(mockCaches)).toBe(SHELL);
  });

  it('still boots offline after such a navigation', async () => {
    installMockFetch(async () => textResponse(AUTH_PAGE));
    const poison = makeEvent(`${ORIGIN}/legal/privacy.html`, { mode: 'navigate' });
    handleFetch(poison as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    await poison._responded!;

    fastRetries();
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const boot = makeEvent(`${ORIGIN}/`, { mode: 'navigate' });
    handleFetch(boot as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await boot._responded!;

    expect(await response.text()).toBe(SHELL);
  });

  it('does not store a redirected response as the shell', async () => {
    // A navigation response that followed a redirect cannot be replayed for
    // a later navigation: the browser rejects `respondWith` with a redirected
    // response when the request's redirect mode is not "follow".
    const redirected = new Proxy(textResponse('<html>elsewhere</html>'), {
      get(target, prop) {
        if (prop === 'redirected') return true;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    installMockFetch(async () => redirected);

    const event = makeEvent(`${ORIGIN}/`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    await event._responded!;

    expect(await shellInCache(mockCaches)).toBe(SHELL);
  });

  it('returns the fresh page even when the shell cache write fails', async () => {
    // Quota pressure is routine on a wasm-sized app. A failed cache write
    // must not turn a healthy 200 into the offline fallback.
    installMockFetch(async () => textResponse('<html>fresh</html>'));
    const cache = await mockCaches.open(CONTENT_CACHE);
    vi.spyOn(cache, 'put').mockRejectedValue(
      new DOMException('quota', 'QuotaExceededError'),
    );

    const event = makeEvent(`${ORIGIN}/`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>fresh</html>');
  });

  it('does not serve "Offline" while online when the cache write fails', async () => {
    // The same failure on a cold profile: nothing cached to fall back to,
    // so a 200 from the origin becomes a 503 text/plain page and the app
    // never boots — while the network is fine.
    const empty = installMockCaches();
    await empty.open(CONTENT_CACHE);
    installMockFetch(async () => textResponse('<html>fresh</html>'));
    const cache = await empty.open(CONTENT_CACHE);
    vi.spyOn(cache, 'put').mockRejectedValue(
      new DOMException('quota', 'QuotaExceededError'),
    );

    const event = makeEvent(`${ORIGIN}/`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    expect(response.status).toBe(200);
  });

  it('leaves cross-origin navigations to the browser', () => {
    const event = makeEvent('https://accounts.google.com/o/oauth2/auth', {
      mode: 'navigate',
    });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('serves a deep route with a query string from the shell while offline', async () => {
    fastRetries();
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const event = makeEvent(`${ORIGIN}/chat/42?ref=push#frag`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;
    expect(await response.text()).toBe(SHELL);
  });
});

describe('precache ↔ fetch-handler cache keys', () => {
  let mockCaches: MockCacheStorage;

  beforeEach(() => {
    mockCaches = installMockCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers an offline navigation from what precache actually wrote', async () => {
    // End-to-end on the key contract: install writes the shell, the fetch
    // handler reads it back. A key mismatch between the two is exactly the
    // failure this PR set out to fix, and nothing else in the suite runs
    // both halves against the same cache.
    installMockFetch(async (request) =>
      request.url.includes('index.html') ? textResponse(SHELL) : textResponse('x'),
    );
    await precacheResources(CONTENT_CACHE, manifest(), COUNTED_CATEGORIES);

    fastRetries();
    installMockFetch(async () => {
      throw new Error('offline');
    });
    const event = makeEvent(`${ORIGIN}/deep/route`, { mode: 'navigate' });
    handleFetch(event as unknown as FetchEvent, manifest(), 'app', 'v1', progress());
    const response = await event._responded!;

    expect(await response.text()).toBe(SHELL);
  });

  it('pre-caches exactly the set the reporter counts', async () => {
    // The claim the PR rests on: "what is pre-cached" and "what is counted"
    // cannot drift apart. Assert it against the real precache, not the list.
    const fetched: string[] = [];
    installMockFetch(async (request) => {
      fetched.push(new URL(request.url).pathname.replace(/^\//, '').split('?')[0]!);
      return textResponse('bytes');
    });
    await precacheResources(CONTENT_CACHE, manifest(), COUNTED_CATEGORIES);

    const reporter = progress();
    const counted = Object.keys(manifest()).filter((k) => reporter.isCounted(k));
    expect(fetched.sort()).toEqual(counted.sort());
    expect(reporter.resourcesCount).toBe(counted.length);
  });
});
