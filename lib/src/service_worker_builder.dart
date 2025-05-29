// ignore_for_file: lines_longer_than_80_chars

import 'dart:convert' show JsonEncoder;

/// Builds a service worker script with the given parameters.
String buildServiceWorker({
  String cachePrefix = 'app-cache',
  String cacheVersion = '1.0.0',
  Map<String, Object?> resources = const <String, Object?>{},
}) =>
    '\'use strict\';\n'
    '\n'
    '// ---------------------------\n'
    '// Version & Cache Names\n'
    '// ---------------------------\n'
    'const CACHE_PREFIX    = \'$cachePrefix\'; // Prefix for all caches\n'
    'const CACHE_VERSION   = \'$cacheVersion\'; // Bump this on every release\n'
    'const CACHE_NAME      = `\${CACHE_PREFIX}-\${CACHE_VERSION}`; // Primary content cache\n'
    'const TEMP_CACHE      = `\${CACHE_PREFIX}-temp-\${CACHE_VERSION}`; // Temporary cache for atomic updates\n'
    'const MANIFEST_CACHE  = `\${CACHE_PREFIX}-manifest`; // Stores previous manifest (no version suffix)\n'
    'const RUNTIME_CACHE   = `\${CACHE_PREFIX}-runtime-\${CACHE_VERSION}`; // Cache for runtime/dynamic content\n'
    'const RUNTIME_ENTRIES = 50; // Max entries in runtime cache\n'
    'const CACHE_TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds\n'
    'const MEDIA_EXT       = /\\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|json|jsonp)\$/i;\n'
    'const RESOURCES_SIZE  = ${resources.entries.fold<int>(0, (total, obj) => switch (obj) {
      // Exclude the root path from size calculation, as it represents the app itself
      MapEntry<String, Object?>(key: '/') => total,
      // For other entries, sum their sizes if they are valid and greater than zero
      MapEntry<String, Object?>(value: <String, Object?>{'size': int size}) when size > 0 => total + size,
      // Otherwise, just return the accumulated total as is
      _ => total,
    })}; // total size of all resources in bytes\n'
    '\n'
    '// ---------------------------\n'
    '// Resource Manifest with MD5 hash \n'
    '// ---------------------------\n'
    'const RESOURCES = '
    '${const JsonEncoder.withIndent('  ').convert(resources)}\n'
    '\n'
    '// CORE resources to pre-cache during install\n'
    'const CORE = Object.keys(RESOURCES);\n'
    '\n'
    '${_serviceWorkerBody.trim()}';

const String _serviceWorkerBody = '''
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
// Message Event: skipWaiting & downloadOffline
// Handles custom messages from clients.
// ---------------------------
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    // Force this SW to activate immediately
    self.skipWaiting();
  } else if (event.data === 'downloadOffline') {
    // Pre-cache all CORE resources for offline use
    downloadOffline();
  }
});

// ---------------------------
// Helpers and Utility Functions
// ---------------------------

/**
 * Cache-first strategy:
 *  - Return cached response if available
 *  - Otherwise fetch from network, cache it, and return it
 * Notifies clients about cache hits and network fetch stages.
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
    notifyClients({ resource: { path: key, ...meta }, source: 'network-start' });

    const response = await fetchWithTimeout(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      // Notify clients: network fetch completed
      notifyClients({ resource: { path: key, ...meta }, source: 'network-end' });
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
  } catch (err) {
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
      notifyClients({ resource: { path: key, ...meta }, source: 'cache' });
      return cached;
    }

    notifyClients({ resource: { path: key, ...meta }, source: 'network-start' });
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      await trimCache(RUNTIME_CACHE, RUNTIME_ENTRIES);
      notifyClients({ resource: { path: key, ...meta }, source: 'network-end' });
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

  return Promise.all(
    keys.map(async request => {
      const response = await cache.match(request);
      const dateHeader = response.headers.get('date') || response.headers.get('Date');
      if (dateHeader) {
        const age = now - new Date(dateHeader).getTime();
        if (age > ttl) {
          return cache.delete(request);
        }
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
    if (error.name === 'AbortError') {
      throw new Error('Request timed out');
    }
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
 * Send progress notification to all connected clients.
 * Clients should listen for 'message' events and handle 'progress' type.
 * @param {Object} data - Details about download progress
 */
async function notifyClients(data) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true });
  allClients.forEach(client => {
    client.postMessage({ type: 'progress', timestamp: Date.now(), ...data });
  });
}
''';
