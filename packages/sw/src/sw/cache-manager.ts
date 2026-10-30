import type { ResourceEntry, ResourceManifest } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import {
  BODY_STALL_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  MANIFEST_CACHE_SUFFIX,
  MAX_RETRY_ATTEMPTS,
  PRECACHE_CONCURRENCY,
  TEMP_CACHE_SUFFIX,
} from '../shared/constants';
import {
  BodySizeMismatchError,
  cacheBustUrl,
  declaredBodyLength,
  fetchWithRetry,
  getResourceKey,
  guardBody,
  isHtmlFallback,
  isReencoded,
  mapWithConcurrency,
  replayableResponse,
} from '../shared/utils';
import { ownCacheNames } from '../shared/cache-ownership';
import { reportIfQuotaExceeded } from './quota';

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
 * Manifest key of the app shell. Excluded from the body size check: hosts
 * inject into HTML (analytics, CSP nonces, edge includes), and the shell is
 * served network-first anyway, so a byte-exact copy buys nothing.
 */
const SHELL_KEY = 'index.html';

/**
 * Byte length a stored body for [key] must have, or `undefined` when it
 * must not be checked (the shell, or an entry without a usable size —
 * `guardBody` ignores anything that is not a non-negative integer).
 */
export function expectedBodySize(
  key: string,
  entry: ResourceEntry | undefined,
): number | undefined {
  if (!entry || key === SHELL_KEY) return undefined;
  return entry.size;
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
  categories: readonly ResourceCategory[],
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
    let stored = false;
    let mismatch: BodySizeMismatchError | undefined;
    try {
      // Transient server errors (5xx, 429) are retried here, not only
      // thrown network errors: one 503 on a flaky edge would otherwise fail
      // a Core entry, discard the whole temp cache and restart the download
      // of every file on the next load. Other 4xx are final.
      const response = await fetchWithRetry(
        request,
        MAX_RETRY_ATTEMPTS,
        FETCH_TIMEOUT_MS,
        { retryOnStatus: true },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (isHtmlFallback(path, response)) {
        throw new Error('served as HTML (the host has no such file)');
      }
      // The guard wraps every body, redirected or not, before `cache.put`
      // consumes it, and hands back a rebuilt response. Rebuilt, it has no
      // `redirected` flag, so a shell from a host that redirects
      // `index.html?v=…` stays replayable for navigations without being
      // buffered; `replayableResponse` is then a no-op kept as a backstop.
      //
      // It also counts the bytes against the manifest's `size`. A body cut
      // short — a chunked response closed early, a truncating proxy —
      // would otherwise be served cache-first until the next deploy,
      // breaking the app for this user only. The count is streaming, so a
      // mismatch errors the body and `cache.put` stores nothing.
      //
      // The stall part of the guard:
      // `fetchWithRetry` only bounds the headers, and the bodies here are
      // the largest files the app ships — a stream that dies mid-transfer
      // would otherwise hang `cache.put`, and with it this install, for as
      // long as the browser lets an install event run. That is not a slow
      // install: it blocks the scope's job queue, so every `register()` on
      // the origin hangs until the browser kills it minutes later. Failing
      // the entry instead costs one install attempt, retried on the next
      // page load.
      //
      // Built inside the `try` below: for a null body (a `204`, which is
      // `ok`) the guard throws its mismatch synchronously, and that must get
      // the same second look as one found while streaming.
      try {
        const guarded = guardBody(response, {
          idleMs: BODY_STALL_TIMEOUT_MS,
          expectedBytes: expectedBodySize(path, entry),
          label: path,
          onMismatch: (error) => {
            mismatch = error;
          },
        });
        await cache.put(new Request(path), await replayableResponse(guarded));
      } catch (error) {
        if (error instanceof BodySizeMismatchError) mismatch = error;
        if (!mismatch) throw error;
        if (!(await storeAfterSizeMismatch(cache, path, url, mismatch))) {
          throw mismatch;
        }
      }
      stored = true;
    } catch (error) {
      reportIfQuotaExceeded(`precaching ${path}`, error);
      // The mismatch, when there was one, says more than whatever the Cache
      // API rejected with.
      const cause = mismatch ?? error;
      const reason = cause instanceof Error ? cause.message : String(cause);
      const msg = `[SW] Precache failed for ${path}: ${reason}`;
      if (entry.category === ResourceCategory.Core) {
        coreFailures.push(`${path} (${reason})`);
        console.error(msg);
      } else {
        console.warn(msg);
      }
    }

    // Reported outside the try above. Inside it, a progress callback that
    // threw would be recorded as a precache failure for a resource that is
    // sitting in the cache — and for a Core entry that fails the whole
    // install over telemetry.
    if (stored && onEach) {
      try {
        await onEach(path, entry);
      } catch (error) {
        console.warn(`[SW] Precache progress report failed for ${path}:`, error);
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
 * Second look at an entry whose body did not have the manifest's size.
 *
 * A body of the wrong size is a transfer cut off, a different file (a CDN
 * that ignores `?v=` and serves the previous build's copy), or a host that
 * rewrites the file on the fly (a minifier, an injected snippet). Only the
 * last may be stored, and only a host that re-encodes the response
 * (`Content-Encoding` other than `identity`) can be doing it. Failing it
 * would fail every install of a Core entry, leaving the page on its
 * previous worker for good. So the file is fetched once more and stored
 * when:
 * - it now has the build's size (the first copy was the wire's fault), or
 * - it is re-encoded and repeats the first copy's length (both longer
 *   than the build's counts as a repeat: the guard stops counting at the
 *   limit).
 *
 * An uncompressed copy of another size is never stored, however often it
 * repeats: the bytes on the wire are the body, so it is a different file
 * or a deterministic truncation. Nor is an empty one.
 *
 * Returns whether a copy was stored. Read whole into memory: this only
 * runs after a mismatch, which is rare.
 */
async function storeAfterSizeMismatch(
  cache: Cache,
  path: string,
  url: string,
  first: BodySizeMismatchError,
): Promise<boolean> {
  const response = await fetchWithRetry(
    new Request(url, { cache: 'reload' }),
    MAX_RETRY_ATTEMPTS,
    FETCH_TIMEOUT_MS,
    { retryOnStatus: true },
  );
  if (!response.ok || isHtmlFallback(path, response)) return false;
  const body = await guardBody(response, {
    idleMs: BODY_STALL_TIMEOUT_MS,
    label: path,
  }).arrayBuffer();
  const size = body.byteLength;
  // A host that declares the length of what it sends settles the question:
  // short of it is the wire, whatever the first copy looked like.
  const declared = declaredBodyLength(response);
  if (declared !== undefined && size !== declared) {
    console.error(
      `[SW] ${path}: the host declares ${declared} bytes and ${size} were ` +
        `received (${first.received} the first time); the transfer is being ` +
        `cut short`,
    );
    return false;
  }
  if (size !== first.expected && size === 0) {
    console.error(
      `[SW] ${path}: an empty body for a file of ${first.expected} bytes`,
    );
    return false;
  }
  if (size !== first.expected && !isReencoded(response)) {
    console.error(
      `[SW] ${path}: ${size} bytes where the build has ${first.expected}, ` +
        `sent uncompressed (${first.received} the first time); a different ` +
        `or truncated copy of the file, not stored`,
    );
    return false;
  }
  const consistent =
    size === first.expected ||
    (first.received > first.expected
      ? size > first.expected
      : size === first.received);
  if (!consistent) {
    console.error(
      `[SW] ${path}: ${first.received} bytes, then ${size}, for a file of ` +
        `${first.expected}; the transfer is being cut short`,
    );
    return false;
  }
  if (size !== first.expected) {
    console.warn(
      `[SW] ${path}: the host serves ${size} bytes where the build has ` +
        `${first.expected}, re-encoded, on every request; storing it as served`,
    );
  }
  await cache.put(
    new Request(path),
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );
  return true;
}

/**
 * Cache a response for an optional resource (lazy caching on first fetch).
 *
 * Only a plain `200` is stored: a `206` is a slice of the file, a `203` a
 * proxy's rewrite and a `204` has no body to serve later.
 *
 * With [expectedBytes], the stored copy must have exactly that many bytes;
 * otherwise the write rejects with a `BodySizeMismatchError` and nothing is
 * stored. The page's copy, [response] itself, is never consumed or cut.
 *
 * The stored copy is cut off after `BODY_STALL_TIMEOUT_MS` of silence, so
 * the write always settles. Callers must not make the page wait for it:
 * see `cacheFirst`, which keeps it alive with `waitUntil` instead.
 */
export async function lazyCacheResponse(
  cacheName: string,
  request: Request,
  response: Response,
  expectedBytes?: number,
): Promise<void> {
  const key = getResourceKey(request.url);
  if (response.status !== 200) {
    console.warn(`[SW] Not caching ${key}: HTTP ${response.status}`);
    return;
  }
  if (isHtmlFallback(key, response)) {
    console.warn(`[SW] Not caching ${request.url}: served as HTML`);
    return;
  }
  // Cloned before the first await: the caller hands [response] to the page
  // without waiting for this write, and a body the page has started reading
  // can no longer be cloned.
  const copy = response.clone();
  let cache: Cache;
  try {
    cache = await caches.open(cacheName);
  } catch (error) {
    // An unread clone would buffer the whole body the page is reading.
    copy.body?.cancel().catch(() => undefined);
    throw error;
  }
  let mismatch: BodySizeMismatchError | undefined;
  try {
    await cache.put(
      request,
      guardBody(copy, {
        idleMs: BODY_STALL_TIMEOUT_MS,
        expectedBytes,
        label: key,
        onMismatch: (error) => {
          mismatch = error;
        },
      }),
    );
  } catch (error) {
    // Rethrow the mismatch itself: the Cache API may reject with a generic
    // error that drops the sizes the caller's log line should show.
    throw mismatch ?? error;
  }
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
        refreshedPaths.add(getResourceKey(request.url));
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
 * Versions of the workers installing or waiting beside this one, or `null`
 * when one of them has a version that cannot be read (keep every temp
 * cache then: one of them is that worker's).
 */
export type PendingVersions = readonly string[] | null;

/**
 * Delete this app's caches from other versions.
 *
 * Kept: the current version's content cache, the manifest cache, and the
 * temp caches of the pending versions — workers installing or waiting
 * beside this one. Deleting a temp cache that an install is still writing
 * would leave that version activating with an empty content cache.
 *
 * [pendingVersions] may be a function, and then it is called after the
 * cache listing: a worker that starts installing after the registration was
 * read but before the listing would otherwise have its fresh temp cache
 * listed and not kept. Read after, any temp cache in the listing belongs to
 * a worker the registration already shows. `null` keeps every temp cache.
 *
 * Which names are this app's at all is decided by `ownCacheNames`: prefix
 * `app-cache` claims neither `app-cache2-v1` nor the caches of an app with
 * prefix `app-cache-admin`.
 */
export async function cleanupOldCaches(
  prefix: string,
  currentVersion: string,
  pendingVersions: PendingVersions | (() => PendingVersions) = [],
): Promise<void> {
  const allCaches = await caches.keys();
  const pending =
    typeof pendingVersions === 'function' ? pendingVersions() : pendingVersions;
  const tempPrefix = `${prefix}${TEMP_CACHE_SUFFIX}-`;
  const keep = new Set([
    getContentCacheName(prefix, currentVersion),
    getManifestCacheName(prefix),
    ...(pending ?? []).map((v) => getTempCacheName(prefix, v)),
  ]);
  if (pending === null) {
    console.warn(
      '[SW] A pending worker has no readable version; keeping all temp caches',
    );
  }

  await Promise.all(
    ownCacheNames(prefix, allCaches)
      .filter(
        (name) =>
          !keep.has(name) && !(pending === null && name.startsWith(tempPrefix)),
      )
      .map((name) => caches.delete(name)),
  );
}

/**
 * Delete this app's temp caches (`{prefix}-temp-{version}`) for every
 * version not in [keepVersions].
 *
 * Run at the start of install: with the opt-in update flow a waiting
 * worker made redundant by a newer deploy leaves its full temp cache behind,
 * and `cleanupOldCaches` only runs on activate, which may be days away.
 * Callers must pass every version that may still use its temp cache — this
 * one, and the registration's installing, waiting and active workers.
 *
 * Uses `ownCacheNames` like `cleanupOldCaches`. Content and manifest caches
 * are never touched — including the content cache of a kept version that
 * itself starts with `temp-`, whose name has the temp shape.
 */
export async function cleanupOrphanedTempCaches(
  prefix: string,
  keepVersions: readonly string[],
): Promise<void> {
  const tempPrefix = `${prefix}${TEMP_CACHE_SUFFIX}-`;
  const keep = new Set([
    getManifestCacheName(prefix),
    ...keepVersions.map((v) => getTempCacheName(prefix, v)),
    ...keepVersions.map((v) => getContentCacheName(prefix, v)),
  ]);
  const doomed = ownCacheNames(prefix, await caches.keys()).filter(
    (name) => name.startsWith(tempPrefix) && !keep.has(name),
  );
  if (doomed.length === 0) return;
  const results = await Promise.all(
    // `false` (already gone) counts as removed; only a rejection does not.
    doomed.map((name) => caches.delete(name).then(() => true, () => false)),
  );
  const removed = doomed.filter((_, i) => results[i]);
  if (removed.length > 0) {
    console.log(`[SW] Removed orphaned temp cache(s): ${removed.join(', ')}`);
  }
  if (removed.length < doomed.length) {
    console.warn(
      `[SW] Could not remove temp cache(s): ` +
        doomed.filter((_, i) => !results[i]).join(', '),
    );
  }
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
