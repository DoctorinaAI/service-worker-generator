/**
 * Shared test helpers for mocking the Cache API, fetch, and
 * ServiceWorkerGlobalScope (`self`).
 */
import { vi } from 'vitest';

/**
 * Node's global Request requires an absolute URL. The SW source code passes
 * relative paths like `new Request('main.dart.js')` because at runtime
 * `self.location` provides a base URL. Patch the global once so tests can
 * mirror that behavior.
 */
const TEST_BASE_URL = (() => {
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (loc?.origin) return loc.origin.endsWith('/') ? loc.origin : `${loc.origin}/`;
  } catch {
    // Fall through to default
  }
  return 'http://localhost/';
})();
const OriginalRequest = globalThis.Request;
if (OriginalRequest && !(globalThis as { __swRequestPatched?: boolean }).__swRequestPatched) {
  const PatchedRequest = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    if (typeof input === 'string') {
      try {
        return new OriginalRequest(input, init);
      } catch {
        return new OriginalRequest(new URL(input, TEST_BASE_URL), init);
      }
    }
    return new OriginalRequest(input as Request, init);
  } as unknown as typeof Request;
  PatchedRequest.prototype = OriginalRequest.prototype;
  (globalThis as { Request: typeof Request }).Request = PatchedRequest;
  (globalThis as { __swRequestPatched?: boolean }).__swRequestPatched = true;
}

/**
 * In-memory Cache implementation backed by a Map keyed by request URL.
 * Implements the subset of the Cache interface used by the SW code.
 */
export class MockCache implements Cache {
  private store = new Map<string, Response>();

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.store.set(toKey(request), response.clone());
  }

  async match(
    request: RequestInfo | URL,
    _opts?: CacheQueryOptions,
  ): Promise<Response | undefined> {
    const hit = this.store.get(toKey(request));
    return hit ? hit.clone() : undefined;
  }

  async matchAll(
    request?: RequestInfo | URL,
    _opts?: CacheQueryOptions,
  ): Promise<readonly Response[]> {
    if (request === undefined) {
      return Array.from(this.store.values()).map((r) => r.clone());
    }
    const hit = this.store.get(toKey(request));
    return hit ? [hit.clone()] : [];
  }

  async delete(
    request: RequestInfo | URL,
    _opts?: CacheQueryOptions,
  ): Promise<boolean> {
    return this.store.delete(toKey(request));
  }

  async keys(
    request?: RequestInfo | URL,
    _opts?: CacheQueryOptions,
  ): Promise<readonly Request[]> {
    if (request === undefined) {
      return Array.from(this.store.keys()).map((k) => new Request(k));
    }
    const k = toKey(request);
    return this.store.has(k) ? [new Request(k)] : [];
  }

  async add(_request: RequestInfo | URL): Promise<void> {
    throw new Error('MockCache.add not implemented');
  }

  async addAll(_requests: Iterable<RequestInfo>): Promise<void> {
    throw new Error('MockCache.addAll not implemented');
  }

  /** Test-only convenience: number of entries currently stored. */
  size(): number {
    return this.store.size;
  }
}

/**
 * In-memory CacheStorage backed by a Map of cache name → MockCache.
 */
export class MockCacheStorage implements CacheStorage {
  private caches = new Map<string, MockCache>();

  async open(cacheName: string): Promise<Cache> {
    let cache = this.caches.get(cacheName);
    if (!cache) {
      cache = new MockCache();
      this.caches.set(cacheName, cache);
    }
    return cache;
  }

  async has(cacheName: string): Promise<boolean> {
    return this.caches.has(cacheName);
  }

  async delete(cacheName: string): Promise<boolean> {
    return this.caches.delete(cacheName);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }

  async match(
    request: RequestInfo | URL,
    opts?: MultiCacheQueryOptions,
  ): Promise<Response | undefined> {
    const target = opts?.cacheName;
    if (target) {
      const cache = this.caches.get(target);
      return cache?.match(request);
    }
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Test-only: raw access to a cache by name (or undefined). */
  peek(name: string): MockCache | undefined {
    return this.caches.get(name);
  }

  /** Test-only: clear everything. */
  reset(): void {
    this.caches.clear();
  }
}

/**
 * Install a fresh MockCacheStorage on globalThis.caches and return it.
 * Call inside beforeEach; pair with restoreCaches in afterEach if needed.
 */
export function installMockCaches(): MockCacheStorage {
  const mock = new MockCacheStorage();
  (globalThis as unknown as { caches: CacheStorage }).caches =
    mock as unknown as CacheStorage;
  return mock;
}

/**
 * Mock `fetch` with a routing function: URL → Response (or thrown error).
 * Returns the installed vi mock so tests can assert on calls.
 */
export function installMockFetch(
  handler: (request: Request) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
  return spy;
}

/**
 * Minimal ServiceWorkerGlobalScope stub sufficient for unit tests.
 * Exposes a spy-able `clients.matchAll`, a fake `registration`,
 * `skipWaiting`, and an EventTarget for addEventListener.
 */
export interface MockClient {
  id: string;
  postMessage: ReturnType<typeof vi.fn>;
}

export interface MockSwScope {
  clients: {
    matchAll: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
  };
  registration: {
    navigationPreload: {
      enable: ReturnType<typeof vi.fn>;
    } | null;
  };
  skipWaiting: ReturnType<typeof vi.fn>;
  location: { origin: string };
  addEventListener: ReturnType<typeof vi.fn>;
  /** Test-only: simulated connected clients. */
  _clients: MockClient[];
}

export function createMockSwScope(
  options: {
    origin?: string;
    hasNavigationPreload?: boolean;
    clients?: MockClient[];
  } = {},
): MockSwScope {
  const origin = options.origin ?? 'http://localhost:3000';
  const clients = options.clients ?? [];
  return {
    clients: {
      matchAll: vi.fn(async () => clients),
      claim: vi.fn(async () => undefined),
    },
    registration: {
      navigationPreload: (options.hasNavigationPreload ?? false)
        ? { enable: vi.fn(async () => undefined) }
        : null,
    },
    skipWaiting: vi.fn(async () => undefined),
    location: { origin },
    addEventListener: vi.fn(),
    _clients: clients,
  };
}

export function createMockClient(id = 'c1'): MockClient {
  return { id, postMessage: vi.fn() };
}

/** Build a Response wrapping the given body + status. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a plain-text Response with the given status. */
export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function toKey(request: RequestInfo | URL): string {
  if (typeof request === 'string') return new URL(request, TEST_BASE_URL).href;
  if (request instanceof URL) return request.href;
  return new URL(request.url, TEST_BASE_URL).href;
}
