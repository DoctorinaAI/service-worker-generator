import type { ResourceManifest } from '../shared/types';
import { precacheResources, getTempCacheName } from './cache-manager';
import { COUNTED_CATEGORIES, type ProgressReporter } from './progress';

/**
 * Handle the SW install event.
 * Pre-caches the counted set (Core and Required) into a temp cache.
 *
 * Intentionally does not call `skipWaiting()`: the newly installed worker
 * should remain in `waiting` until the client explicitly accepts the update
 * via the message-driven activation flow.
 */
export function createInstallHandler(
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  progress: ProgressReporter,
): (event: ExtendableEvent) => void {
  return (event: ExtendableEvent) => {
    event.waitUntil(handleInstall(cachePrefix, version, manifest, progress));
  };
}

async function handleInstall(
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  progress: ProgressReporter,
): Promise<void> {
  const tempCacheName = getTempCacheName(cachePrefix, version);

  // Notify clients that install has started. Carries the totals only —
  // an empty key is not a resource, so it never counts towards progress.
  await progress.report({
    key: '',
    name: '',
    url: '',
    size: 0,
    loaded: 0,
    status: 'loading',
  });

  // Pre-cache the counted set, notifying clients per file so the bootstrap
  // can show smooth count-based progress during install. `COUNTED_CATEGORIES`
  // is shared with the reporter, so what gets pre-cached and what gets
  // counted cannot drift apart.
  // `precacheResources` throws if any Core entry fails — that surfaces to
  // `waitUntil` so the SW install is rejected and the old version keeps
  // serving traffic.
  try {
    await precacheResources(
      tempCacheName,
      manifest,
      COUNTED_CATEGORIES,
      async (path, entry) => {
        await progress.report({
          key: path,
          name: entry.name,
          url: path,
          size: entry.size,
          loaded: entry.size,
          status: 'completed',
        });
      },
    );
  } catch (error) {
    // Clean up the half-populated temp cache so the next install starts fresh.
    await caches.delete(tempCacheName);
    throw error;
  }
}
