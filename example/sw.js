'use strict';

// ---------------------------
// Version & Cache Names
// ---------------------------
const CACHE_PREFIX    = 'app-cache'; // Prefix for all caches
const CACHE_VERSION   = '1748528639909'; // Bump this on every release
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
      .then(cache => cache.addAll(CORE.map(path => new Request(path, { cache: 'reload' }))))
  );
});

// ---------------------------
// Activate Event: Populate content cache & clean up old caches
// Triggered when the SW takes over control (after installation).
// ---------------------------
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const origin = self.location.origin + '/';
    const keep = [CACHE_NAME, TEMP_CACHE, MANIFEST_CACHE, RUNTIME_CACHE];
    // Delete outdated caches
    const outdated = (await caches.keys()).filter(key => !keep.includes(key));
    await Promise.all(outdated.map(key => caches.delete(key)));
    // Open needed caches in parallel
    const [content, temp, manifest] = await Promise.all([
      caches.open(CACHE_NAME),
      caches.open(TEMP_CACHE),
      caches.open(MANIFEST_CACHE)
    ]);

    // Read previous manifest (if exists), or initialize empty
    const manifestExists = await manifest.match('manifest');
    const oldMan = manifestExists
      ? await manifestExists.json()
      : {};

    // Remove outdated entries from contentCache
    (await content.keys())
      .filter(req => {
        const k = req.url.replace(origin, '') || '/';
        return RESOURCES[k]?.hash !== oldMan[k]?.hash;
      })
      .forEach(req => content.delete(req));

    // Populate content with TEMP_CACHE entries
    await Promise.all(
      (await temp.keys()).map(async (req) => {
        content.put(req, (await temp.match(req)).clone())
      })
    );

    // Save new manifest and remove TEMP_CACHE
    await manifest.put('manifest', new Response(JSON.stringify(RESOURCES)));
    await caches.delete(TEMP_CACHE);

    // Take control of uncontrolled clients immediately
    self.clients.claim();
  })());
});

// ---------------------------
// Fetch Event: Routing & Caching Strategies
// Determines response strategy for each request.
// ---------------------------
self.addEventListener('fetch', event => {
  event.respondWith((async () => {
    const { request } = event;

    // Bypass non-GET requests entirely
    if (request.method !== 'GET') return fetch(request);

    // Normalize URL to resource key
    const key = getResourceKey(request);

    // 1) Cache-first for known static RESOURCES
    if (RESOURCES[key]?.hash) return cacheFirst(request);

    // 2) Online-first for navigation requests (SPA shell)
    if (request.mode === 'navigate') return onlineFirst(request);

    // 3) Runtime caching for media (images, JSON, etc.)
    if (MEDIA_EXT.test(key)) return runtimeCache(request);

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
  const cache = await caches.open(CACHE_NAME);
  const fromCache = await cache.match(request);
  if (fromCache) {
    // Notify clients: resource served from cache
    notifyClients({ resource: { path: key, ...meta }, source: 'cache', progress: 100 });
    return fromCache;
  }
  // Fetch from network, cache it, and notify clients with progress
  return fetchWithProgress(request, meta);
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
    const res = await fetch(request);
    if (res.ok) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, res.clone());
      } catch (err) {
        console.error('Cache put error:', err);
      }
      return res;
    }
    throw new Error('Network fetch failed');
  } catch {
    const c = await caches.open(CACHE_NAME);
    return (await c.match(request)) || (await c.match('/'));
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
  const cache = await caches.open(RUNTIME_CACHE);

  // Expire old entries before new request
  await expireCache(RUNTIME_CACHE, CACHE_TTL);
  const cached = await cache.match(request);
  if (cached) {
    notifyClients({ resource: { path: key, ...meta }, source: 'cache', progress: 100 });
    return cached;
  }
  const response = await fetchWithProgress(request, meta);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimCache(RUNTIME_CACHE, RUNTIME_ENTRIES);
  }
  return response;
}

/**
 * Fetch with byte-stream, progress & retries
 * @param {Request} request
 * @param {Object} meta - Resource metadata (size, hash)
 */
async function fetchWithProgress(request, meta) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const response = await fetch(request);

      // Handling for opaque responses (cross-origin without CORS)
      if (response.type === 'opaque') {
        // For opaque responses, we can't read the body or headers
        notifyClients({ resource: { path: getResourceKey(request), ...meta }, source: 'network', progress: 100 });
        // Still cache the response even though we can't examine it
        await caches.open(CACHE_NAME).then(c => c.put(request, response.clone()));
        return response;
      }

      const total = meta.size || parseInt(response.headers.get('content-length')) || 0;
      if (!response.body || !total) {
        // If no body or size, just return the response and notify clients
        notifyClients({ resource: { path: getResourceKey(request), ...meta }, source: 'network', progress: 100 });
        return response;
      }

      // Notify clients about the start of the download
      notifyClients({ resource: { path: getResourceKey(request), ...meta }, source: 'network', progress: 0 });

      // Create a stream to read the response body
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
      const newResp = new Response(stream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      });
      await caches.open(CACHE_NAME).then(c => c.put(request, newResp.clone()));
      return newResp;
    } catch (err) {
      attempt++;
      console.warn(`Fetch ${request.url}: attempt ${attempt} failed, retrying in ${RETRY_DELAY}ms...`, err);
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
  const c = await caches.open(CACHE_NAME);
  const keys = (await c.keys()).map(r => r.url.replace(self.location.origin + '/', ''));
  const missing = CORE.filter(k => !keys.includes(k));
  return c.addAll(missing);
}

/**
 * Expire cache entries older than TTL based on "Date" header.
 * @param {string} name
 * @param {number} ttl
 */
async function expireCache(name, ttl) {
  const c = await caches.open(name);
  const now = Date.now();
  const keys = await c.keys();
  for (const req of keys) {
    const r = await c.match(req);
    if (!r) continue; // Skip if no response found
    const dh = r.headers.get('Date') || r.headers.get('Last-Modified') || r.headers.get('Expires');
    // If no date header, skip expiration check
    if (dh && now - new Date(dh).getTime() > ttl) await c.delete(req);
  }
}

/**
 * Trim cache to a maximum number of entries.
 * Removes oldest entries when limit exceeded.
 * @param {string} name - Cache name to trim
 * @param {number} max - Maximum number of entries to keep
 */
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const deleteOps = [];

  if (keys.length <= max) return; // Early return if no trimming needed

  // Calculate how many to delete
  const toDelete = keys.length - max;

  // Delete oldest entries (at beginning of array)
  for (let i = 0; i < toDelete; i++) {
    deleteOps.push(cache.delete(keys[i]));
  }

  await Promise.all(deleteOps);
}

/**
 * Normalize request URL to a key that matches RESOURCES entries.
 * @param {Request} request
 * @returns {string} Normalized resource key (e.g. '/', 'index.html')
 */
function getResourceKey(request) {
  const url = new URL(request.url);
  // Strip query parameters and hash fragments
  let key = url.pathname;
  // Remove leading slash for consistency with resource keys
  key = key.startsWith('/') ? key.slice(1) : key;
  // Remove trailing slash except for root path
  if (key.endsWith('/') && key !== '/') {
    key = key.slice(0, -1);
  }
  // Handle empty path as root
  return key === '' ? '/' : key;
}

/**
 * Send notification to all connected clients.
 * Clients should listen for 'message' events and handle 'sw-progress'.
 * @param {Object} data - { resource, source, progress, timestamp }
 */
async function notifyClients(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(client => client.postMessage({ type: 'sw-progress', timestamp: Date.now(), ...data }));
}