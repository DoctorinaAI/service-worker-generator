import type { ResourceManifest } from '../shared/types';
import {
  cleanupOrphanedTempCaches,
  findReusableSource,
  getManifestCacheName,
  precacheResources,
  getTempCacheName,
} from './cache-manager';
import { readableVersions, workerVersion } from './registration';
import { COUNTED_CATEGORIES, type ProgressReporter } from './progress';
import { reportLifecycle } from './lifecycle';
import { causedByQuota } from './quota';
import { log } from '../shared/logger';

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

  // Claim the prefix before creating any other cache under it. The manifest
  // cache marks the prefix as in use, so an app whose prefix is a shorter
  // start of ours (`app` for our `app-admin`) leaves our temp cache alone
  // even on our very first install (see `ownCacheNames`). Best-effort: the
  // precache below opens caches the same way and reports its own failure.
  try {
    await caches.open(getManifestCacheName(cachePrefix));
  } catch (error) {
    log.warn('[SW] Could not open the manifest cache:', error);
  }

  await removeOrphanedTempCaches(cachePrefix, version);

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

  // What the last activated version cached: every file whose hash this
  // build did not change is copied from there instead of downloaded again.
  // A content cache is named after its version, so without this an
  // assets-only deploy makes every user fetch the whole `main.dart.wasm` a
  // second time.
  const reuse = await findReusableSource(cachePrefix, version);

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
      reuse,
      // Byte-level beats for the file being downloaded, so the loading
      // ring moves during the download that dominates a cold load instead
      // of jumping once per file. Throttled inside `precacheResources`.
      (path, entry, loaded) => {
        void progress.report({
          key: path,
          name: entry.name,
          url: path,
          size: entry.size,
          loaded,
          status: 'loading',
        });
      },
    );
    await reportLifecycle(version, 'install', 'completed');
  } catch (error) {
    // The page's only signal that its caching layer gave up: the log line
    // below lives in the worker, where nothing on the page can see it.
    await reportLifecycle(version, 'install', 'failed', error);
    // The half-populated temp cache is kept on purpose: this install is
    // retried on the next page load, and `precacheResources` skips what is
    // already there, so a 30 MB wasm is not downloaded again for the sake
    // of the one entry a flaky connection dropped. Nothing reads it before
    // then — the swap only runs on activate, which a failed install never
    // reaches — and it is removed with the version, by the orphan cleanup
    // at the start of the next install or by `cleanupOldCaches`.
    //
    // Out of storage is the exception: those megabytes are what the
    // version actually serving the app now needs for its own lazy writes,
    // and nothing will ever activate this cache — what it is missing is
    // exactly what there was no room for. Dropping it gives the retry the
    // room to get further than this one did.
    if (causedByQuota(error)) await dropTempCache(tempCacheName);
    throw error;
  }
}

/**
 * Remove the temp cache this install was filling. Best-effort: a failure
 * here is logged and never replaces the install failure being reported.
 */
async function dropTempCache(tempCacheName: string): Promise<void> {
  try {
    await caches.delete(tempCacheName);
    log.warn(`[SW] Dropped ${tempCacheName} after running out of storage`);
  } catch (error) {
    log.warn(`[SW] Could not drop ${tempCacheName}:`, error);
  }
}

/**
 * Drop temp caches left by versions that can no longer activate, before
 * this install adds another one. Best-effort: a failure here is logged and
 * never fails the install.
 *
 * Kept: this version's, and those of the registration's installing,
 * waiting and active workers. The waiting worker's matters most — it can
 * still activate via `skipWaiting` and would then swap in an empty cache —
 * so when there is a waiting worker whose version cannot be read, nothing
 * is removed at all.
 */
async function removeOrphanedTempCaches(
  cachePrefix: string,
  version: string,
): Promise<void> {
  try {
    if (workerVersion('waiting') === null) {
      log.warn(
        '[SW] Waiting worker has no readable version; keeping all temp caches',
      );
      return;
    }
    await cleanupOrphanedTempCaches(cachePrefix, [
      version,
      ...readableVersions(['installing', 'waiting', 'active']),
    ]);
  } catch (error) {
    log.warn('[SW] Orphaned temp cache cleanup failed:', error);
  }
}
