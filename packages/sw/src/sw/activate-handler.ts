import type { ResourceManifest } from '../shared/types';
import {
  cleanupOldCaches,
  getContentCacheName,
  getManifestCacheName,
  getTempCacheName,
  swapCaches,
} from './cache-manager';
import { reportIfQuotaExceeded } from './quota';
import { allVersionsOrNull } from './registration';
import { reportLifecycle } from './lifecycle';
import { log } from '../shared/logger';

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
      // A version named `manifest` would name its content cache like the
      // manifest cache; that one is only ever emptied.
      const manifestCacheName = getManifestCacheName(cachePrefix);
      const drop = async (names: readonly string[]): Promise<void> => {
        await Promise.all(
          names
            .filter((name) => name !== manifestCacheName)
            .map((name) => caches.delete(name).catch(() => false)),
        );
      };

      if (
        reportIfQuotaExceeded(
          'swapping the temp cache into the content cache',
          error,
        )
      ) {
        // Out of storage, not out of order: every entry the swap did move
        // is a whole, size-checked copy in the content cache, and
        // `cacheFirst` fetches whatever did not make it. Dropping all of it
        // would leave the app running from the network on every load — on
        // the device with the least room to spare. What goes is the temp
        // cache: it holds the duplicates that filled the quota.
        log.error(
          '[SW] Cache swap ran out of storage; keeping what was swapped ' +
            'and dropping the temp cache:',
          error,
        );
        await reportLifecycle(version, 'activate', 'failed', error);
        await drop([getTempCacheName(cachePrefix, version)]);
      } else {
        // Start this version over from the network rather than trust a
        // half-finished swap. Only this version's caches: other versions'
        // belong to workers installing beside this one, and to other apps
        // that share the prefix.
        //
        // The manifest cache itself stays, emptied: its existence is what
        // marks this prefix as in use (see `ownCacheNames`), and an app
        // whose prefix is a shorter start of ours would otherwise treat our
        // pending temp caches as its own until our next install.
        log.error('[SW] Cache swap failed, dropping this version\'s caches:', error);
        await Promise.all([
          drop([
            getContentCacheName(cachePrefix, version),
            getTempCacheName(cachePrefix, version),
          ]),
          forgetManifest(cachePrefix),
        ]);
      }
    }

    try {
      // Passed as a function: read after the cache listing, see there.
      await cleanupOldCaches(cachePrefix, version, pendingVersions);
    } catch (error) {
      log.warn('[SW] Old cache cleanup failed:', error);
    }

    // Enable navigation preload so network-first navigations start their
    // fetch in parallel with SW bootup instead of blocking on it.
    try {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
    } catch (error) {
      log.warn('[SW] Navigation preload unavailable:', error);
    }
  } finally {
    await self.clients.claim();
  }
}

/**
 * Versions of the workers installing or waiting in this registration, read
 * from the `?v=` that bootstrap registers them with, or `null` when one of
 * them cannot be read — the same guard install applies before it removes
 * temp caches.
 */
function pendingVersions(): string[] | null {
  return allVersionsOrNull(['installing', 'waiting']);
}

/**
 * Drop the stored manifest, so the next swap diffs against nothing, while
 * keeping the manifest cache. If the entry cannot be removed, the whole
 * cache goes, as it used to.
 */
async function forgetManifest(cachePrefix: string): Promise<void> {
  const name = getManifestCacheName(cachePrefix);
  try {
    await (await caches.open(name)).delete('manifest');
  } catch {
    await caches.delete(name).catch(() => false);
  }
}
