import type { ResourceManifest, ResourceEntry } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { NEVER_CACHE_FILES } from '../shared/constants';
import { getResourceKey, fetchWithRetry } from '../shared/utils';
import { lazyCacheResponse, getContentCacheName } from './cache-manager';
import { notifyClients } from './notify';

declare const self: ServiceWorkerGlobalScope;

/**
 * Handle a fetch event based on manifest and caching strategy.
 */
export function handleFetch(
  event: FetchEvent,
  manifest: ResourceManifest,
  cachePrefix: string,
  version: string,
  totalResourcesSize: number,
  totalResourcesCount: number,
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

  if (!entry && resourceKey !== 'index.html') return;

  if (resourceKey === 'index.html' || request.mode === 'navigate') {
    event.respondWith(
      networkFirst(
        event,
        cachePrefix,
        version,
        manifest,
        totalResourcesSize,
        totalResourcesCount,
      ),
    );
    return;
  }

  if (entry?.category === ResourceCategory.Ignore) return;

  event.respondWith(
    cacheFirst(
      request,
      resourceKey,
      entry,
      cachePrefix,
      version,
      totalResourcesSize,
      totalResourcesCount,
    ),
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
  totalResourcesSize: number,
  totalResourcesCount: number,
): Promise<Response> {
  const { request } = event;
  const cacheName = getContentCacheName(cachePrefix, version);
  const entry = manifest['index.html'];

  const notifyIndex = async (status: 'updated' | 'cached'): Promise<void> => {
    if (!entry) return;
    await notifyClients(self, {
      type: 'sw-progress',
      timestamp: Date.now(),
      resourcesSize: totalResourcesSize,
      resourcesCount: totalResourcesCount,
      resourceName: 'index.html',
      resourceUrl: request.url,
      resourceKey: 'index.html',
      resourceSize: entry.size,
      loaded: entry.size,
      status,
    });
  };

  const fallbackToCache = async (): Promise<Response> => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
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
    await cache.put(request, response.clone());
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
  totalResourcesSize: number,
  totalResourcesCount: number,
): Promise<Response> {
  const cacheName = getContentCacheName(cachePrefix, version);
  const cache = await caches.open(cacheName);

  const cached = await cache.match(new Request(resourceKey));
  if (cached) {
    await notifyClients(self, {
      type: 'sw-progress',
      timestamp: Date.now(),
      resourcesSize: totalResourcesSize,
      resourcesCount: totalResourcesCount,
      resourceName: entry.name,
      resourceUrl: request.url,
      resourceKey,
      resourceSize: entry.size,
      loaded: entry.size,
      status: 'cached',
    });
    return cached;
  }

  try {
    await notifyClients(self, {
      type: 'sw-progress',
      timestamp: Date.now(),
      resourcesSize: totalResourcesSize,
      resourcesCount: totalResourcesCount,
      resourceName: entry.name,
      resourceUrl: request.url,
      resourceKey,
      resourceSize: entry.size,
      loaded: 0,
      status: 'loading',
    });

    const response = await fetchWithRetry(request);

    if (response.ok) {
      await lazyCacheResponse(cacheName, new Request(resourceKey), response);

      await notifyClients(self, {
        type: 'sw-progress',
        timestamp: Date.now(),
        resourcesSize: totalResourcesSize,
        resourcesCount: totalResourcesCount,
        resourceName: entry.name,
        resourceUrl: request.url,
        resourceKey,
        resourceSize: entry.size,
        loaded: entry.size,
        status: 'completed',
      });
    } else {
      // Non-OK response is still a user-visible failure: emit an error
      // progress event so the bootstrap UI can surface it instead of
      // hanging on 'loading'.
      await notifyClients(self, {
        type: 'sw-progress',
        timestamp: Date.now(),
        resourcesSize: totalResourcesSize,
        resourcesCount: totalResourcesCount,
        resourceName: entry.name,
        resourceUrl: request.url,
        resourceKey,
        resourceSize: entry.size,
        loaded: 0,
        status: 'error',
        error: `HTTP ${response.status}`,
      });
    }

    return response;
  } catch (error) {
    await notifyClients(self, {
      type: 'sw-progress',
      timestamp: Date.now(),
      resourcesSize: totalResourcesSize,
      resourcesCount: totalResourcesCount,
      resourceName: entry.name,
      resourceUrl: request.url,
      resourceKey,
      resourceSize: entry.size,
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
