import type { ResourceManifest, ResourceEntry, SWProgressMessage } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { NEVER_CACHE_FILES } from '../shared/constants';
import { getResourceKey, fetchWithRetry } from '../shared/utils';
import { lazyCacheResponse, getContentCacheName } from './cache-manager';
import { notifyClients } from './notify';

export { fetchWithRetry, fetchWithTimeout } from '../shared/utils';

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

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const resourceKey = getResourceKey(request.url);
  const entry = manifest[resourceKey];

  // Check if this file should never be cached
  if (NEVER_CACHE_FILES.some((f) => resourceKey === f || resourceKey.endsWith(`/${f}`))) {
    return; // Let the browser handle it normally
  }

  // If not in manifest and not root, pass through
  if (!entry && resourceKey !== 'index.html') return;

  // Root / index.html: network-first
  if (resourceKey === 'index.html' || request.mode === 'navigate') {
    event.respondWith(
      networkFirst(
        request,
        cachePrefix,
        version,
        manifest,
        totalResourcesSize,
        totalResourcesCount,
      ),
    );
    return;
  }

  // Ignore category: pass through
  if (entry?.category === ResourceCategory.Ignore) return;

  // Core, Required, Optional: cache-first
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
 */
async function networkFirst(
  request: Request,
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  totalResourcesSize: number,
  totalResourcesCount: number,
): Promise<Response> {
  const cacheName = getContentCacheName(cachePrefix, version);
  const entry = manifest['index.html'];

  try {
    const response = await fetchWithRetry(request);
    if (response.ok) {
      // Cache the fresh response
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());

      if (entry) {
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
          status: 'updated',
        });
      }
    }
    return response;
  } catch {
    // Network failed, try cache
    const cached = await caches.match(request);
    if (cached) {
      if (entry) {
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
          status: 'cached',
        });
      }
      return cached;
    }
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Cache-first strategy for cached resources.
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

  // Try cache first
  const cached = await caches.match(new Request(resourceKey));
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

  // Cache miss: fetch from network
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
      // Cache optional resources lazily
      if (entry.category === ResourceCategory.Optional) {
        await lazyCacheResponse(cacheName, new Request(resourceKey), response);
      }

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
    return new Response('Network error', { status: 503 });
  }
}

