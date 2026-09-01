import type { ResourceManifest, ResourceEntry } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { NEVER_CACHE_FILES, RESERVED_PATH_PREFIXES } from '../shared/constants';
import { getResourceKey, fetchWithRetry } from '../shared/utils';
import { lazyCacheResponse, getContentCacheName } from './cache-manager';
import type { ProgressReporter } from './progress';

declare const self: ServiceWorkerGlobalScope;

/**
 * Canonical cache key for the app shell.
 *
 * Navigations arrive as `/`, `/index.html` or any SPA route, but the
 * manifest — and therefore the install-time precache — keys the shell as
 * `index.html`. Storing and matching under one key is what lets a
 * navigation be served from the pre-cached copy while offline.
 */
const INDEX_KEY = 'index.html';

/**
 * Handle a fetch event based on manifest and caching strategy.
 */
export function handleFetch(
  event: FetchEvent,
  manifest: ResourceManifest,
  cachePrefix: string,
  version: string,
  progress: ProgressReporter,
): void {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const resourceKey = getResourceKey(request.url);
  const entry = manifest[resourceKey];

  if (NEVER_CACHE_FILES.some((f) => resourceKey === f || resourceKey.endsWith(`/${f}`))) {
    return;
  }

  // Namespaces the host serves itself. Same origin, but not ours.
  if (RESERVED_PATH_PREFIXES.some((prefix) => resourceKey.startsWith(prefix))) {
    return;
  }

  // App-shell path, checked before the manifest lookup: a Flutter route
  // like `/chat/42` is a navigation with no manifest entry of its own, and
  // the host rewrites it to the same `index.html`. Matching on the entry
  // first would drop those navigations on the floor — including offline,
  // where the pre-cached shell is the only thing that can answer them.
  //
  // Only a request *for* the shell may refresh the cached shell. Every
  // other navigation reads that cache but never writes it: a same-origin
  // page outside the SPA answers a navigation with its own HTML, and
  // storing that under the shell key leaves the app unable to boot from
  // cache at all.
  const isShellRequest = resourceKey === INDEX_KEY;
  if (request.mode === 'navigate' || isShellRequest) {
    event.respondWith(
      networkFirst(event, cachePrefix, version, manifest, progress, isShellRequest),
    );
    return;
  }

  if (!entry || entry.category === ResourceCategory.Ignore) return;

  event.respondWith(
    cacheFirst(request, resourceKey, entry, cachePrefix, version, progress),
  );
}

/**
 * Network-first strategy for navigations and `index.html`.
 *
 * Prefers a navigationPreload response if available, then falls through to
 * `fetchWithRetry`. Falls back to the pre-cached app shell on any network
 * error *or* non-ok HTTP response so a broken origin cannot replace a good
 * cached page.
 *
 * Nothing after a successful fetch may reject: this promise is handed to
 * `respondWith`, so a rejection is a failed navigation — a blank error page
 * where the origin had just answered 200.
 */
async function networkFirst(
  event: FetchEvent,
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  progress: ProgressReporter,
  isShellRequest: boolean,
): Promise<Response> {
  const { request } = event;
  const cacheName = getContentCacheName(cachePrefix, version);
  const entry = manifest[INDEX_KEY];

  const notifyIndex = async (status: 'updated' | 'cached'): Promise<void> => {
    if (!entry) return;
    await progress.report({
      key: INDEX_KEY,
      name: INDEX_KEY,
      url: request.url,
      size: entry.size,
      loaded: entry.size,
      status,
    });
  };

  const fallbackToCache = async (): Promise<Response> => {
    try {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(new Request(INDEX_KEY));
      if (cached) {
        await notifyIndex('cached');
        return cached;
      }
    } catch (error) {
      console.warn('[SW] App-shell cache lookup failed:', error);
    }
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  };

  let response: Response;
  try {
    // Prefer navigationPreload if enabled.
    const preload = (await event.preloadResponse) as Response | undefined;
    response = preload ?? (await fetchWithRetry(request));
  } catch {
    return fallbackToCache();
  }

  if (!response.ok) {
    return fallbackToCache();
  }

  // A redirected response cannot be replayed for a later navigation —
  // browsers reject it when the request's redirect mode is not "follow" —
  // so it must never become the cached shell.
  if (isShellRequest && !response.redirected) {
    try {
      const cache = await caches.open(cacheName);
      await cache.put(new Request(INDEX_KEY), response.clone());
    } catch (error) {
      // Quota pressure is routine for a wasm-sized app. A cache we could
      // not write is a worse offline story, not a reason to withhold a
      // page the origin just served.
      console.warn('[SW] App-shell cache write failed:', error);
    }
    await notifyIndex('updated');
  }

  return response;
}

/**
 * Cache-first strategy for cached resources.
 *
 * Looks up the response in the current versioned content cache only. Cache
 * misses populate the cache for any category except `Ignore` so evicted or
 * partially-precached Core/Required resources self-heal.
 */
async function cacheFirst(
  request: Request,
  resourceKey: string,
  entry: ResourceEntry,
  cachePrefix: string,
  version: string,
  progress: ProgressReporter,
): Promise<Response> {
  const cacheName = getContentCacheName(cachePrefix, version);

  // An unusable CacheStorage (evicted, blocked by a privacy mode) must
  // degrade to a plain network fetch. Rejecting here would fail the
  // resource outright, and these are the files the app is made of.
  let cache: Cache | null = null;
  try {
    cache = await caches.open(cacheName);
    const cached = await cache.match(new Request(resourceKey));
    if (cached) {
      await progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: entry.size,
        status: 'cached',
      });
      return cached;
    }
  } catch (error) {
    console.warn(`[SW] Cache lookup failed for ${resourceKey}:`, error);
    cache = null;
  }

  try {
    await progress.report({
      key: resourceKey,
      name: entry.name,
      url: request.url,
      size: entry.size,
      loaded: 0,
      status: 'loading',
    });

    const response = await fetchWithRetry(request);

    if (response.ok) {
      if (cache) {
        try {
          await lazyCacheResponse(cacheName, new Request(resourceKey), response);
        } catch (error) {
          console.warn(`[SW] Cache write failed for ${resourceKey}:`, error);
        }
      }

      await progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: entry.size,
        status: 'completed',
      });
    } else {
      // Non-OK response is still a user-visible failure: emit an error
      // progress event so the bootstrap UI can surface it instead of
      // hanging on 'loading'.
      await progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: 0,
        status: 'error',
        error: `HTTP ${response.status}`,
      });
    }

    return response;
  } catch (error) {
    await progress.report({
      key: resourceKey,
      name: entry.name,
      url: request.url,
      size: entry.size,
      loaded: 0,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response('Network error', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
