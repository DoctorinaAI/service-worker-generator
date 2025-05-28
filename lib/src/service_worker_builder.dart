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
    'const CACHE_PREFIX    = \'$cachePrefix\'; // prefix for all caches\n'
    'const CACHE_VERSION   = \'$cacheVersion\'; // bump this on every release\n'
    'const CACHE_NAME      = `\${CACHE_PREFIX}-\${CACHE_VERSION}`; // primary content cache\n'
    'const TEMP_CACHE      = `\${CACHE_PREFIX}-temp-\${CACHE_VERSION}`; // temporary cache for atomic updates\n'
    'const MANIFEST_CACHE  = `\${CACHE_PREFIX}-manifest`; // stores previous manifest (no version suffix)\n'
    'const RUNTIME_CACHE   = `\${CACHE_PREFIX}-runtime-\${CACHE_VERSION}`; // cache for runtime/dynamic content\n'
    'const RUNTIME_ENTRIES = 50; // max entries in runtime cache\n'
    'const CACHE_TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds\n'
    'const MEDIA_EXT       = /\\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|json|jsonp)\$/i\n'
    'const RESOURCES_SIZE  = ${resources.values.fold<int>(0, (total, obj) => switch (obj) {
      <String, Object?>{'size': int size} when size > 0 => total + size,
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
''';
