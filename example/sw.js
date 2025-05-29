'use strict';

// ---------------------------
// Version & Cache Names
// ---------------------------
const CACHE_PREFIX    = 'app-cache'; // Prefix for all caches
const CACHE_VERSION   = '1748524806187'; // Bump this on every release
const CACHE_NAME      = `${CACHE_PREFIX}-${CACHE_VERSION}`; // Primary content cache
const TEMP_CACHE      = `${CACHE_PREFIX}-temp-${CACHE_VERSION}`; // Temporary cache for atomic updates
const MANIFEST_CACHE  = `${CACHE_PREFIX}-manifest`; // Stores previous manifest (no version suffix)
const RUNTIME_CACHE   = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`; // Cache for runtime/dynamic content
const RUNTIME_ENTRIES = 50; // Max entries in runtime cache
const CACHE_TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
const MEDIA_EXT       = /\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|json|jsonp)$/i;
const RESOURCES_SIZE  = 14341; // total size of all resources in bytes

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
  "sw.js": {
    "name": "sw.js",
    "size": 9408,
    "hash": "a7f17089e7c356de3718b29fb6c6adbe"
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
// Install Event: Pre-cache CORE into TEMP_CACHE
// Triggered when the service worker is installed.
// ---------------------------
self.addEventListener('install', event => {
  // Activate this SW immediately, bypassing waiting phase
  self.skipWaiting();
  event.waitUntil(
    caches.open(TEMP_CACHE)
      .then(cache => cache.addAll(
        CORE.map(path => new Request(path, { cache: 'reload' }))
      ))
  );
});

// ---------------------------
// Activate Event: Populate content cache & clean up old caches
// Triggered when the SW takes over control (after installation).
// ---------------------------
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const origin = self.location.origin + '/';
    const validCaches = [ CACHE_NAME, TEMP_CACHE, MANIFEST_CACHE, RUNTIME_CACHE ];

    // 1) Delete old caches not in allowlist
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(key => !validCaches.includes(key))
          .map(key => caches.delete(key))
    );

    // 2) Open needed caches in parallel
    const [contentCache, tempCache, manifestCache] = await Promise.all([
      caches.open(CACHE_NAME),
      caches.open(TEMP_CACHE),
      caches.open(MANIFEST_CACHE)
    ]);

    // 3) Read previous manifest (if exists)
    const manifestResp = await manifestCache.match('manifest');
    const oldManifest = manifestResp ? await manifestResp.json() : {};

    // 4) Remove outdated entries from contentCache
    const contentKeys = await contentCache.keys();
    await Promise.all(
      contentKeys
        .filter(req => {
          const key = req.url.replace(origin, '') || '/';
          return RESOURCES[key]?.hash !== oldManifest[key]?.hash;
        })
        .map(req => contentCache.delete(req))
    );

    // 5) Populate contentCache with TEMP_CACHE entries
    const tempKeys = await tempCache.keys();
    await Promise.all(
      tempKeys.map(async req => {
        const resp = await tempCache.match(req);
        return contentCache.put(req, resp.clone());
      })
    );

    // 6) Save new manifest and remove TEMP_CACHE
    await manifestCache.put('manifest', new Response(JSON.stringify(RESOURCES)));
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
  event.respondWith((async () => {
    const request = event.request;

    // Bypass non-GET requests entirely
    if (request.method !== 'GET') {
      return fetch(request);
    }

    // Normalize URL to resource key
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
 *  - Otherwise fetch from network, cache it, and return it
 * Sends a single notification with progress: 100 for cache,
 * or file size for network.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function cacheFirst(request) {
  const key = getResourceKey(request);
  const meta = RESOURCES[key] || {};
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
      // Notify clients: resource served from cache
      notifyClients({ resource: { path: key, ...meta }, source: 'cache' });
      return cached;
    }

    // Notify clients: starting network fetch
    notifyClients({ resource: { path: key, ...meta }, source: 'network', progress: 0 });

    const response = await fetchWithTimeout(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      // Notify clients: network fetch completed
      notifyClients({ resource: { path: key, ...meta }, source: 'network', progress: 100 });
    }
    return response;
  } catch (err) {
    console.error('cacheFirst error:', err);
    // Fallback to network if cache logic fails
    return fetch(request);
  }
}

/**
 * Online-first strategy (for SPA navigation):
 *  - Attempt network fetch and cache result
 *  - On failure, fall back to cache or index.html
 * @param {Request} request
 * @returns {Promise<Response>}
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
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || (await cache.match('index.html'));
  }
}

/**
 * Trim cache to a maximum number of entries.
 * Removes oldest entries when limit exceeded.
 * @param {string} cacheName
 * @param {number} maxEntries
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
 * Notifies clients about network fetch stages.
 * @param {Request} request
 */
async function runtimeCache(request) {
  const key = getResourceKey(request);
  const meta = RESOURCES[key] || {};
  try {
    const cache = await caches.open(RUNTIME_CACHE);

    // Expire old entries before new request
    await expireCache(RUNTIME_CACHE, CACHE_TTL);

    const cached = await cache.match(request);
    if (cached) {
      notifyClients({ resource: { path: key, ...meta }, source: 'cache', progress: 100 });
      return cached;
    }

    notifyClients({ resource: { path: key, ...meta }, source: 'network', progress: 0 });
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      await trimCache(RUNTIME_CACHE, RUNTIME_ENTRIES);
      notifyClients({ resource: { path: key, ...meta }, source: 'network', progress: 100 });
    }
    return response;
  } catch (err) {
    console.error('runtimeCache error:', err);
    return fetch(request);
  }
}

/**
 * Downloads all CORE resources that are not yet cached.
 * Used to ensure full offline support.
 */
async function downloadOffline() {
  const contentCache = await caches.open(CACHE_NAME);
  const current = (await contentCache.keys()).map(req =>
    req.url.substring(self.location.origin.length + 1) || '/'
  );
  const missing = CORE.filter(key => !current.includes(key));
  return contentCache.addAll(missing);
}

/**
 * Expire cache entries older than TTL based on "Date" header.
 * @param {string} cacheName
 * @param {number} ttl
 */
async function expireCache(cacheName, ttl) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const now = Date.now();
  await Promise.all(
    keys.map(async request => {
      const response = await cache.match(request);
      const dateHeader = response.headers.get('date') || response.headers.get('Date');
      if (dateHeader && now - new Date(dateHeader).getTime() > ttl) {
        await cache.delete(request);
      }
    })
  );
}

/**
 * Fetch with timeout support.
 * @param {Request} request
 * @param {number} timeout Timeout in ms (default: 8000)
 * @throws {Error} on timeout or fetch error
 */
async function fetchWithTimeout(request, timeout = 8000) {
  const controller = new AbortController();
  const signal = controller.signal;
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(request, { signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    if (error.name === 'AbortError') throw new Error('Request timed out');
    throw error;
  }
}

/**
 * Normalize request URL to a key that matches RESOURCES entries.
 * @param {Request} request
 * @returns {string} Normalized resource key (e.g. '/', 'index.html')
 */
function getResourceKey(request) {
  const url = new URL(request.url);
  let key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
  return key === '' ? '/' : key;
}

/**
 * Send notification to all connected clients.
 * Clients should listen for 'message' events and handle 'sw-progress'.
 * @param {Object} data - { resource, source, progress, timestamp }
 */
async function notifyClients(data) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true });
  allClients.forEach(client => {
    client.postMessage({ type: 'sw-progress', timestamp: Date.now(), ...data });
  });
}