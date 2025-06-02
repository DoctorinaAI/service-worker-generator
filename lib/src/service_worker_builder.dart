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
      'const BATCH_SIZE      = 6; // Optimal batch size for parallel downloads\n'
      'const MAX_CONCURRENT  = 6; // Maximum concurrent fetch operations\n'
      'const INSTALL_BATCH_SIZE = 4; // Batch size for install phase (more conservative)\n'
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

// Semaphore to limit concurrent fetch operations
class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.currentCount = 0;
    this.waitingQueue = [];
  }

  async acquire() {
    if (this.currentCount < this.maxConcurrent) {
      this.currentCount++;
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.waitingQueue.push(resolve);
    });
  }

  release() {
    this.currentCount--;
    if (this.waitingQueue.length > 0) {
      const resolve = this.waitingQueue.shift();
      this.currentCount++;
      resolve();
    }
  }
}

const fetchSemaphore = new Semaphore(MAX_CONCURRENT);

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
    );    // Pre-cache with parallel processing and progress tracking
    const batches = [];

    for (let i = 0; i < requests.length; i += INSTALL_BATCH_SIZE) {
      batches.push(requests.slice(i, i + INSTALL_BATCH_SIZE));
    }    for (const batch of batches) {
      // Process each batch in parallel using Promise.allSettled for better error handling
      const results = await Promise.allSettled(
        batch.map(async request => {
          try {
            const resourceKey = getResourceKey(request);
            const resourceInfo = RESOURCES[resourceKey];

            await fetchWithProgress(request, TEMP_CACHE);

            await notifyClients({
              resourceName: resourceInfo?.name || resourceKey,
              resourceUrl: request.url,
              resourceKey: resourceKey,
              resourceSize: resourceInfo?.size || 0,
              loaded: resourceInfo?.size || 0,
              status: 'completed'
            });

            return { success: true, resourceKey };
          } catch (error) {
            console.warn(`Failed to pre-cache ${request.url}:`, error);
            return { success: false, resourceKey: getResourceKey(request), error };
          }
        })
      );

      // Log batch completion for debugging
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.length - successful;
      console.log(`Install batch completed: ${successful} successful, ${failed} failed`);

      // Log individual failures for debugging
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`Batch item ${index} was rejected:`, result.reason);
        } else if (!result.value.success) {
          console.warn(`Failed to cache ${result.value.resourceKey}:`, result.value.error);
        }
      });
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
  if (event.data === 'sw-download-offline-force') {
    /**
     * Force download all CORE resources, even if already cached
     */
    downloadOffline(true);
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
 * Creates a response with a timestamp header for cache management.
 * @param {Response} response - The original response (should be cloned before calling this).
 * @param {number} timestamp - The timestamp to add.
 * @returns {Response} - The response with timestamp header.
 */
function createTimestampedResponse(response, timestamp = Date.now()) {
  const headers = new Headers(response.headers);
  headers.set('SW-Fetched-At', timestamp.toString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
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
      const timestampedResponse = createTimestampedResponse(response.clone());
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

    // Acquire semaphore to limit concurrent requests
    await fetchSemaphore.acquire();

    try {
      const response = await fetch(request);
      if (response.type === 'opaque') {
        // Always cache opaque responses with timestamp
        const timestampedResponse = createTimestampedResponse(response.clone(), timestamp);
        cache.put(request, timestampedResponse.clone());

        // Notify progress for opaque responses
        const resourceKey = getResourceKey(request);
        const resourceInfo = RESOURCES[resourceKey];
        if (resourceInfo) {
          await notifyClients({
            resourceName: resourceInfo.name || resourceKey,
            resourceUrl: request.url,
            resourceKey: resourceKey,
            resourceSize: resourceInfo.size || 0,
            loaded: resourceInfo.size || 0,            status: 'completed'
          });
        }
        fetchSemaphore.release();
        return response;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // If response is not a stream, cache it directly
      if (!response.body) {
        const timestampedResponse = createTimestampedResponse(response.clone(), timestamp);

        // Put the response in cache with timestamp
        cache.put(request, timestampedResponse.clone());

        const resourceKey = getResourceKey(request);
        const resourceInfo = RESOURCES[resourceKey];
        if (resourceInfo) {
          await notifyClients({
            resourceName: resourceInfo.name || resourceKey,
            resourceUrl: request.url,
            resourceKey: resourceKey,
            resourceSize: resourceInfo.size || 0,
            loaded: resourceInfo.size || 0,
            status: 'completed'
          });        }

        fetchSemaphore.release();
        return response;
      }      // Clone the response before reading the body
      const responseClone = response.clone();

      // Stream response and cache chunks
      const stream = new ReadableStream({
        start(controller) {
          reader = responseClone.body.getReader();
          let loaded = 0;
          const resourceKey = getResourceKey(request);
          const resourceInfo = RESOURCES[resourceKey];

          function read() {
            reader.read().then(({ done, value }) => {
              if (done) {
                controller.close();
                // Final progress notification
                if (resourceInfo) {
                  notifyClients({
                    resourceName: resourceInfo.name || resourceKey,
                    resourceUrl: request.url,
                    resourceKey: resourceKey,
                    resourceSize: resourceInfo.size || 0,
                    loaded: resourceInfo.size || loaded,
                    status: 'completed'
                  });
                }
                return;
              }
              loaded += value.byteLength;
              controller.enqueue(value);

              // Progress notification during streaming (throttled)
              if (resourceInfo && loaded % 8192 === 0) { // Throttle progress updates
                notifyClients({
                  resourceName: resourceInfo.name || resourceKey,
                  resourceUrl: request.url,
                  resourceKey: resourceKey,
                  resourceSize: resourceInfo.size || 0,
                  loaded: loaded,
                  status: 'downloading'
                });
              }

              read();
            }).catch(err => {
              if (reader) reader.cancel();
              controller.error(err);
            });
          }
          read();
        }
      });

      // Create timestamped response for streaming
      const newResp = createTimestampedResponse(new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }), timestamp);

      cache.put(request, newResp.clone());
      fetchSemaphore.release();
      return response;
    } catch (err) {
      console.warn(`Fetch attempt ${attempt} failed for ${request.url}:`, err);
      if (reader) reader.cancel();
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    } finally {
      // Always release semaphore
      fetchSemaphore.release();
    }
  }
}

/**
 * Pre-cache all CORE resources for offline usage.
 * @param {boolean} force - Force download even if already cached
 */
async function downloadOffline(force = false) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedKeys = (await cache.keys()).map(r => getResourceKey(r));

    // Determine which resources to download
    let resourcesToDownload;
    if (force) {
      // Force mode: download all CORE resources
      resourcesToDownload = CORE;
      console.log(`Force downloading all ${CORE.length} resources...`);
    } else {
      // Normal mode: only download missing resources
      resourcesToDownload = CORE.filter(path => !cachedKeys.includes(path));
      if (resourcesToDownload.length === 0) {
        console.log('All resources already cached');
        return true;
      }
      console.log(`Downloading ${resourcesToDownload.length} missing resources...`);
    }

    let totalLoaded = 0;

    // Calculate already loaded size (only in normal mode)
    if (!force) {
      for (const path of CORE) {
        if (cachedKeys.includes(path)) {
          const resourceInfo = RESOURCES[path];
          if (resourceInfo) {
            totalLoaded += resourceInfo.size;
          }
        }
      }
    }

    // Handle batches to avoid large atomic operations
    for (let i = 0; i < resourcesToDownload.length; i += BATCH_SIZE) {
      const batch = resourcesToDownload.slice(i, i + BATCH_SIZE);

      // Use Promise.allSettled for better error handling
      const results = await Promise.allSettled(
        batch.map(async path => {
          try {
            const request = new Request(new URL(path, self.location.origin), { cache: 'reload' });
            await fetchWithProgress(request, CACHE_NAME);
            return { success: true, path };
          } catch (error) {
            console.error(`Failed to cache ${path}:`, error);
            return { success: false, path, error };
          }
        })
      );

      // Process results and count successful downloads
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.length - successful;
      console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} completed: ${successful} successful, ${failed} failed`);

      // Calculate loaded size for progress tracking
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value.success) {
          const resourceInfo = RESOURCES[result.value.path];
          if (resourceInfo) {
            totalLoaded += resourceInfo.size;
          }
        }
      });
    }

    const mode = force ? 'force' : 'normal';
    console.log(`Downloaded ${resourcesToDownload.length} resources for offline use (${mode} mode)`);
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
  const now = Date.now();
  const requests = await cache.keys();

  // Process requests in parallel to check expiration
  const expiredRequests = await Promise.all(
    requests.map(async request => {
      try {
        const resp = await cache.match(request);
        const fetched = parseInt(resp.headers.get('SW-Fetched-At') || '0', 10);
        return (now - fetched > ttl) ? request : null;
      } catch (err) {
        console.warn('Error checking cache entry expiration:', err);
        return null;
      }
    })
  );

  // Filter out null values and delete expired entries in parallel
  const toDelete = expiredRequests.filter(req => req !== null);
  if (toDelete.length > 0) {
    await Promise.allSettled(
      toDelete.map(request => cache.delete(request))
    );
    console.log(`Expired ${toDelete.length} cache entries from ${cacheName}`);
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
 * Check if a resource is already cached and valid.
 * @param {string} resourceKey - The resource key to check.
 * @param {string} cacheName - The cache name to check in.
 * @returns {Promise<boolean>} - True if resource is cached and valid.
 */
async function isResourceCached(resourceKey, cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const request = new Request(new URL(resourceKey === '/' ? resourceKey : `/${resourceKey}`, self.location.origin));
    const cached = await cache.match(request, { ignoreSearch: true });

    if (!cached) return false;

    // Check if cached version matches current hash
    const currentResource = RESOURCES[resourceKey];
    if (!currentResource) return false;

    // For now, assume cached resources are valid
    // In the future, we could add hash comparison here
    return true;
  } catch (err) {
    console.warn(`Error checking cache for ${resourceKey}:`, err);
    return false;
  }
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
