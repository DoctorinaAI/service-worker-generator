/**
 * Service Worker entry point.
 *
 * The Dart CLI replaces "__INJECT_SW_CONFIG__" with the actual
 * configuration (manifest, version, cache prefix) at generation time.
 */

import type { SWConfig } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { createInstallHandler } from './install-handler';
import { createActivateHandler } from './activate-handler';
import { handleFetch } from './fetch-handler';
import { createMessageHandler } from './message-handler';

declare const self: ServiceWorkerGlobalScope;

// Configuration injected by the Dart CLI at generation time.
const config: SWConfig = "__INJECT_SW_CONFIG__" as unknown as SWConfig;

const { cachePrefix, version, manifest } = config;

// Calculate total size of cacheable resources (excluding Ignore)
const totalResourcesSize = Object.values(manifest).reduce(
  (sum, entry) =>
    entry.category !== ResourceCategory.Ignore ? sum + entry.size : sum,
  0,
);

// Log initialization
const resourceCount = Object.keys(manifest).length;
console.log(
  `[SW] v${version} | prefix: ${cachePrefix} | ` +
    `resources: ${resourceCount} | size: ${totalResourcesSize} bytes`,
);

// Register event handlers
self.addEventListener('install', createInstallHandler(cachePrefix, version, manifest, totalResourcesSize));
self.addEventListener('activate', createActivateHandler(cachePrefix, version, manifest));
self.addEventListener('fetch', (event: FetchEvent) => {
  handleFetch(event, manifest, cachePrefix, version, totalResourcesSize);
});
self.addEventListener('message', createMessageHandler(version));
