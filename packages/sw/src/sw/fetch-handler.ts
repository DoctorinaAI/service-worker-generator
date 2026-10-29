import type { ResourceManifest, ResourceEntry } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import { NEVER_CACHE_FILES, RESERVED_PATH_PREFIXES } from '../shared/constants';
import {
  cacheBustUrl,
  getResourceKey,
  fetchWithRetry,
  replayableResponse,
} from '../shared/utils';
import {
  expectedBodySize,
  lazyCacheResponse,
  getContentCacheName,
} from './cache-manager';
import { reportIfQuotaExceeded } from './quota';
import type { ProgressReporter } from './progress';

declare const self: ServiceWorkerGlobalScope;

/**
 * Canonical cache key for the app shell.
 *
 * Navigations arrive as `/`, `/index.html` or any SPA route, but the
 * manifest — and therefore the install-time precache — keys the shell as
 * `index.html`. Storing and matching under one key is what lets a
 * navigation be served from the pre-cached copy while offline.
 */
const INDEX_KEY = 'index.html';

/**
 * Handle a fetch event based on manifest and caching strategy.
 */
export function handleFetch(
  event: FetchEvent,
  manifest: ResourceManifest,
  cachePrefix: string,
  version: string,
  progress: ProgressReporter,
): void {
  const { request } = event;

  if (request.method !== 'GET') return;

  // A Range request (media seeking, resumable downloads) wants a slice. The
  // cache holds whole files and could only answer with a 200 the element
  // may refuse, and a 206 must never be stored as the file. Straight to
  // the network: no cache read, no cache write.
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const resourceKey = getResourceKey(request.url);
  const entry = manifest[resourceKey];

  if (NEVER_CACHE_FILES.some((f) => resourceKey === f || resourceKey.endsWith(`/${f}`))) {
    return;
  }

  // Namespaces the host serves itself. Same origin, but not ours.
  if (RESERVED_PATH_PREFIXES.some((prefix) => resourceKey.startsWith(prefix))) {
    return;
  }

  // App-shell path, checked before the manifest lookup: a Flutter route
  // like `/chat/42` is a navigation with no manifest entry of its own, and
  // the host rewrites it to the same `index.html`. Matching on the entry
  // first would drop those navigations on the floor — including offline,
  // where the pre-cached shell is the only thing that can answer them.
  //
  // Only a request *for* the shell may refresh the cached shell. Every
  // other navigation reads that cache but never writes it: a same-origin
  // page outside the SPA answers a navigation with its own HTML, and
  // storing that under the shell key leaves the app unable to boot from
  // cache at all.
  const isShellRequest = resourceKey === INDEX_KEY;
  if (request.mode === 'navigate' || isShellRequest) {
    event.respondWith(
      networkFirst(event, cachePrefix, version, manifest, progress, isShellRequest),
    );
    return;
  }

  if (!entry || entry.category === ResourceCategory.Ignore) return;

  event.respondWith(
    cacheFirst(request, resourceKey, entry, cachePrefix, version, progress),
  );
}

/**
 * Network-first strategy for navigations and `index.html`.
 *
 * Prefers a navigationPreload response if available, then falls through to
 * `fetchWithRetry`. Falls back to the pre-cached app shell on any network
 * error *or* non-ok HTTP response so a broken origin cannot replace a good
 * cached page.
 *
 * Nothing after a successful fetch may reject: this promise is handed to
 * `respondWith`, so a rejection is a failed navigation — a blank error page
 * where the origin had just answered 200.
 */
async function networkFirst(
  event: FetchEvent,
  cachePrefix: string,
  version: string,
  manifest: ResourceManifest,
  progress: ProgressReporter,
  isShellRequest: boolean,
): Promise<Response> {
  const { request } = event;
  const cacheName = getContentCacheName(cachePrefix, version);
  const entry = manifest[INDEX_KEY];

  const notifyIndex = async (status: 'updated' | 'cached'): Promise<void> => {
    if (!entry) return;
    await progress.report({
      key: INDEX_KEY,
      name: INDEX_KEY,
      url: request.url,
      size: entry.size,
      loaded: entry.size,
      status,
    });
  };

  const fallbackToCache = async (): Promise<Response> => {
    try {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(new Request(INDEX_KEY));
      if (cached) {
        await notifyIndex('cached');
        return cached;
      }
    } catch (error) {
      console.warn('[SW] App-shell cache lookup failed:', error);
    }
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  };

  let response: Response;
  try {
    // Prefer navigationPreload if enabled.
    const preload = (await event.preloadResponse) as Response | undefined;
    response = preload ?? (await fetchWithRetry(request));
  } catch {
    return fallbackToCache();
  }

  // A navigation request carries redirect mode "manual", so a same-origin
  // 3xx arrives opaque: `type` is "opaqueredirect", `status` is 0 and `ok`
  // is false. That is not a failure. Handing it back is precisely what lets
  // the browser follow the redirect; reading it as a failure would answer
  // every redirecting URL on the origin with the app shell instead.
  if (response.type === 'opaqueredirect' || response.status === 0) {
    return response;
  }

  if (!response.ok) {
    return fallbackToCache();
  }

  if (isShellRequest) {
    let stored = false;
    try {
      const cache = await caches.open(cacheName);
      // Store a replayable copy: a response carrying the `redirected` flag
      // is rejected by the browser when it is later served for a
      // navigation, which would break exactly the offline load the
      // pre-cached shell exists for.
      await cache.put(
        new Request(INDEX_KEY),
        await replayableResponse(response.clone()),
      );
      stored = true;
    } catch (error) {
      // Quota pressure is routine for a wasm-sized app. A cache we could
      // not write is a worse offline story, not a reason to withhold a
      // page the origin just served.
      if (!reportIfQuotaExceeded(`writing ${INDEX_KEY}`, error)) {
        console.warn('[SW] App-shell cache write failed:', error);
      }
    }
    // Report the refresh only when it happened. Announcing an update we
    // failed to store would hide quota pressure from the one channel
    // built to surface resource state.
    if (stored) await notifyIndex('updated');
  }

  return response;
}

/**
 * Cache-first strategy for cached resources.
 *
 * Looks up the response in the current versioned content cache only. Cache
 * misses populate the cache for any category except `Ignore` so evicted or
 * partially-precached Core/Required resources self-heal.
 */
async function cacheFirst(
  request: Request,
  resourceKey: string,
  entry: ResourceEntry,
  cachePrefix: string,
  version: string,
  progress: ProgressReporter,
): Promise<Response> {
  const cacheName = getContentCacheName(cachePrefix, version);

  // An unusable CacheStorage (evicted, blocked by a privacy mode) must
  // degrade to a plain network fetch. Rejecting here would fail the
  // resource outright, and these are the files the app is made of.
  let cache: Cache | null = null;
  try {
    cache = await caches.open(cacheName);
    const cached = await cache.match(new Request(resourceKey));
    if (cached) {
      await progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: entry.size,
        status: 'cached',
      });
      return cached;
    }
  } catch (error) {
    console.warn(`[SW] Cache lookup failed for ${resourceKey}:`, error);
    cache = null;
  }

  try {
    await progress.report({
      key: resourceKey,
      name: entry.name,
      url: request.url,
      size: entry.size,
      loaded: 0,
      status: 'loading',
    });

    const response =
      entry.category === ResourceCategory.Core ||
      entry.category === ResourceCategory.Required
        ? await fetchRefill(request, resourceKey, entry)
        : await fetchWithRetry(request);

    if (response.ok) {
      if (cache) {
        try {
          await lazyCacheResponse(
            cacheName,
            new Request(resourceKey),
            response,
            expectedBodySize(resourceKey, entry),
          );
        } catch (error) {
          if (!reportIfQuotaExceeded(`caching ${resourceKey}`, error)) {
            console.warn(`[SW] Cache write failed for ${resourceKey}:`, error);
          }
        }
      }

      await progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: entry.size,
        status: 'completed',
      });
    } else {
      // Non-OK response is still a user-visible failure: emit an error
      // progress event so the bootstrap UI can surface it instead of
      // hanging on 'loading'.
      await progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: 0,
        status: 'error',
        error: `HTTP ${response.status}`,
      });
    }

    return response;
  } catch (error) {
    await progress.report({
      key: resourceKey,
      name: entry.name,
      url: request.url,
      size: entry.size,
      loaded: 0,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response('Network error', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

/**
 * Network copy of a missing Core/Required entry, fetched the way precache
 * fetches it: `?v={hash}` and `cache: 'reload'`.
 *
 * The page asks for `main.dart.wasm` without a hash, so its own request can
 * be answered by an intermediate or HTTP cache with another build's file,
 * which would then be pinned in CacheStorage under this version. The
 * hash-busted URL names exactly this build's bytes.
 *
 * Everything else the page sent is kept: its query string (the manifest
 * key ignores the query, so it does not change what is cached, but a host
 * may need it — a signed URL, say), headers and credentials. The mode is
 * not: a same-origin `cors` request yields a readable `basic` response.
 *
 * If the busted request fails or is refused (a host or WAF that rejects
 * unknown query parameters), the page's own request is tried once, so the
 * page is never worse off than before; that copy is stored as it used to be.
 */
async function fetchRefill(
  request: Request,
  resourceKey: string,
  entry: ResourceEntry,
): Promise<Response> {
  let busted: Request | null = null;
  try {
    const url = new URL(request.url);
    url.hash = '';
    busted = new Request(cacheBustUrl(url.href, entry.hash), {
      cache: 'reload',
      credentials: request.credentials,
      headers: request.headers,
    });
  } catch (error) {
    console.warn(`[SW] Could not build refill request for ${resourceKey}:`, error);
  }
  if (!busted) return fetchWithRetry(request);

  try {
    const response = await fetchWithRetry(busted);
    if (response.ok) return response;
    console.warn(
      `[SW] Refill of ${resourceKey} by hash answered HTTP ${response.status}; ` +
        'retrying with the page request',
    );
    try {
      response.body?.cancel().catch(() => undefined);
    } catch {
      // Nothing to release.
    }
  } catch (error) {
    console.warn(
      `[SW] Refill of ${resourceKey} by hash failed; retrying with the page request:`,
      error,
    );
  }
  return fetchWithRetry(request, 1);
}
