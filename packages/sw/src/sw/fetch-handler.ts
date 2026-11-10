import type { ResourceManifest, ResourceEntry } from '../shared/types';
import { ResourceCategory } from '../shared/types';
import {
  BODY_STALL_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  NAVIGATION_TIMEOUT_MS,
  NEVER_CACHE_FILES,
  RESERVED_PATH_PREFIXES,
} from '../shared/constants';
import {
  cacheBustUrl,
  getResourceKey,
  fetchWithRetry,
  guardBody,
  replayableResponse,
  withTimeout,
} from '../shared/utils';
import {
  expectedBodySize,
  lazyCacheResponse,
  getContentCacheName,
} from './cache-manager';
import { reportIfQuotaExceeded } from './quota';
import { hasPendingWorker } from './registration';
import type { ProgressReporter } from './progress';
import { log } from '../shared/logger';

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

/** Sentinel for a navigation the origin did not answer in time. */
const TOO_SLOW = Symbol('navigation-timeout');

/**
 * Whether [entry] is one of the files that decide which build of the app
 * runs: the pre-cached set — the Dart code, the engine's support files and
 * the manifests the engine reads before its first frame.
 *
 * Exactly the set an install downloads, so "what this worker pre-cached"
 * and "what it stops serving once a newer build is pending" are the same
 * list by construction.
 */
function isCodeEntry(entry: ResourceEntry): boolean {
  return (
    entry.category === ResourceCategory.Core ||
    entry.category === ResourceCategory.Required
  );
}

/**
 * Keep the worker alive for [work] without making the response wait for
 * it. Called while the promise handed to `respondWith` is still pending,
 * which is when `waitUntil` is allowed; should it throw anyway, the work
 * still runs, only without the lifetime extension.
 */
function keepAlive(event: FetchEvent, work: Promise<unknown>): void {
  try {
    event.waitUntil(work);
  } catch (error) {
    log.warn('[SW] waitUntil refused; the cache write runs unextended:', error);
  }
}

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

  // Requests this worker has no business answering. A navigation among
  // them still has to be answered: navigation preload has already started
  // a request for it, and a fetch event that ends without consuming
  // `preloadResponse` logs "The service worker navigation preload request
  // was cancelled before 'preloadResponse' settled" and throws that
  // response away. `passThrough` hands it back untouched — no retries, no
  // shell fallback, no cache — which is what not answering was meant to be.
  const isNavigation = request.mode === 'navigate';

  if (NEVER_CACHE_FILES.some((f) => resourceKey === f || resourceKey.endsWith(`/${f}`))) {
    if (isNavigation) event.respondWith(passThrough(event));
    return;
  }

  // Namespaces the host serves itself. Same origin, but not ours.
  if (RESERVED_PATH_PREFIXES.some((prefix) => resourceKey.startsWith(prefix))) {
    if (isNavigation) event.respondWith(passThrough(event));
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
  if (isNavigation || isShellRequest) {
    event.respondWith(
      networkFirst(event, cachePrefix, version, manifest, progress, isShellRequest),
    );
    return;
  }

  if (!entry || entry.category === ResourceCategory.Ignore) return;

  event.respondWith(
    cacheFirst(event, resourceKey, entry, cachePrefix, version, progress),
  );
}

/**
 * The response the browser would have produced on its own: the navigation
 * preload response when there is one, the request on the network otherwise.
 *
 * `fetch` is given the request itself, with no init: an init makes it a new
 * `Request`, whose mode is then `same-origin` rather than `navigate`, and
 * the origin stops seeing `Sec-Fetch-Mode: navigate`. A rejection here is a
 * failed navigation, exactly as a failed default fetch would be.
 */
async function passThrough(event: FetchEvent): Promise<Response> {
  const preload = (await event.preloadResponse) as Response | undefined;
  return preload ?? fetch(event.request);
}

/**
 * Network-first strategy for navigations and `index.html`.
 *
 * Prefers a navigationPreload response if available, then the request on
 * the network — `fetch(request)` with no init, so the request is never
 * rebuilt and keeps its `navigate` mode (the origin keeps seeing
 * `Sec-Fetch-Mode: navigate`, and a same-origin 3xx keeps arriving as the
 * opaque redirect the browser must follow).
 *
 * Falls back to the pre-cached app shell on a network error *or* a non-ok
 * status, so a broken origin cannot replace a good cached page — and, when
 * there is such a copy, after `NAVIGATION_TIMEOUT_MS`, rather than holding
 * a blank page while the origin thinks. Without a cached copy there is
 * nothing better to wait for, so the fetch is given as long as it takes,
 * exactly as a page with no worker would.
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

  // Read up front, because it decides how long the origin is given: with a
  // copy in hand a navigation waits `NAVIGATION_TIMEOUT_MS` and then boots
  // from it, and without one it waits for the network however long that
  // takes. The body is not read here, so this costs a cache lookup.
  let cached: Response | undefined;
  try {
    cached = await (await caches.open(cacheName)).match(new Request(INDEX_KEY));
  } catch (error) {
    log.warn('[SW] App-shell cache lookup failed:', error);
  }

  const fallbackToCache = async (): Promise<Response> => {
    if (cached) {
      // Not awaited: this is a navigation, and the document waits for it.
      keepAlive(event, notifyIndex('cached'));
      return cached;
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
    if (preload) {
      response = preload;
    } else {
      const network = fetch(request);
      const answered = cached
        ? await withTimeout(network, NAVIGATION_TIMEOUT_MS, TOO_SLOW)
        : await network;
      if (answered === TOO_SLOW) {
        log.warn(
          `[SW] The origin did not answer the navigation within ` +
            `${NAVIGATION_TIMEOUT_MS}ms; booting from the cached shell`,
        );
        return fallbackToCache();
      }
      response = answered;
    }
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

  // A newer build is pending, so this is its `index.html`. Storing it here
  // would pair the new shell with the previous build's code in one cache,
  // and that is the mix that cannot boot; the new worker's own install has
  // the matching copy. See `cacheFirst`.
  if (isShellRequest && !hasPendingWorker()) {
    // Stored in the background: the navigation gets the response at once,
    // and a shell body that stalls cannot hold the page — or, through
    // `replayableResponse`, which reads a redirected copy whole — hang
    // forever. The copy is cut after `BODY_STALL_TIMEOUT_MS` of silence.
    keepAlive(event, storeShell(cacheName, response.clone(), notifyIndex));
  }

  return response;
}

/**
 * Store a fresh copy of the app shell, then report the refresh.
 *
 * Never rejects. Quota pressure is routine for a wasm-sized app, and a
 * cache we could not write is a worse offline story, not a reason to fail
 * anything.
 */
async function storeShell(
  cacheName: string,
  copy: Response,
  notifyIndex: (status: 'updated') => Promise<void>,
): Promise<void> {
  let stored = false;
  try {
    const cache = await caches.open(cacheName);
    // Store a replayable copy: a response carrying the `redirected` flag
    // is rejected by the browser when it is later served for a
    // navigation, which would break exactly the offline load the
    // pre-cached shell exists for. The guard's rebuilt response already
    // drops the flag; `replayableResponse` stays as a backstop.
    await cache.put(
      new Request(INDEX_KEY),
      await replayableResponse(
        guardBody(copy, { idleMs: BODY_STALL_TIMEOUT_MS, label: INDEX_KEY }),
      ),
    );
    stored = true;
  } catch (error) {
    if (!reportIfQuotaExceeded(`writing ${INDEX_KEY}`, error)) {
      log.warn('[SW] App-shell cache write failed:', error);
    }
  }
  // Report the refresh only when it happened. Announcing an update we
  // failed to store would hide quota pressure from the one channel built
  // to surface resource state.
  if (stored) {
    try {
      await notifyIndex('updated');
    } catch (error) {
      log.warn('[SW] App-shell progress report failed:', error);
    }
  }
}

/**
 * Cache-first strategy for cached resources.
 *
 * Looks up the response in the current versioned content cache only. Cache
 * misses populate the cache for any category except `Ignore` so evicted or
 * partially-precached Core/Required resources self-heal.
 *
 * The page gets the network response as soon as its headers arrive; the
 * cache write runs beside it under `waitUntil`. Awaiting the write first
 * made the page wait for the whole download plus the store — the tee
 * buffering every byte the page had not read yet — and a body that stalled
 * on the refill of an evicted `main.dart.wasm` held the request forever.
 */
async function cacheFirst(
  event: FetchEvent,
  resourceKey: string,
  entry: ResourceEntry,
  cachePrefix: string,
  version: string,
  progress: ProgressReporter,
): Promise<Response> {
  const { request } = event;
  const cacheName = getContentCacheName(cachePrefix, version);

  // A newer build is already deployed, and this worker's cache holds the
  // previous one's code. The page asking is the new build's `index.html`
  // and `bootstrap.js` — both network-first, neither ever cached — so
  // answering `main.dart.js` from here runs the previous build's Dart code
  // inside the new build's page, until the next load hands over to the new
  // worker. Writing the new bytes into this cache is no better: they do not
  // have the size this manifest records for them, and the write fails.
  //
  // So the files that decide which build runs go to the network, and this
  // version's cache is left exactly as it is. Only those: a tab that has
  // been open since before the deploy keeps its lazily cached fonts and
  // images, which are not what makes it the build it is.
  const retired = isCodeEntry(entry) && hasPendingWorker();

  // An unusable CacheStorage (evicted, blocked by a privacy mode) must
  // degrade to a plain network fetch. Rejecting here would fail the
  // resource outright, and these are the files the app is made of.
  let cache: Cache | null = null;
  try {
    cache = await caches.open(cacheName);
    const cached = retired ? undefined : await cache.match(new Request(resourceKey));
    if (cached) {
      // Not awaited: `report` is a `clients.matchAll` round trip and a
      // broadcast to every open tab, and this is the path every font and
      // image takes on every load. The page gets the file; the telemetry
      // follows under `waitUntil`.
      keepAlive(
        event,
        progress.report({
          key: resourceKey,
          name: entry.name,
          url: request.url,
          size: entry.size,
          loaded: entry.size,
          status: 'cached',
        }),
      );
      return cached;
    }
  } catch (error) {
    log.warn(`[SW] Cache lookup failed for ${resourceKey}:`, error);
    cache = null;
  }

  /**
   * The copy a retired worker skipped, when the network could not be asked
   * at all — offline, or an origin mid-deploy. It is the previous build's,
   * which is why it was skipped; a page that boots on the previous build
   * still beats one that does not boot. `undefined` when there is none.
   */
  const lastResort = async (reason: string): Promise<Response | undefined> => {
    const stale = await cache
      ?.match(new Request(resourceKey))
      .catch(() => undefined);
    if (!stale) return undefined;
    log.warn(
      `[SW] ${resourceKey}: ${reason} while a newer build is installing; ` +
        "answering from this version's cache",
    );
    void progress.report({
      key: resourceKey,
      name: entry.name,
      url: request.url,
      size: entry.size,
      loaded: entry.size,
      status: 'cached',
    });
    return stale;
  };

  try {
    // Fire-and-forget, as above: awaiting it would hold the fetch that is
    // the point of this request behind a broadcast.
    keepAlive(
      event,
      progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: 0,
        status: 'loading',
      }),
    );

    // A retired worker asks for the page's own URL: `fetchRefill` would ask
    // for `?v={hash}` of the build *this* worker was generated for, and a
    // CDN that keys on the whole URL answers that with the file the hash
    // names — the very copy being replaced.
    const response =
      !retired && isCodeEntry(entry)
        ? await fetchRefill(request, resourceKey, entry)
        : await fetchWithRetry(request);

    if (retired && !response.ok) {
      const stale = await lastResort(`HTTP ${response.status}`);
      if (stale) return stale;
    }

    if (response.ok) {
      if (cache && !retired) {
        keepAlive(
          event,
          lazyCacheResponse(
            cacheName,
            new Request(resourceKey),
            response,
            expectedBodySize(resourceKey, entry),
          ).catch((error: unknown) => {
            if (!reportIfQuotaExceeded(`caching ${resourceKey}`, error)) {
              log.warn(`[SW] Cache write failed for ${resourceKey}:`, error);
            }
          }),
        );
      }

      keepAlive(
        event,
        progress.report({
          key: resourceKey,
          name: entry.name,
          url: request.url,
          size: entry.size,
          loaded: entry.size,
          status: 'completed',
        }),
      );
    } else {
      // Non-OK response is still a user-visible failure: emit an error
      // progress event so the bootstrap UI can surface it instead of
      // hanging on 'loading'.
      keepAlive(
        event,
        progress.report({
          key: resourceKey,
          name: entry.name,
          url: request.url,
          size: entry.size,
          loaded: 0,
          status: 'error',
          error: `HTTP ${response.status}`,
        }),
      );
    }

    return response;
  } catch (error) {
    if (retired) {
      const stale = await lastResort(
        error instanceof Error ? error.message : String(error),
      );
      if (stale) return stale;
    }
    keepAlive(
      event,
      progress.report({
        key: resourceKey,
        name: entry.name,
        url: request.url,
        size: entry.size,
        loaded: 0,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
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
    log.warn(`[SW] Could not build refill request for ${resourceKey}:`, error);
  }
  if (!busted) return fetchWithRetry(request);

  try {
    const response = await fetchWithRetry(
      busted,
      MAX_RETRY_ATTEMPTS,
      FETCH_TIMEOUT_MS,
      { retryOnStatus: true },
    );
    if (response.ok) return response;
    log.warn(
      `[SW] Refill of ${resourceKey} by hash answered HTTP ${response.status}; ` +
        'retrying with the page request',
    );
    try {
      response.body?.cancel().catch(() => undefined);
    } catch {
      // Nothing to release.
    }
  } catch (error) {
    log.warn(
      `[SW] Refill of ${resourceKey} by hash failed; retrying with the page request:`,
      error,
    );
  }
  return fetchWithRetry(request, 1);
}
