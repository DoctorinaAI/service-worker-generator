import type { ResourceManifest, ResourceEntry } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { NEVER_CACHE_FILES } from '../shared/constants';
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

  // App-shell path, checked before the manifest lookup: a Flutter route
  // like `/chat/42` is a navigation with no manifest entry of its own, and
  // the host rewrites it to the same `index.html`. Matching on the entry
  // first would drop those navigations on the floor — including offline,
  // where the pre-cached shell is the only thing that can answer them.
  if (request.mode === 'navigate' || resourceKey === INDEX_KEY) {
    event.respondWith(
      networkFirst(event, cachePrefix, version, manifest, progress),
    );
    return;
  }

  if (!entry || entry.category === ResourceCategory.Ignore) return;

  event.respondWith(
    cacheFirst(request, resourceKey, entry, cachePrefix, version, progress),
  );
}

/**
 * Network-first strategy for index.html / navigation requests.
 *
 * Prefers a navigationPreload response if available, then falls through to
 * `fetchWithRetry`. Falls back to the scoped content cache on any network
 * error *or* non-ok HTTP response so a broken origin cannot replace a good
 * cached page.
 */
async function networkFirst(
  event: FetchEvent,
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  progress: ProgressReporter,
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
    const cache = await caches.open(cacheName);
    const cached = await cache.match(new Request(INDEX_KEY));
    if (cached) {
      await notifyIndex('cached');
      return cached;
    }
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  };

  try {
    // Prefer navigationPreload if enabled.
    const preload = (await event.preloadResponse) as Response | undefined;
    let response = preload;
    if (!response) {
      response = await fetchWithRetry(request);
    }

    if (!response.ok) {
      return await fallbackToCache();
    }

    const cache = await caches.open(cacheName);
    await cache.put(new Request(INDEX_KEY), response.clone());
    await notifyIndex('updated');
    return response;
  } catch {
    return fallbackToCache();
  }
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
  const cache = await caches.open(cacheName);

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
      await lazyCacheResponse(cacheName, new Request(resourceKey), response);

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
