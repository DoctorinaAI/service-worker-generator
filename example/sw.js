'use strict';

// ---------------------------
// Version & Cache Names
// ---------------------------
const CACHE_PREFIX    = 'app-cache'; // Prefix for all caches
const CACHE_VERSION   = '1748529097602'; // Bump this on every release
const CACHE_NAME      = `${CACHE_PREFIX}-${CACHE_VERSION}`; // Primary content cache
const TEMP_CACHE      = `${CACHE_PREFIX}-temp-${CACHE_VERSION}`; // Temporary cache for atomic updates
const MANIFEST_CACHE  = `${CACHE_PREFIX}-manifest`; // Stores previous manifest (no version suffix)
const RUNTIME_CACHE   = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`; // Cache for runtime/dynamic content
const RUNTIME_ENTRIES = 50; // Max entries in runtime cache
const CACHE_TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
const MEDIA_EXT       = /\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|json|jsonp)$/i;
const RESOURCES_SIZE  = 4933; // total size of all resources in bytes
const MAX_RETRIES     = 3; // Number of retry attempts
const RETRY_DELAY     = 500; // Delay between retries in milliseconds

// ---------------------------
// Resource Manifest with MD5 hash and file sizes
// ---------------------------
const RESOURCES = {
  "/": {
    "name": "index.html",
    "size": 187,
    "hash": "0f4c8e436fbac5014b983bd3056446ca"
  },
  "assets/fonts/.keep": {
    "name": ".keep",
    "size": 0,
    "hash": "d41d8cd98f00b204e9800998ecf8427e"
  },
  "assets/locales/en.json": {
    "name": "en.json",
    "size": 26,
    "hash": "89eddd3a7b2b0e98e8517cc42d5a566c"
  },
  "assets/locales/es.json": {
    "name": "es.json",
    "size": 26,
    "hash": "25e96b8a7d11056eb2107e5a14effff1"
  },
  "assets/locales/ru.json": {
    "name": "ru.json",
    "size": 26,
    "hash": "5a06fa387d63082dcec81d79e27246ad"
  },
  "assets/packages/ui/.keep": {
    "name": ".keep",
    "size": 0,
    "hash": "d41d8cd98f00b204e9800998ecf8427e"
  },
  "assets/shaders/.keep": {
    "name": ".keep",
    "size": 0,
    "hash": "d41d8cd98f00b204e9800998ecf8427e"
  },
  "images/logo.svg": {
    "name": "logo.svg",
    "size": 4204,
    "hash": "ece57cbc962798de3939a812febf4bf3"
  },
  "index.html": {
    "name": "index.html",
    "size": 187,
    "hash": "0f4c8e436fbac5014b983bd3056446ca"
  },
  "manifest.json": {
    "name": "manifest.json",
    "size": 386,
    "hash": "aba78061b1880b83132330dc72818eed"
  },
  "version.json": {
    "name": "version.json",
    "size": 78,
    "hash": "56c50211c3a661a52e9d0d2f57f10af9"
  }
}

// CORE resources to pre-cache during install (deduplicated, map "index.html" → "/")
const CORE = Array.from(
  new Set(
    Object.keys(RESOURCES)
      .map(key => key === 'index.html' ? '/' : key)
  )
);

// ---------------------------
// Install Event: Pre-cache CORE into TEMP_CACHE
// Triggered when the service worker is installed.
// ---------------------------
self.addEventListener('install', event => {
  // Activate this SW immediately, bypassing waiting phase
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(TEMP_CACHE);
    // Pre-cache core resources with absolute URLs and reload to avoid browser cache
    await cache.addAll(
      CORE.map(path =>
        new Request(new URL(path, self.location.origin), { cache: 'reload' })
      )
    );
  })());
});

// ---------------------------
// Activate Event: Populate content cache & clean up old caches
// Triggered when the SW takes over control (after installation).
// ---------------------------
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const origin = self.location.origin + '/';
    const keep = [CACHE_NAME, TEMP_CACHE, MANIFEST_CACHE, RUNTIME_CACHE];

    // 1) Delete outdated caches in parallel
    const outdated = (await caches.keys()).filter(key => !keep.includes(key));
    await Promise.all(outdated.map(key => caches.delete(key)));

    // 2) Open needed caches
    const contentCache = await caches.open(CACHE_NAME);
    const tempCache = await caches.open(TEMP_CACHE);
    const manifestCache = await caches.open(MANIFEST_CACHE);

    // 3) Load old manifest in one shot
    const manifestReq = new Request('manifest');
    const manifestResp = await manifestCache.match(manifestReq);
    const oldManifest = manifestResp ? await manifestResp.json() : {};

    // 4) Remove outdated entries from contentCache
    const removalPromises = (await contentCache.keys())
      .filter(req => {
        const key = getResourceKey(req);
        return RESOURCES[key]?.hash !== oldManifest[key]?.hash;
      })
      .map(req => contentCache.delete(req));
    await Promise.all(removalPromises);

    // 5) Populate contentCache with tempCache entries
    const copyPromises = (await tempCache.keys()).map(async req => {
      const resp = await tempCache.match(req);
      await contentCache.put(req, resp.clone());
    });
    await Promise.all(copyPromises);

    // 6) Save new manifest and clean up temp cache
    await manifestCache.put(manifestReq, new Response(JSON.stringify(RESOURCES)));
    await caches.delete(TEMP_CACHE);

    // 7) Take control of uncontrolled clients immediately
    self.clients.claim();
  })());
});

// ---------------------------
// Fetch Event: Routing & Caching Strategies
// Determines response strategy for each request.
// ---------------------------
self.addEventListener('fetch', event => {
  const request = event.request;

  // Bypass non-GET requests entirely
  if (request.method !== 'GET') {
    return;
  }

  event.respondWith((async () => {
    const key = getResourceKey(request);

    // 1) Cache-first for known static RESOURCES
    if (RESOURCES[key]?.hash) {
      return cacheFirst(request);
    }

    // 2) Online-first for navigation requests (SPA shell)
    if (request.mode === 'navigate') {
      return onlineFirst(request);
    }

    // 3) Runtime caching for media (images, JSON, etc.)
    if (MEDIA_EXT.test(key)) {
      return runtimeCache(request);
    }

    // 4) Default: fetch from network
    return fetch(request);
  })());
});

// ---------------------------
// Message Event: Handles custom messages from clients.
// ---------------------------
self.addEventListener('message', event => {
  switch (event.data) {
    case 'sw-skip-waiting':
      // Force this SW to activate immediately
      self.skipWaiting();
      break;
    case 'sw-download-offline':
      // Pre-cache all CORE resources for offline use
      downloadOffline();
      break;
    default:
      // Unknown message type; no action
      break;
  }
});

// ---------------------------
// Helpers and Utility Functions
// ---------------------------

/**
 * Cache-first strategy:
 *  - Return cached response if available
 *  - Otherwise fetch (with progress, retries), cache it, and return it
 */
async function cacheFirst(request) {
  const key = getResourceKey(request);
  const meta = RESOURCES[key] || {};
  const cache = await caches.open(CACHE_NAME);

  const fromCache = await cache.match(request);
  if (fromCache) {
    // Notify clients: resource served from cache
    notifyClients({ resource: { path: key, ...meta }, source: 'cache', progress: 100 });
    return fromCache;
  }

  // Fetch from network, cache into CACHE_NAME, and notify clients
  return fetchWithProgress(request, meta, CACHE_NAME);
}

/**
 * Online-first strategy (for SPA navigation):
 *  - Attempt network fetch and cache result
 *  - On failure, fall back to cache or index.html
 */
async function onlineFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        const cache = await caches.open(CACHE_NAME);
        // Preserve status, statusText, headers
        const headers = new Headers(response.headers);
        headers.set('SW-Fetched-At', Date.now().toString());
        await cache.put(request, new Response(response.clone().body, {
          status: response.status,
          statusText: response.statusText,
          headers
        }));
      } catch (err) {
        console.error('Cache put error in onlineFirst:', err);
      }
      return response;
    }
    throw new Error('Network fetch failed');
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || (await cache.match('/'));
  }
}

/**
 * Runtime caching with TTL and entry trimming:
 *  - Expire entries older than CACHE_TTL
 *  - Return cached if available
 *  - Otherwise fetch (with progress, retries), cache, trim, and return
 */
async function runtimeCache(request) {
  const key = getResourceKey(request);
  const meta = RESOURCES[key] || {};
  const cache = await caches.open(RUNTIME_CACHE);

  // Expire old entries before new request
  await expireCache(RUNTIME_CACHE, CACHE_TTL);

  const fromCache = await cache.match(request);
  if (fromCache) {
    notifyClients({ resource: { path: key, ...meta }, source: 'cache', progress: 100 });
    return fromCache;
  }

  // Fetch & cache into RUNTIME_CACHE
  const response = await fetchWithProgress(request, meta, RUNTIME_CACHE);
  if (response.ok) {
    // Trim cache size if needed
    await trimCache(RUNTIME_CACHE, RUNTIME_ENTRIES);
  }
  return response;
}

/**
 * Fetch with byte-stream, progress updates & retry logic.
 * Automatically caches into specified cacheName.
 */
async function fetchWithProgress(request, meta, cacheName = CACHE_NAME) {
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await fetch(request);

      // 1) Handle opaque responses (cross-origin, no body access)
      if (response.type === 'opaque') {
        notifyClients({ resource: { path: getResourceKey(request), ...meta }, source: 'network', progress: 100 });
        // Cache opaque response without progress stream
        await caches.open(cacheName).then(c => c.put(request, response.clone()));
        return response;
      }

      const total = meta.size
        || parseInt(response.headers.get('content-length'), 10)
        || 0;

      // If there's no stream or no known size, bail out early
      if (!response.body || !total) {
        notifyClients({ resource: { path: getResourceKey(request), ...meta }, source: 'network', progress: 100 });
        const wrapped = new Response(response.clone().body, {
          status: response.status,
          statusText: response.statusText,
          headers: (() => {
            const h = new Headers(response.headers);
            h.set('SW-Fetched-At', Date.now().toString());
            return h;
          })()
        });
        await caches.open(cacheName).then(c => c.put(request, wrapped.clone()));
        return wrapped;
      }

      // Notify clients: download started
      notifyClients({ resource: { path: getResourceKey(request), ...meta }, source: 'network', progress: 0 });

      // Stream & report progress
      const reader = response.body.getReader();
      let loaded = 0;
      const stream = new ReadableStream({
        start(controller) {
          function read() {
            reader.read().then(({ done, value }) => {
              if (done) {
                controller.close();
                return;
              }
              loaded += value.byteLength;
              const pct = Math.round((loaded / total) * 100);
              notifyClients({ resource: { path: getResourceKey(request), ...meta }, source: 'network', progress: pct });
              controller.enqueue(value);
              read();
            }).catch(err => controller.error(err));
          }
          read();
        }
      });

      // Build new response with progress stream & metadata header
      const headers = new Headers(response.headers);
      headers.set('SW-Fetched-At', Date.now().toString());
      const newResp = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers
      });

      // Cache the streamed response
      await caches.open(cacheName).then(c => c.put(request, newResp.clone()));
      return newResp;
    } catch (err) {
      attempt++;
      console.warn(`Fetch ${request.url} attempt ${attempt} failed, retry in ${RETRY_DELAY}ms`, err);
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise(res => setTimeout(res, RETRY_DELAY));
    }
  }
}

/**
 * Downloads all CORE resources that are not yet cached.
 * Used to ensure full offline support.
 */
async function downloadOffline() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedKeys = (await cache.keys()).map(r => r.url.replace(self.location.origin + '/', ''));
    const missing = CORE.filter(path => !cachedKeys.includes(path));
    if (!missing.length) return;
    // Use absolute URL Requests for missing resources
    const requests = missing.map(path =>
      new Request(new URL(path, self.location.origin), { cache: 'reload' })
    );
    await cache.addAll(requests);
  } catch (err) {
    console.error('downloadOffline failed:', err);
  }
}

/**
 * Expire cache entries older than TTL based on SW-Fetched-At or standard headers.
 */
async function expireCache(cacheName, ttl) {
  const cache = await caches.open(cacheName);
  const now = Date.now();
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response) continue;
    const fetchedAt = response.headers.get('SW-Fetched-At');
    if (fetchedAt) {
      // Custom header-based expiration
      if (now - parseInt(fetchedAt, 10) > ttl) {
        await cache.delete(request);
      }
    } else {
      // Fallback: use Date/Last-Modified/Expires headers
      const dh = response.headers.get('Date')
        || response.headers.get('Last-Modified')
        || response.headers.get('Expires');
      if (dh && now - new Date(dh).getTime() > ttl) {
        await cache.delete(request);
      }
    }
  }
}

/**
 * Trim cache to a maximum number of entries.
 * Removes oldest entries when limit exceeded.
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // Delete oldest entries (front of array)
  const deleteCount = keys.length - maxEntries;
  await Promise.all(keys.slice(0, deleteCount).map(req => cache.delete(req)));
}

/**
 * Normalize request URL to a key that matches RESOURCES entries.
 * Strips query parameters & hash fragments, removes leading/trailing slashes.
 */
function getResourceKey(requestOrUrl) {
  const url = typeof requestOrUrl === 'string'
    ? new URL(requestOrUrl, self.location.origin)
    : new URL(requestOrUrl.url);
  let key = url.pathname;
  if (key.startsWith('/')) key = key.slice(1);
  if (key.endsWith('/') && key !== '/') key = key.slice(0, -1);
  return key === '' ? '/' : key;
}

/**
 * Send notification to all connected clients.
 * Clients should listen for 'message' events and handle 'sw-progress'.
 */
async function notifyClients(data) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true });
  allClients.forEach(client =>
    client.postMessage({ type: 'sw-progress', timestamp: Date.now(), ...data })
  );
}