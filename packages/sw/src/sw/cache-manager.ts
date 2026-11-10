import type { ResourceEntry, ResourceManifest } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import {
  BODY_STALL_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  MANIFEST_CACHE_SUFFIX,
  MAX_RETRY_ATTEMPTS,
  PRECACHE_CONCURRENCY,
  PROGRESS_THROTTLE_MS,
  SWAP_CONCURRENCY,
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
import { log } from '../shared/logger';

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
 * A previous version's content cache, and the manifest that describes what
 * is in it. See `findReusableSource`.
 */
export interface ReuseSource {
  /** The version that cache belongs to, for the log line. */
  version: string;
  cache: Cache;
  manifest: ResourceManifest;
}

/**
 * Header the install records the manifest hash in, on every copy it
 * stores. A stored body cannot be hashed again without reading it whole,
 * and the URL it was fetched by — which carries the hash — is not what it
 * is stored under, so the hash has to travel with the response.
 */
const HASH_HEADER = 'x-sw-hash';

/**
 * [response] with [hash] recorded on it.
 *
 * The body is passed through as a stream, never buffered: these are the
 * largest files the app ships. A response the environment refuses to
 * rebuild is stored as it is — one entry that gets re-fetched on a resumed
 * install, rather than an install that fails.
 */
function stamped(response: Response, hash: string): Response {
  try {
    const headers = new Headers(response.headers);
    headers.set(HASH_HEADER, hash);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    log.warn('[SW] Could not record the hash of a cached response:', error);
    return response;
  }
}

/**
 * Copy [path] from a previous version's cache when that version had the
 * very same file, and report whether it was.
 *
 * "The same file" is the manifest's hash and size, both from the build that
 * wrote the cache and from this one. The stored copy is taken as it is: it
 * passed the size check when it was first stored, and a host that
 * re-encodes what it serves had its copy accepted deliberately (see
 * `storeAfterSizeMismatch`), so re-checking its length here would reject
 * exactly the copy that host will serve again.
 */
async function reuseFromPreviousVersion(
  cache: Cache,
  path: string,
  entry: ResourceEntry,
  source: ReuseSource | undefined,
): Promise<boolean> {
  if (!source) return false;
  const before = source.manifest[path];
  if (!before || before.hash !== entry.hash || before.size !== entry.size) {
    return false;
  }
  try {
    const stored = await source.cache.match(new Request(path));
    if (!stored) return false;
    await cache.put(new Request(path), stamped(stored, entry.hash));
    return true;
  } catch (error) {
    // A cache that was deleted under us, or a write that failed: fetch it.
    log.warn(`[SW] Could not reuse the cached ${path}:`, error);
    return false;
  }
}

/**
 * Whether [path] is already in [cache] as the file [entry] describes,
 * from an earlier attempt at the same install.
 *
 * The stored copy has to carry this entry's hash. A build generated with
 * an explicit `--version` that is deployed twice shares a temp cache name
 * with the previous one, so "there is something under this key" is not
 * enough — and neither is its length: an edit that leaves a file the same
 * size, which is most edits to a JS bundle, would pass. Keeping the
 * previous deploy's file there is the one outcome worse than downloading
 * it again, because the swap then pairs it with this build's other files.
 *
 * The hash is all that is checked. A copy only ever carries it once its
 * body has been stored whole: `cache.put` streams through the size guard
 * and stores nothing when that guard fails, and a re-encoded copy whose
 * size cannot match was accepted deliberately (`storeAfterSizeMismatch`).
 * Comparing `Content-Length` as well turned every copy from a host that
 * compresses — the header then counts encoded bytes, or is absent — into a
 * re-download, which is most hosts and exactly the large files a resumed
 * install exists to keep.
 *
 * A copy with no hash on it — written by a worker from before this record
 * existed — is re-fetched, which is the safe answer.
 */
async function alreadyPrecached(
  cache: Cache,
  path: string,
  entry: ResourceEntry,
): Promise<boolean> {
  // Not the shell: it is network-first, and rewritten by navigations.
  if (expectedBodySize(path, entry) === undefined) return false;
  try {
    const present = await cache.match(new Request(path));
    if (!present) return false;
    if (present.headers.get(HASH_HEADER) !== entry.hash) return false;
    log.info(`[SW] ${path} is already precached, keeping it`);
    return true;
  } catch {
    // An unreadable cache: fetch it, as before.
    return false;
  }
}

/**
 * Wrap [report] so it is called at most every `PROGRESS_THROTTLE_MS`, and
 * `undefined` when there is nothing to report to.
 */
function throttled(
  report: ((loaded: number) => void) | undefined,
): ((loaded: number) => void) | undefined {
  if (!report) return undefined;
  let last = 0;
  return (loaded: number): void => {
    const now = Date.now();
    if (now - last < PROGRESS_THROTTLE_MS) return;
    last = now;
    report(loaded);
  };
}

/**
 * Fetch [path] by its hash-busted URL and store it under its manifest key.
 *
 * Returns `true` once stored; throws the reason otherwise — a
 * [BodySizeMismatchError] when the body was not the build's file, which
 * says more than whatever the Cache API would have rejected with.
 */
async function fetchIntoCache(
  cache: Cache,
  path: string,
  entry: ResourceEntry,
  onBytes?: (loaded: number) => void,
): Promise<boolean> {
  const url = cacheBustUrl(path, entry.hash);
  const request = new Request(url, { cache: 'reload' });
  let mismatch: BodySizeMismatchError | undefined;

  // Transient server errors (5xx, 429) are retried here, not only thrown
  // network errors: one 503 on a flaky edge would otherwise fail a Core
  // entry and restart the download of every file on the next load. Other
  // 4xx are final.
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
  // short — a chunked response closed early, a truncating proxy — would
  // otherwise be served cache-first until the next deploy, breaking the
  // app for this user only. The count is streaming, so a mismatch errors
  // the body and `cache.put` stores nothing.
  //
  // The stall part of the guard: `fetchWithRetry` only bounds the headers,
  // and the bodies here are the largest files the app ships — a stream
  // that dies mid-transfer would otherwise hang `cache.put`, and with it
  // this install, for as long as the browser lets an install event run.
  // That is not a slow install: it blocks the scope's job queue, so every
  // `register()` on the origin hangs until the browser kills it minutes
  // later. Failing the entry instead costs one install attempt, retried on
  // the next page load.
  //
  // Built inside the `try`: for a null body (a `204`, which is `ok`) the
  // guard throws its mismatch synchronously, and that must get the same
  // second look as one found while streaming.
  try {
    const guarded = guardBody(response, {
      idleMs: BODY_STALL_TIMEOUT_MS,
      expectedBytes: expectedBodySize(path, entry),
      label: path,
      onMismatch: (error) => {
        mismatch = error;
      },
      onBytes: throttled(onBytes),
    });
    await cache.put(
      new Request(path),
      stamped(await replayableResponse(guarded), entry.hash),
    );
  } catch (error) {
    if (error instanceof BodySizeMismatchError) mismatch = error;
    if (!mismatch) throw error;
    if (!(await storeAfterSizeMismatch(cache, path, url, entry.hash, mismatch))) {
      throw mismatch;
    }
  }
  return true;
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
  reuse?: ReuseSource,
  onBytes?: (path: string, entry: ResourceEntry, loaded: number) => void,
): Promise<void> {
  const cache = await caches.open(cacheName);
  const entries = Object.entries(manifest).filter(([, entry]) =>
    categories.includes(entry.category),
  );

  const coreFailures: string[] = [];
  let reused = 0;
  /**
   * The first out-of-storage error, if there was one. Nothing after it can
   * be stored either, so the remaining entries are not downloaded: a
   * device near its quota would otherwise download the whole build —
   * tens of megabytes — on every page load, forever, since the install is
   * retried on each one. Core entries left unreached are still counted as
   * failures, so the install fails rather than activating a cache that is
   * missing the files the app is made of.
   */
  let quotaError: unknown;

  await mapWithConcurrency(entries, PRECACHE_CONCURRENCY, async ([path, entry]) => {
    let stored = false;
    try {
      if (quotaError !== undefined) {
        if (entry.category === ResourceCategory.Core) {
          coreFailures.push(`${path} (not attempted: out of storage)`);
        }
        return;
      }
      // An earlier attempt at this very install may have stored this entry
      // already: a failed `Core` entry fails the whole install, and the
      // next page load tries again. Downloading a 30 MB wasm that is
      // already here is how an install over a flaky connection never
      // finishes at all.
      if (await alreadyPrecached(cache, path, entry)) {
        stored = true;
      } else if (await reuseFromPreviousVersion(cache, path, entry, reuse)) {
        stored = true;
        reused++;
      } else {
        stored = await fetchIntoCache(
          cache,
          path,
          entry,
          onBytes && ((loaded) => onBytes(path, entry, loaded)),
        );
      }
    } catch (error) {
      if (reportIfQuotaExceeded(`precaching ${path}`, error)) {
        quotaError ??= error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const msg = `[SW] Precache failed for ${path}: ${reason}`;
      if (entry.category === ResourceCategory.Core) {
        coreFailures.push(`${path} (${reason})`);
        log.error(msg);
      } else {
        log.warn(msg);
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
        log.warn(`[SW] Precache progress report failed for ${path}:`, error);
      }
    }
  });

  if (reused > 0 && reuse) {
    log.info(
      `[SW] Reused ${reused} unchanged file(s) from v${reuse.version}`,
    );
  }

  if (coreFailures.length > 0) {
    // The quota error travels as the `cause`: the aggregate's own name is
    // `Error`, and whoever reports this failure to the page has to be able
    // to tell "out of storage" — which the user can act on — from a
    // network or host problem, which they cannot.
    throw new Error(
      `Precache failed for ${coreFailures.length} Core resource(s): ` +
        coreFailures.join(', '),
      quotaError === undefined ? undefined : { cause: quotaError },
    );
  }
  // A quota error that cost no Core entry is not fatal, as documented: the
  // files left out are `Required` ones the fetch handler refills from the
  // network. Failing here instead would leave a device near its quota on
  // its old build for good.
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
  hash: string,
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
    log.error(
      `[SW] ${path}: the host declares ${declared} bytes and ${size} were ` +
        `received (${first.received} the first time); the transfer is being ` +
        `cut short`,
    );
    return false;
  }
  if (size !== first.expected && size === 0) {
    log.error(
      `[SW] ${path}: an empty body for a file of ${first.expected} bytes`,
    );
    return false;
  }
  if (size !== first.expected && !isReencoded(response)) {
    log.error(
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
    log.error(
      `[SW] ${path}: ${first.received} bytes, then ${size}, for a file of ` +
        `${first.expected}; the transfer is being cut short`,
    );
    return false;
  }
  if (size !== first.expected) {
    log.warn(
      `[SW] ${path}: the host serves ${size} bytes where the build has ` +
        `${first.expected}, re-encoded, on every request; storing it as served`,
    );
  }
  await cache.put(
    new Request(path),
    stamped(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      hash,
    ),
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
    log.warn(`[SW] Not caching ${key}: HTTP ${response.status}`);
    return;
  }
  if (isHtmlFallback(key, response)) {
    log.warn(`[SW] Not caching ${request.url}: served as HTML`);
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
  let guarded: Response | undefined;
  try {
    guarded = guardBody(copy, {
      idleMs: BODY_STALL_TIMEOUT_MS,
      expectedBytes,
      label: key,
      onMismatch: (error) => {
        mismatch = error;
      },
    });
    await cache.put(request, guarded);
  } catch (error) {
    // A write refused before reading the body leaves the copy buffering, as
    // above. One the write already read or locked rejects this, harmlessly.
    guarded?.body?.cancel().catch(() => undefined);
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
  // Moved a few at a time, and each entry released as soon as it is
  // copied, rather than the whole set at once with the temp cache dropped
  // at the end: that way every pre-cached byte of the app exists twice for
  // the length of the swap, which on Safari's quota is how a wasm app's
  // activate fails with QuotaExceededError. A worker that dies mid-swap
  // leaves the moved entries in the content cache and the rest in the temp
  // one, and the next swap picks up where this one stopped.
  await mapWithConcurrency(tempKeys, SWAP_CONCURRENCY, async (request) => {
    const response = await tempCache.match(request);
    if (!response) return;
    await contentCache.put(request, response);
    refreshedPaths.add(getResourceKey(request.url));
    await tempCache.delete(request).catch(() => false);
  });

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
  await saveManifest(manifestCache, version, manifest);

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
    log.warn(
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
    log.info(`[SW] Removed orphaned temp cache(s): ${removed.join(', ')}`);
  }
  if (removed.length < doomed.length) {
    log.warn(
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
  return (await loadPreviousRecord(cache))?.manifest ?? null;
}

/**
 * What the last activated version left behind: its manifest, and its own
 * version when it recorded one.
 *
 * Releases before the version was stored wrote the manifest alone, so a
 * stored object without a `manifest` key *is* the manifest. Reading both
 * shapes is what keeps the first install after an upgrade from treating a
 * perfectly good cache as corrupt.
 */
export async function loadPreviousRecord(
  cache: Cache,
): Promise<{ version?: string; manifest: ResourceManifest } | null> {
  const response = await cache.match('manifest');
  if (!response) return null;
  try {
    const stored = (await response.json()) as
      | ResourceManifest
      | { version?: unknown; manifest?: unknown };
    const manifest = (stored as { manifest?: unknown }).manifest;
    if (manifest && typeof manifest === 'object') {
      const version = (stored as { version?: unknown }).version;
      return {
        manifest: manifest as ResourceManifest,
        ...(typeof version === 'string' && version ? { version } : {}),
      };
    }
    return { manifest: stored as ResourceManifest };
  } catch {
    return null;
  }
}

/**
 * Save the current manifest, and the version it belongs to, in the
 * manifest cache. The version is what lets the next install find the
 * content cache whose unchanged files it can reuse.
 */
async function saveManifest(
  cache: Cache,
  version: string,
  manifest: ResourceManifest,
): Promise<void> {
  const response = new Response(JSON.stringify({ version, manifest }), {
    headers: { 'Content-Type': 'application/json' },
  });
  await cache.put('manifest', response);
}

/**
 * The content cache of the last activated version, when it is another one
 * and it is still there, with the manifest that describes it.
 *
 * Its entries are what a new version's install can copy instead of
 * downloading: a content cache is named after its version, so every deploy
 * used to start from an empty one and fetch every Core and Required file
 * again — an assets-only deploy made every user download the whole
 * `main.dart.wasm` a second time. Only entries whose hash is unchanged are
 * copied, so the one guarantee that matters — shell, bootstrap and Dart
 * code from one deploy — is untouched.
 *
 * `undefined` when there is nothing to reuse, which is also what every
 * failure to look returns: reuse is an optimisation.
 */
export async function findReusableSource(
  prefix: string,
  version: string,
): Promise<ReuseSource | undefined> {
  try {
    const record = await loadPreviousRecord(
      await caches.open(getManifestCacheName(prefix)),
    );
    if (!record?.version || record.version === version) return undefined;
    const name = getContentCacheName(prefix, record.version);
    // `caches.open` would create it; a missing cache means nothing to reuse.
    if (!(await caches.has(name))) return undefined;
    return {
      version: record.version,
      cache: await caches.open(name),
      manifest: record.manifest,
    };
  } catch (error) {
    log.warn('[SW] Could not look for reusable cached files:', error);
    return undefined;
  }
}
