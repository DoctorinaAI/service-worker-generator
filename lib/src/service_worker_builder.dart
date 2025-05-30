// ignore_for_file: lines_longer_than_80_chars

import 'dart:convert' show JsonEncoder;

/// Builds a service worker script with the given parameters.
String buildServiceWorker({
  String cachePrefix = 'app-cache',
  String cacheVersion = '1.0.0',
  Map<String, Object?> resources = const <String, Object?>{},
}) {
  final resourcesSize = resources.entries.fold<int>(
    0,
    (total, obj) => switch (obj) {
      // Exclude the root path from size calculation, as it represents the app itself
      MapEntry<String, Object?>(key: '/') => total,
      // For other entries, sum their sizes if they are valid and greater than zero
      MapEntry<String, Object?>(value: <String, Object?>{'size': int size})
          when size > 0 =>
        total + size,
      // Otherwise, just return the accumulated total as is
      _ => total,
    },
  );
  return '\'use strict\';\n'
      '\n'
      '// ---------------------------\n'
      '// Version & Cache Names\n'
      '// ---------------------------\n'
      'const CACHE_PREFIX    = \'$cachePrefix\'; // Prefix for all caches\n'
      'const CACHE_VERSION   = \'$cacheVersion\'; // Bump this on every release\n'
      'const CACHE_NAME      = `\${CACHE_PREFIX}-\${CACHE_VERSION}`; // Primary content cache\n'
      'const TEMP_CACHE      = `\${CACHE_PREFIX}-temp-\${CACHE_VERSION}`; // Temporary cache for atomic updates\n'
      'const MANIFEST_CACHE  = `\${CACHE_PREFIX}-manifest`; // Stores previous manifest (no version suffix)\n'
      'const MANIFEST_KEY    = \'__sw-manifest__\'; // Key (URL) under which manifest is stored\n'
      'const RUNTIME_CACHE   = `\${CACHE_PREFIX}-runtime-\${CACHE_VERSION}`; // Cache for runtime/dynamic content\n'
      '\n'
      '// ---------------------------\n'
      '// Limits & Timeouts\n'
      '// ---------------------------\n'
      'const RUNTIME_ENTRIES = 50; // Max entries in runtime cache\n'
      'const CACHE_TTL       = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds\n'
      'const EXPIRE_INTERVAL = 300 * 1000; // Expire runtime cache every 300 seconds\n'
      'const MAX_RETRIES     = 3; // Number of retry attempts\n'
      'const RETRY_DELAY     = 500; // Delay between retries in milliseconds\n'
      '\n'
      '// ---------------------------\n'
      '// Patterns\n'
      '// ---------------------------\n'
      'const MEDIA_EXT       = /\\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|json|jsonp)\$/i;\n'
      'const NETWORK_ONLY    = /\\.(php|ashx|api)\$/i; // Always fetch from network\n'
      'const RANGE_REQUEST   = /bytes=/i; // Range request pattern\n'
      '\n'
      '// ---------------------------\n'
      '// Resource Manifest with MD5 hash and file sizes\n'
      '// ---------------------------\n'
      'const RESOURCES_SIZE  = $resourcesSize; // total size of all resources in bytes\n'
      'const RESOURCES = '
      '${const JsonEncoder.withIndent('  ').convert(resources)}\n'
      '\n'
      '// CORE resources to pre-cache during install (deduplicated, map "index.html" → "/")\n'
      'const CORE = Array.from(new Set(Object.keys(RESOURCES).map(k => k === \'index.html\' ? \'/\' : k)));\n'
      '\n'
      // Body of the service worker script
      '${_serviceWorkerBody.trim()}';
}

const String _serviceWorkerBody = r'''
let lastExpire = 0;  // Timestamp of last expiration (throttled)
let isExpiring = false;

// ---------------------------
// Install Event
// Pre-cache CORE resources into TEMP_CACHE
// ---------------------------
self.addEventListener('install', event => {
  /**
   * Trigger skipWaiting to activate new SW immediately
   */
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(TEMP_CACHE);
    const requests = CORE.map(path =>
      new Request(new URL(path, self.location.origin), { cache: 'reload' })
    );

    // Pre-cache with progress tracking
    for (const request of requests) {
      try {
        const resourceKey = getResourceKey(request);
        const resourceInfo = RESOURCES[resourceKey];
        await fetchWithProgress(request, TEMP_CACHE);
        await notifyClients({
          resourceName: resourceInfo.name,
          resourceUrl: request.url,
          resourceKey: resourceKey,
          resourceSize: resourceInfo.size,
          loaded: resourceInfo.size,
          status: 'completed'
        });
      } catch (error) {
        console.warn(`Failed to pre-cache ${request.url}:`, error);
      }
    }
  })());
});

// ---------------------------
// Activate Event
// Populate content cache, cleanup old caches, save manifest
// ---------------------------
self.addEventListener('activate', event => {
  /**
   * During activation, restore TEMP_CACHE to CONTENT_CACHE,
   * cleanup old versions and manage manifest.
   */
  event.waitUntil((async () => {
    const origin = self.location.origin + '/';
    try {
      // Remove outdated caches
      const keep = [CACHE_NAME, TEMP_CACHE, MANIFEST_CACHE, RUNTIME_CACHE];
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(key => !keep.includes(key)).map(key => caches.delete(key))
      );

      // Open required caches
      const contentCache   = await caches.open(CACHE_NAME);
      const tempCache      = await caches.open(TEMP_CACHE);
      const manifestCache  = await caches.open(MANIFEST_CACHE);

      // Load old manifest
      const manifestReq    = new Request(MANIFEST_KEY);
      const oldManifestResp= await manifestCache.match(manifestReq);
      const oldManifest    = oldManifestResp ? await oldManifestResp.json() : {};

      // Delete changed resources
      await Promise.all(
        (await contentCache.keys())
          .filter(req => {
            const key = getResourceKey(req);
            return RESOURCES[key]?.hash !== oldManifest[key]?.hash;
          })
          .map(req => contentCache.delete(req))
      );

      // Copy from tempCache to contentCache
      await Promise.all(
        (await tempCache.keys()).map(async req => {
          const resp = await tempCache.match(req);
          await contentCache.put(req, resp.clone());
        })
      );

      // Save new manifest
      await manifestCache.put(manifestReq, new Response(JSON.stringify(RESOURCES)));
    } catch (e) {
      console.error('Activate failed:', e);
    } finally {
      // Always clean up temp cache and claim clients
      await caches.delete(TEMP_CACHE);
      await self.clients.claim();
    }
  })());
});

// ---------------------------
// Fetch Event
// Routing & caching strategies with offline fallback
// ---------------------------
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Handle Range requests (for media playback)
  if (request.headers.has('range')) {
    // Don't use cache for range requests, go to network
    event.respondWith(fetch(request));
    return;
  }

  // Throttled expiration of runtime cache
  maybeExpire();

  event.respondWith((async () => {
    const key = getResourceKey(request);

    // 0) Network-only resources: always fetch from network
    if (NETWORK_ONLY.test(key)) {
      return fetch(request);
    }

    // 1) Pre-cached resources: cache-first
    if (RESOURCES[key]) {
      return cacheFirst(request);
    }

    // 2) SPA navigation: online-first with offline.html fallback
    if (request.mode === 'navigate') {
      return onlineFirst(request);
    }

    // 3) Media & JSON: runtime cache
    if (MEDIA_EXT.test(key)) {
      return runtimeCache(request);
    }

    // 4) Other requests: direct fetch
    return fetch(request);
  })());
});

// ---------------------------
// Message Event
// Handle skipWaiting and downloadOffline commands
// ---------------------------
self.addEventListener('message', event => {
  if (event.data === 'sw-skip-waiting') {
    /**
     * Force the waiting service worker to become the active one
     */
    self.skipWaiting();
  }
  if (event.data === 'sw-download-offline') {
    /**
     * Pre-cache all CORE resources for offline usage
     */
    downloadOffline();
  }
});

// ===========================
// Utility Functions
// ===========================

/**
 * Throttles runtime cache expiration to run at most once per EXPIRE_INTERVAL.
 */
function maybeExpire() {
  const now = Date.now();
  if (isExpiring || (now - lastExpire) < EXPIRE_INTERVAL) return;
  lastExpire = now;
  isExpiring = true;
  expireCache(RUNTIME_CACHE, CACHE_TTL)
    .catch(err => console.error('expireCache failed:', err))
    .finally(() => { isExpiring = false; });
}

/**
 * Cache-first strategy for critical resources.
 * @param {Request} request The fetch request.
 * @returns {Promise<Response>}
 */
async function cacheFirst(request) {
  const key   = getResourceKey(request);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    return await fetchWithProgress(request, CACHE_NAME);
  } catch {
    // Fallback to network if streaming fails
    return fetch(request);
  }
}

/**
 * Online-first strategy for SPA navigation.
 * Falls back to offline.html if network and cache miss.
 * @param {Request} request The navigation request.
 * @returns {Promise<Response>}
 */
async function onlineFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      // Add timestamp header when caching navigation responses
      const headers = new Headers(response.headers);
      headers.set('SW-Fetched-At', Date.now().toString());
      const timestampedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
      cache.put(request, timestampedResponse.clone());
    }
    return response;
  } catch {
    // On failure, try cache, then offline.html, else error
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const offline = await cache.match('offline.html');
    if (offline) return offline;
    return Response.error();
  }
}

/**
 * Runtime caching for non-critical resources (images, JSON).
 * @param {Request} request The fetch request.
 * @returns {Promise<Response>}
 */
async function runtimeCache(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetchWithProgress(request, RUNTIME_CACHE);
  await trimCache(RUNTIME_CACHE, RUNTIME_ENTRIES);
  return response;
}

/**
 * Fetch with retry logic and streaming progress caching.
 * @param {Request} request The fetch request.
 * @param {string} cacheName Name of cache to store in.
 * @returns {Promise<Response>}
 */
async function fetchWithProgress(request, cacheName) {
  let attempt = 0;
  const cache = await caches.open(cacheName);
  const timestamp = Date.now();

  while (attempt < MAX_RETRIES) {
    attempt++;
    let reader = null;
    try {
      const response = await fetch(request);
      if (response.type === 'opaque') {
        // Always cache opaque responses with timestamp
        const headers = new Headers(response.headers);
        headers.set('SW-Fetched-At', timestamp.toString());
        const timestampedResponse = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        });
        cache.put(request, timestampedResponse.clone()); // Notify progress for opaque responses
        const resourceKey = getResourceKey(request);
        const resourceInfo = RESOURCES[resourceKey];
        if (resourceInfo) {
          await notifyClients({
            resourceName: resourceInfo.name,
            resourceUrl: request.url,
            resourceKey: resourceKey,
            resourceSize: resourceInfo.size,
            loaded: resourceInfo.size,
            status: 'fetching'
          });
        }

        return response;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // If response is not a stream, cache it directly
      if (!response.body) {
        const headers = new Headers(response.headers);
        headers.set('SW-Fetched-At', timestamp.toString());
        const timestampedResponse = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: headers
        });

        // Put the response in cache with timestamp
        cache.put(request, timestampedResponse.clone());

        const resourceKey = getResourceKey(request);
        const resourceInfo = RESOURCES[resourceKey];
        if (resourceInfo) {
          await notifyClients({
            resourceName: resourceInfo.name,
            resourceUrl: request.url,
            resourceKey: resourceKey,
            resourceSize: resourceInfo.size,
            loaded: resourceInfo.size,
            status: 'fetching'
          });
        }

        return timestampedResponse;
      }

      // Stream response and cache chunks
      const stream = new ReadableStream({
        start(controller) {
          reader = response.body.getReader();
          let loaded = 0;
          function read() {
            reader.read().then(({ done, value }) => {
              if (done) {
                controller.close();
                // Final progress notification
                const resourceKey = getResourceKey(request);
                const resourceInfo = RESOURCES[resourceKey];
                if (resourceInfo) {
                  notifyClients({
                    resourceName: resourceInfo.name,
                    resourceUrl: request.url,
                    resourceKey: resourceKey,
                    resourceSize: resourceInfo.size,
                    loaded: resourceInfo.size,
                    status: 'fetching'
                  });
                }
                return;
              }
              loaded += value.byteLength;
              controller.enqueue(value);

              // Progress notification during streaming
              const resourceKey = getResourceKey(request);
              const resourceInfo = RESOURCES[resourceKey];
              if (resourceInfo) {
                notifyClients({
                  resourceName: resourceInfo.name,
                  resourceUrl: request.url,
                  resourceKey: resourceKey,
                  resourceSize: resourceInfo.size,
                  loaded: loaded,
                  status: 'fetching'
                });
              }

              read();
            }).catch(err => {
              reader.cancel();
              controller.error(err);
            });
          }
          read();
        }
      });

      // Add timestamp header for streaming responses
      const headers = new Headers(response.headers);
      headers.set('SW-Fetched-At', timestamp.toString());
      const newResp = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
      cache.put(request, newResp.clone());
      return newResp;
    } catch (err) {
      console.warn(`Fetch attempt ${attempt} failed for ${request.url}:`, err);
      if (reader) reader.cancel();
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
}

/**
 * Pre-cache all CORE resources for offline usage.
 */
async function downloadOffline() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedKeys = (await cache.keys()).map(r => getResourceKey(r));
    const missing = CORE.filter(path => !cachedKeys.includes(path));
    if (missing.length === 0) {
      console.log('All resources already cached');
      // Don't send notification here as all resources are already tracked individually
      return true;
    }

    console.log(`Downloading ${missing.length} missing resources...`);
    let totalLoaded = 0;

    // Calculate already loaded size
    for (const path of CORE) {
      if (cachedKeys.includes(path)) {
        const resourceInfo = RESOURCES[path];
        if (resourceInfo) {
          totalLoaded += resourceInfo.size;
        }
      }
    }

    // Handle batches to avoid large atomic operations
    const BATCH_SIZE = 5;
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);

      // Use Promise.allSettled for better error handling
      const results = await Promise.allSettled(
        batch.map(async path => {
          try {
            const request = new Request(path);
            await fetchWithProgress(request, CACHE_NAME);
            return { success: true, path };
          } catch (error) {
            console.error(`Failed to cache ${path}:`, error);
            return { success: false, path, error };
          }
        })
      );

      // Process results
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value.success) {
          const resourceInfo = RESOURCES[result.value.path];
          if (resourceInfo) {
            totalLoaded += resourceInfo.size;
          }
        }
      });
    }
    console.log(`Downloaded ${missing.length} resources for offline use`);
    return true;
  } catch (error) {
    console.error('Failed to download offline resources:', error);
    return false;
  }
}

/**
 * Expire entries older than TTL from specified cache.
 * @param {string} cacheName Name of the cache.
 * @param {number} ttl Time-to-live in ms.
 */
async function expireCache(cacheName, ttl) {
  const cache = await caches.open(cacheName);
  const now   = Date.now();
  for (const request of await cache.keys()) {
    const resp = await cache.match(request);
    const fetched = parseInt(resp.headers.get('SW-Fetched-At') || '0', 10);
    if (now - fetched > ttl) {
      await cache.delete(request);
    }
  }
}

/**
 * Trim cache to a maximum number of entries by deleting oldest.
 * @param {string} cacheName Name of the cache.
 * @param {number} maxEntries Maximum allowed entries.
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const entries = await cache.keys();

  if (entries.length <= maxEntries) return;

  // Get all entries with their timestamps
  const entriesWithTime = await Promise.all(
    entries.map(async request => {
      const response = await cache.match(request);
      const fetched = parseInt(response.headers.get('SW-Fetched-At') || '0', 10);
      return { request, fetched };
    })
  );

  // Sort by timestamp (oldest first) and delete oldest
  entriesWithTime.sort((a, b) => a.fetched - b.fetched);
  const toDelete = entriesWithTime.slice(0, entriesWithTime.length - maxEntries);
  await Promise.all(toDelete.map(entry => cache.delete(entry.request)));
}

/**
 * Convert a Request or URL string to a normalized resource key.
 * Strips query and hash.
 * @param {Request|string} requestOrUrl
 * @returns {string}
 */
function getResourceKey(requestOrUrl) {
  const url = typeof requestOrUrl === 'string'
    ? new URL(requestOrUrl, self.location.origin)
    : new URL(requestOrUrl.url);
  url.hash = '';
  url.search = '';
  let key = url.pathname;
  if (key.startsWith('/')) key = key.slice(1);
  if (key.endsWith('/') && key !== '/') key = key.slice(0, -1);
  return key === '' ? '/' : key;
}

/**
 * Notify all clients with a message.
 * @param {object} data Payload to send.
 */
async function notifyClients(data) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true });
  allClients.forEach(client => {
    try {
      client.postMessage({
        type: 'sw-progress',
        timestamp: Date.now(),
        resourcesSize: RESOURCES_SIZE,
        ...data
      });
    } catch {}
  });
}
''';
