'use strict';

// ---------------------------
// Version & Cache Names
// ---------------------------
const CACHE_PREFIX    = 'app-cache'; // prefix for all caches
const CACHE_VERSION   = '1748522997108'; // bump this on every release
const CACHE_NAME      = `${CACHE_PREFIX}-${CACHE_VERSION}`; // primary content cache
const TEMP_CACHE      = `${CACHE_PREFIX}-temp-${CACHE_VERSION}`; // temporary cache for atomic updates
const MANIFEST_CACHE  = `${CACHE_PREFIX}-manifest`; // stores previous manifest (no version suffix)
const RUNTIME_CACHE   = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`; // cache for runtime/dynamic content
const RUNTIME_ENTRIES = 50; // max entries in runtime cache
const CACHE_TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
const MEDIA_EXT       = /\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|json|jsonp)$/i
const RESOURCES_SIZE  = 4933; // total size of all resources in bytes

// ---------------------------
// Resource Manifest with MD5 hash 
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

// CORE resources to pre-cache during install
const CORE = Object.keys(RESOURCES);

// ---------------------------
// Install: Pre-cache CORE into TEMP
// ---------------------------
self.addEventListener('install', event => {
  // Activate new SW immediately without waiting for clients to close
  self.skipWaiting();
  event.waitUntil(
    caches.open(TEMP_CACHE)
      .then(cache => cache.addAll(
        CORE.map(path => new Request(path, { cache: 'reload' }))
      ))
  );
});

// ---------------------------
// Activate: Populate content cache & clean up old caches
// ---------------------------
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const origin = self.location.origin + '/';
    const validCaches = [
      CACHE_NAME,
      TEMP_CACHE,
      MANIFEST_CACHE,
      RUNTIME_CACHE
    ];

    // 1) Delete any old caches not in our allowlist
    await Promise.all(
      (await caches.keys())
        .filter(key => !validCaches.includes(key))
        .map(key => caches.delete(key))
    );

    // 2) Open all needed caches in parallel
    const [contentCache, tempCache, manifestCache] = await Promise.all([
      caches.open(CACHE_NAME),
      caches.open(TEMP_CACHE),
      caches.open(MANIFEST_CACHE)
    ]);

    // 3) Read the old manifest (if any)
    const manifestResponse = await manifestCache.match('manifest');
    const oldManifest = manifestResponse
      ? await manifestResponse.json()
      : {};

    // 4) Remove outdated entries from content cache
    await Promise.all(
      (await contentCache.keys())
        .filter(request => {
          const key = request.url.replace(origin, '') || '/';
          return RESOURCES[key]?.hash !== oldManifest[key]?.hash;
        })
        .map(request => contentCache.delete(request))
    );

    // 5) Populate content cache with files from TEMP
    await Promise.all(
      (await tempCache.keys())
        .map(async request => {
          const response = await tempCache.match(request);
          return contentCache.put(request, response.clone());
        })
    );

    // 6) Save the new manifest and clean up TEMP
    await manifestCache.put('manifest', new Response(JSON.stringify(RESOURCES)));
    await caches.delete(TEMP_CACHE);

    // 7) Immediately take control of all clients
    self.clients.claim();
  })());
});

// ---------------------------
// Fetch: Routing & Caching Strategies
// ---------------------------
self.addEventListener('fetch', event => {
  event.respondWith((async () => {
    const request = event.request;

    // 1) Bypass non-GET requests
    if (request.method !== 'GET') {
      return fetch(request);
    }

    // 2) Normalize URL: strip origin, leading slash, and ignore query params
    const url = new URL(request.url);
    let key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    if (key === '') key = '/';

    // 3) Cache-first strategy for known static resources
    if (RESOURCES[key]?.hash) {
      return cacheFirst(request);
    }

    // 4) Online-first strategy for navigation requests (SPA shell)
    if (request.mode === 'navigate') {
      return onlineFirst(request);
    }

    // 5) Runtime cache for images and JSON responses
    if (MEDIA_EXT.test(key)) {
      return runtimeCache(request);
    }

    // 6) Default: fetch from network
    return fetch(request);
  })());
});

// ---------------------------
// Message: skipWaiting & downloadOffline
// ---------------------------
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (event.data === 'downloadOffline') {
    downloadOffline();
  }
});

// ---------------------------
// Helpers
// ---------------------------

/**
 * Cache-first strategy:
 *  - Return cached response if available
 *  - Otherwise fetch from network, cache it, and return it
 * This is used for static resources
 * to ensure fast loading and offline availability.
 * If the network fetch fails,
 * it returns a 503 response indicating a network error.
 *
 * @param {Request} request - The request to handle.
 * @returns {Promise<Response>} - The cached response or fetched response.
 */
async function cacheFirst(request) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetchWithTimeout(request);
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    } catch (fetchErr) {
      console.error('Fetch failed:', fetchErr);
      return new Response('Network error', { status: 503 });
    }
  } catch (err) {
    console.error('Cache error:', err);
    return fetch(request);
  }
}

/**
 * Online-first strategy (for SPA navigation):
 *  - Attempt network fetch and cache the result
 *  - On failure, fall back to cache.match(request) or to index.html
 * This is used for navigation requests
 * to ensure the latest version is served when online.
 * If the network fails, it falls back to the cached version.
 * @param {Request} request - The request to handle.
 * @returns {Promise<Response>} - The response from the network or cache.
 */
async function onlineFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
      return response;
    }
    throw new Error('Network failed');
  } catch (err) {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || (await cache.match('index.html'));
  }
}

/**
 * Trim cache to a maximum number of entries
 * This function removes the oldest entries
 * until the cache size is within the specified limit.
 * @param {string} cacheName - The name of the cache to trim.
 * @param {number} maxEntries - The maximum number of entries to keep in the cache.
 * @returns {Promise<void>}
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  let keys = await cache.keys();
  while (keys.length > maxEntries) {
    await cache.delete(keys[0]);
    keys = await cache.keys();
  }
}

/**
 * Runtime caching with TTL and entry trimming:
 *  - Expire entries older than CACHE_TTL
 *  - Return cached if available
 *  - Otherwise fetch, cache, trim cache size, and return
 * This is used for dynamic content like images, API responses, etc.
 * @param {Request} request - The request to handle.
 */
async function runtimeCache(request) {
  try {
    const cache = await caches.open(RUNTIME_CACHE);

    await expireCache(RUNTIME_CACHE, CACHE_TTL); // Check expiration first

    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response && response.ok) {
        cache.put(request, response.clone());
        // Optionally trim cache to a max number of entries
        await trimCache(RUNTIME_CACHE, RUNTIME_ENTRIES);
      }
      return response;
    } catch (fetchErr) {
      console.error('Runtime cache fetch failed:', fetchErr);
      return new Response('Network error', { status: 503 });
    }
  } catch (err) {
    console.error('Runtime cache error:', err);
    return fetch(request);
  }
}

/**
 * Downloads all CORE resources that are not yet cached
 * This is used to ensure that the app can work offline
 * by pre-caching essential resources.
 * @returns {Promise<void>}
 */
async function downloadOffline() {
  const contentCache = await caches.open(CACHE_NAME);
  const currentKeys = (await contentCache.keys()).map(req =>
    req.url.substring(self.location.origin.length + 1) || '/'
  );
  const toDownload = CORE.filter(key => !currentKeys.includes(key));
  return contentCache.addAll(toDownload);
}

/**
 * Expire cache entries older than the given TTL (in milliseconds).
 * This function checks the 'date' header of each cached response
 * and removes entries that are older than the specified TTL.
 * @param {string} cacheName - The name of the cache to expire entries from.
 * @param {number} ttl - The time-to-live in milliseconds.
 * @return {Promise<void>}
 */
async function expireCache(cacheName, ttl) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const now = Date.now();

  return Promise.all(
    keys.map(async (request) => {
      // Get the response to check its timestamp
      const response = await cache.match(request);
      const responseHeaders = new Headers(response.headers);
      const dateHeader = responseHeaders.get('date') || responseHeaders.get('Date');

      // If we can't determine age, or if it's too old, remove it
      if (dateHeader) {
        const timestamp = new Date(dateHeader).getTime();
        if (now - timestamp > ttl) {
          return cache.delete(request);
        }
      }
    })
  );
}

/**
 * Fetch with timeout support
 * This function wraps the fetch API to allow for a timeout.
 * If the request takes longer than the specified timeout,
 * it will abort the request and throw an error.
 * @param {Request} request - The request to fetch.
 * @param {number} timeout - The timeout in milliseconds (default: 8000).
 * @return {Promise<Response>} - The response from the fetch.
 */
async function fetchWithTimeout(request, timeout = 8000) {
  const controller = new AbortController();
  const signal = controller.signal;

  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(request, { signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw error;
  }
}

/**
 * Send progress notification to all clients
 * @param {Object} data - Progress notification data
 * @returns {Promise<void>}
 */
async function notifyClients(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(client => {
    client.postMessage({
      type: 'progress',
      timestamp: Date.now(),
      ...data
    });
  });
}