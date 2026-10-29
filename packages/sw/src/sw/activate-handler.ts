import type { ResourceManifest } from '../shared/types';
import {
  cleanupOldCaches,
  getContentCacheName,
  getManifestCacheName,
  getTempCacheName,
  swapCaches,
} from './cache-manager';

declare const self: ServiceWorkerGlobalScope;

/**
 * Handle the SW activate event.
 * Performs atomic cache swap, cleanup, and claims clients.
 */
export function createActivateHandler(
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
): (event: ExtendableEvent) => void {
  return (event: ExtendableEvent) => {
    event.waitUntil(handleActivate(cachePrefix, version, manifest));
  };
}

async function handleActivate(
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
): Promise<void> {
  // Each step is contained on its own, so a failure in one does not undo
  // the others. The fetch handler falls back to the network for anything
  // missing from the content cache, so losing cached entries costs speed,
  // never correctness.
  try {
    try {
      // Atomic swap: temp cache → content cache
      await swapCaches(cachePrefix, version, manifest);
    } catch (error) {
      // Start this version over from the network rather than trust a
      // half-finished swap. Only this version's caches: other versions'
      // belong to workers installing beside this one, and to other apps
      // that share the prefix.
      console.error('[SW] Cache swap failed, dropping this version\'s caches:', error);
      await Promise.all(
        [
          getContentCacheName(cachePrefix, version),
          getTempCacheName(cachePrefix, version),
          getManifestCacheName(cachePrefix),
        ].map((name) => caches.delete(name).catch(() => false)),
      );
    }

    try {
      await cleanupOldCaches(cachePrefix, version, pendingVersions());
    } catch (error) {
      console.warn('[SW] Old cache cleanup failed:', error);
    }

    // Enable navigation preload so network-first navigations start their
    // fetch in parallel with SW bootup instead of blocking on it.
    try {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
    } catch (error) {
      console.warn('[SW] Navigation preload unavailable:', error);
    }
  } finally {
    await self.clients.claim();
  }
}

/**
 * Versions of the workers installing or waiting in this registration, read
 * from the `?v=` that bootstrap registers them with.
 */
function pendingVersions(): string[] {
  const versions: string[] = [];
  for (const worker of [self.registration.installing, self.registration.waiting]) {
    if (!worker) continue;
    try {
      const v = new URL(worker.scriptURL).searchParams.get('v');
      if (v) versions.push(v);
    } catch {
      // An unparsable URL names no version to keep.
    }
  }
  return versions;
}
