import type { ResourceManifest } from '../shared/types';
import { swapCaches, cleanupOldCaches } from './cache-manager';

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
  try {
    // Atomic swap: temp cache → content cache
    await swapCaches(cachePrefix, version, manifest);

    // Clean up old versioned caches
    await cleanupOldCaches(cachePrefix, version);
  } catch (error) {
    console.error('[SW] Activate error, clearing all caches:', error);
    // Clean slate on error
    const allCaches = await caches.keys();
    await Promise.all(
      allCaches
        .filter((name) => name.startsWith(cachePrefix))
        .map((name) => caches.delete(name)),
    );
  } finally {
    // Always claim clients, even on error
    await self.clients.claim();
  }
}
