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
): (event: ExtendableEvent) => void {
  return (event: ExtendableEvent) => {
    event.waitUntil(handleInstall(cachePrefix, version, manifest, totalResourcesSize));
  };
}

async function handleInstall(
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  totalResourcesSize: number,
): Promise<void> {
  const tempCacheName = getTempCacheName(cachePrefix, version);

  // Notify clients that install has started
  await notifyClients(self, {
    type: 'sw-progress',
    timestamp: Date.now(),
    resourcesSize: totalResourcesSize,
    resourceName: '',
    resourceUrl: '',
    resourceKey: '',
    resourceSize: 0,
    loaded: 0,
    status: 'loading',
  });

  // Pre-cache Core and Required resources
  await precacheResources(tempCacheName, manifest, [
    ResourceCategory.Core,
    ResourceCategory.Required,
  ]);

  // Skip waiting to activate immediately
  await self.skipWaiting();
}
