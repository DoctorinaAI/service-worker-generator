import type { ResourceEntry, ResourceManifest } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { MANIFEST_CACHE_SUFFIX, TEMP_CACHE_SUFFIX } from '../shared/constants';
import { cacheBustUrl, fetchWithRetry } from '../shared/utils';

declare const self: ServiceWorkerGlobalScope;

/**
 * Get the content cache name for a given prefix and version.
 */
export function getContentCacheName(prefix: string, version: string): string {
  return `${prefix}-${version}`;
}

/**
 * Get the temp cache name for a given prefix and version.
 */
export function getTempCacheName(prefix: string, version: string): string {
  return `${prefix}${TEMP_CACHE_SUFFIX}-${version}`;
}

/**
 * Get the manifest cache name for a given prefix.
 */
export function getManifestCacheName(prefix: string): string {
  return `${prefix}${MANIFEST_CACHE_SUFFIX}`;
}

/**
 * Pre-cache resources of specified categories into a cache.
 *
 * Uses cache-busted URLs to avoid stale responses. Failures on `Core`
 * entries are aggregated and thrown so the SW install fails fast instead
 * of activating with a broken precache. `Required`/`Optional` failures are
 * logged but not fatal — those resources will be refetched lazily by the
 * cache-first handler.
 */
export async function precacheResources(
  cacheName: string,
  manifest: ResourceManifest,
  categories: ResourceCategory[],
  onEach?: (path: string, entry: ResourceEntry) => void | Promise<void>,
): Promise<void> {
  const cache = await caches.open(cacheName);
  const entries = Object.entries(manifest).filter(([, entry]) =>
    categories.includes(entry.category),
  );

  const coreFailures: string[] = [];

  await Promise.all(
    entries.map(async ([path, entry]) => {
      const url = cacheBustUrl(path, entry.hash);
      const request = new Request(url, { cache: 'reload' });
      try {
        const response = await fetchWithRetry(request);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        await cache.put(new Request(path), response);
        if (onEach) await onEach(path, entry);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const msg = `[SW] Precache failed for ${path}: ${reason}`;
        if (entry.category === ResourceCategory.Core) {
          coreFailures.push(`${path} (${reason})`);
          console.error(msg);
        } else {
          console.warn(msg);
        }
      }
    }),
  );

  if (coreFailures.length > 0) {
    throw new Error(
      `Precache failed for ${coreFailures.length} Core resource(s): ` +
        coreFailures.join(', '),
    );
  }
}

/**
 * Cache a response for an optional resource (lazy caching on first fetch).
 */
export async function lazyCacheResponse(
  cacheName: string,
  request: Request,
  response: Response,
): Promise<void> {
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
}

/**
 * Atomic cache swap: move resources from temp cache to content cache.
 * Compares against previous manifest to detect changed resources.
 */
export async function swapCaches(
  prefix: string,
  version: string,
  manifest: ResourceManifest,
): Promise<void> {
  const contentCacheName = getContentCacheName(prefix, version);
  const tempCacheName = getTempCacheName(prefix, version);
  const manifestCacheName = getManifestCacheName(prefix);

  const contentCache = await caches.open(contentCacheName);
  const tempCache = await caches.open(tempCacheName);
  const manifestCache = await caches.open(manifestCacheName);

  // Load previous manifest if exists
  const previousManifest = await loadPreviousManifest(manifestCache);

  // Move temp resources to content cache in parallel
  const tempKeys = await tempCache.keys();
  await Promise.all(
    tempKeys.map(async (request) => {
      const response = await tempCache.match(request);
      if (response) {
        await contentCache.put(request, response);
      }
    }),
  );

  // If we have a previous manifest, remove outdated resources
  if (previousManifest) {
    for (const [path, oldEntry] of Object.entries(previousManifest)) {
      const newEntry = manifest[path];
      // Resource was removed or hash changed
      if (!newEntry || newEntry.hash !== oldEntry.hash) {
        await contentCache.delete(new Request(path));
      }
    }
  }

  // Save current manifest for future comparisons
  await saveManifest(manifestCache, manifest);

  // Delete temp cache
  await caches.delete(tempCacheName);
}

/**
 * Delete all caches with the given prefix except the current version.
 */
export async function cleanupOldCaches(
  prefix: string,
  currentVersion: string,
): Promise<void> {
  const allCaches = await caches.keys();
  const currentContentCache = getContentCacheName(prefix, currentVersion);
  const manifestCache = getManifestCacheName(prefix);

  await Promise.all(
    allCaches
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          name !== currentContentCache &&
          name !== manifestCache,
      )
      .map((name) => caches.delete(name)),
  );
}

/**
 * Load the previous manifest from the manifest cache.
 */
async function loadPreviousManifest(
  cache: Cache,
): Promise<ResourceManifest | null> {
  const response = await cache.match('manifest');
  if (!response) return null;
  try {
    return (await response.json()) as ResourceManifest;
  } catch {
    return null;
  }
}

/**
 * Save the current manifest to the manifest cache.
 */
async function saveManifest(
  cache: Cache,
  manifest: ResourceManifest,
): Promise<void> {
  const response = new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/json' },
  });
  await cache.put('manifest', response);
}
