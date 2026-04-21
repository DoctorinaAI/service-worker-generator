import type { ResourceManifest } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { precacheResources, getTempCacheName } from './cache-manager';
import { notifyClients } from './notify';

declare const self: ServiceWorkerGlobalScope;

/**
 * Handle the SW install event.
 * Pre-caches Core and Required resources into a temp cache.
 */
export function createInstallHandler(
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  totalResourcesSize: number,
  totalResourcesCount: number,
): (event: ExtendableEvent) => void {
  return (event: ExtendableEvent) => {
    event.waitUntil(
      handleInstall(
        cachePrefix,
        version,
        manifest,
        totalResourcesSize,
        totalResourcesCount,
      ),
    );
  };
}

async function handleInstall(
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  totalResourcesSize: number,
  totalResourcesCount: number,
): Promise<void> {
  const tempCacheName = getTempCacheName(cachePrefix, version);

  // Notify clients that install has started
  await notifyClients(self, {
    type: 'sw-progress',
    timestamp: Date.now(),
    resourcesSize: totalResourcesSize,
    resourcesCount: totalResourcesCount,
    resourceName: '',
    resourceUrl: '',
    resourceKey: '',
    resourceSize: 0,
    loaded: 0,
    status: 'loading',
  });

  // Pre-cache Core and Required resources, notifying clients per file so
  // the bootstrap can show smooth count-based progress during install.
  // `precacheResources` throws if any Core entry fails — that surfaces to
  // `waitUntil` so the SW install is rejected and the old version keeps
  // serving traffic.
  try {
    await precacheResources(
      tempCacheName,
      manifest,
      [ResourceCategory.Core, ResourceCategory.Required],
      async (path, entry) => {
        await notifyClients(self, {
          type: 'sw-progress',
          timestamp: Date.now(),
          resourcesSize: totalResourcesSize,
          resourcesCount: totalResourcesCount,
          resourceName: entry.name,
          resourceUrl: path,
          resourceKey: path,
          resourceSize: entry.size,
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

  await self.skipWaiting();
}
