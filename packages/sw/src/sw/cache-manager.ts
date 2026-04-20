import type { ResourceEntry, ResourceManifest } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import {
  MANIFEST_CACHE_SUFFIX,
  PRECACHE_CONCURRENCY,
  TEMP_CACHE_SUFFIX,
} from '../shared/constants';
import {
  cacheBustUrl,
  fetchWithRetry,
  mapWithConcurrency,
} from '../shared/utils';

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

  await mapWithConcurrency(entries, PRECACHE_CONCURRENCY, async ([path, entry]) => {
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
  });

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
 *
 * Ordering matters for crash-resilience:
 *   1. copy temp → content (idempotent; survives partial crashes)
 *   2. evict stale entries that are absent from the new manifest
 *   3. persist the new manifest (only after content is coherent)
 *   4. drop the temp cache
 *
 * If the SW dies between steps, the content cache is never in a state
 * that advertises the new manifest without the new files, and
 * `cacheFirst` self-heals any gaps via lazy fetch.
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

  // Step 1: copy freshly-precached resources from temp → content in parallel.
  // Doing copy first means the content cache is always a superset of what's
  // advertised by the previous manifest during the swap.
  const tempKeys = await tempCache.keys();
  const refreshedPaths = new Set<string>();
  await Promise.all(
    tempKeys.map(async (request) => {
      const response = await tempCache.match(request);
      if (response) {
        await contentCache.put(request, response);
        refreshedPaths.add(resourceKeyOf(request.url));
      }
    }),
  );

  // Step 2: evict entries whose old copy is now stale. An entry is stale if
  //   (a) it vanished from the new manifest, or
  //   (b) its hash changed AND it was not re-precached this swap (Optional
  //       tier): we want cacheFirst to lazily refetch the new bytes rather
  //       than serve the old.
  // Entries that WERE just re-copied from temp (step 1) must not be touched.
  if (previousManifest) {
    await Promise.all(
      Object.entries(previousManifest).map(async ([path, oldEntry]) => {
        const newEntry = manifest[path];
        const gone = !newEntry;
        const staleOptional =
          !!newEntry &&
          newEntry.hash !== oldEntry.hash &&
          !refreshedPaths.has(path);
        if (gone || staleOptional) {
          await contentCache.delete(new Request(path));
        }
      }),
    );
  }

  // Step 3: persist the new manifest only after the content cache is coherent.
  await saveManifest(manifestCache, manifest);

  // Step 4: drop temp cache.
  await caches.delete(tempCacheName);
}

/**
 * Reduce a Cache-key URL to the manifest-relative path. Cache keys in the
 * SW scope are absolute URLs (`https://host/main.dart.js`) while the
 * manifest is keyed by relative paths (`main.dart.js`).
 */
function resourceKeyOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || 'index.html';
  } catch {
    return url;
  }
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
