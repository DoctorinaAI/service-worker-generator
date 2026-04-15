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
  const coreSet = <String>{
    'main.dart.wasm',
    'main.dart.js',
    'main.dart.mjs',
    'index.html',
    'assets/AssetManifest.bin.json',
    'assets/FontManifest.json',
  };
  final core = resources.keys.where(coreSet.contains).toList(growable: false);
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
      '\n'
      '// ---------------------------\n'
      '// Resource Manifest with MD5 hash and file sizes\n'
      '// ---------------------------\n'
      'const RESOURCES_SIZE  = $resourcesSize; // total size of all resources in bytes\n'
      'const RESOURCES = '
      '${const JsonEncoder.withIndent('  ').convert(resources)};\n'
      '\n'
      '// CORE resources to pre-cache during install (deduplicated, map "index.html" → "/")\n'
      'const CORE = ${const JsonEncoder.withIndent('  ').convert(core)};\n'
      '\n'
      // Body of the service worker script
      '${_serviceWorkerBody.trim()}';
}

// ignore: unnecessary_raw_strings
const String _serviceWorkerBody = r'''
// ---------------------------
// Install Event
// Pre-cache CORE resources into TEMP_CACHE.
// ---------------------------
self.addEventListener("install", (event) => {
  self.skipWaiting();
  return event.waitUntil(
    caches.open(TEMP_CACHE).then((cache) => {
      return cache.addAll(
        CORE.map((value) => new Request(value, {'cache': 'reload'})));
    })
  );
});

// ---------------------------
// Activate Event
// Populate content cache, cleanup old/stale caches, save manifest.
// ---------------------------
self.addEventListener("activate", function(event) {
  return event.waitUntil(async function() {
    try {
      var contentCache = await caches.open(CACHE_NAME);
      var tempCache = await caches.open(TEMP_CACHE);
      var manifestCache = await caches.open(MANIFEST_CACHE);
      var manifest = await manifestCache.match(MANIFEST_KEY);

      // When there is no prior manifest, clear the entire cache.
      if (!manifest) {
        await caches.delete(CACHE_NAME);
        contentCache = await caches.open(CACHE_NAME);

        const tempKeys = await tempCache.keys();
        for (let i = 0; i < tempKeys.length; i++) {
          const request = tempKeys[i];
          const resourceKey = getResourceKey(request);
          const resourceInfo = RESOURCES[resourceKey] || RESOURCES['/'];

          var response = await tempCache.match(request);
          await contentCache.put(request, response);

          notifyClients({
            resourceName: resourceInfo?.name || resourceKey,
            resourceUrl: request.url,
            resourceKey: resourceKey,
            resourceSize: resourceInfo?.size || 0,
            loaded: resourceInfo?.size || 0,
            status: 'completed'
          });
        }

        await caches.delete(TEMP_CACHE);
        await manifestCache.put(MANIFEST_KEY, new Response(JSON.stringify(RESOURCES)));
      } else {
        var oldManifest = await manifest.json();
        var origin = self.location.origin;

        // Clean up outdated resources whose MD5 hash changed
        const contentKeys = await contentCache.keys();
        for (var request of contentKeys) {
          var key = request.url.substring(origin.length + 1);
          if (key == "") key = "/";
          if (!RESOURCES[key] || RESOURCES[key]?.hash != oldManifest[key]?.hash) {
            await contentCache.delete(request);
          }
        }

        // Populate cache with TEMP files, overwriting preserved entries
        const tempKeys = await tempCache.keys();
        for (let i = 0; i < tempKeys.length; i++) {
          const request = tempKeys[i];
          const resourceKey = getResourceKey(request);
          const resourceInfo = RESOURCES[resourceKey] || RESOURCES['/'];

          var response = await tempCache.match(request);
          await contentCache.put(request, response);

          notifyClients({
            resourceName: resourceInfo?.name || resourceKey,
            resourceUrl: request.url,
            resourceKey: resourceKey,
            resourceSize: resourceInfo?.size || 0,
            loaded: resourceInfo?.size || 0,
            status: 'updated'
          });
        }

        await caches.delete(TEMP_CACHE);
        await manifestCache.put(MANIFEST_KEY, new Response(JSON.stringify(RESOURCES)));
      }

      // Clean up ALL stale caches with our prefix
      const allCaches = await caches.keys();
      await Promise.all(
        allCaches
          .filter(name =>
            name.startsWith(CACHE_PREFIX)
            && name !== CACHE_NAME
            && name !== MANIFEST_CACHE
            && name !== TEMP_CACHE)
          .map(name => caches.delete(name))
      );

      // Claim clients to enable caching on first launch
      self.clients.claim();
    } catch (err) {
      // On an unhandled exception the state of the cache cannot be guaranteed.
      console.error('Failed to upgrade service worker: ' + err);
      await caches.delete(CACHE_NAME);
      await caches.delete(TEMP_CACHE);
      await caches.delete(MANIFEST_CACHE);
      self.clients.claim();
    }
  }());
});

// ---------------------------
// Fetch Event
// Routing & caching strategies with offline fallback.
// ---------------------------
self.addEventListener("fetch", (event) => {
  if (event.request.method !== 'GET') return;

  var origin = self.location.origin;
  var resourceKey = getResourceKey(event.request);
  // Strip version query parameter
  if (resourceKey.indexOf('?v=') != -1) resourceKey = resourceKey.split('?v=')[0];
  if (event.request.url == origin || event.request.url.startsWith(origin + '/#') || resourceKey == '')
    resourceKey = '/';
  // If the URL is not in the RESOURCE list, let the browser handle it
  var resourceInfo = RESOURCES[resourceKey];
  if (!resourceInfo) return;

  // Online-first for index.html, cache-first for everything else
  if (resourceKey == '/') return onlineFirst(event);

  notifyClients({
    resourceName: resourceInfo?.name || resourceKey,
    resourceUrl: event.request.url,
    resourceKey: resourceKey,
    resourceSize: resourceInfo?.size || 0,
    loaded: 0,
    status: 'loading'
  });

  event.respondWith(caches.open(CACHE_NAME)
    .then((cache) => {
      return cache.match(event.request).then((response) => {
        // Serve from cache, or fetch with timeout and lazily populate cache
        return response || fetchWithTimeout(event.request).then((response) => {
          if (response && Boolean(response.ok)) {
            cache.put(event.request, response.clone());
            notifyClients({
              resourceName: resourceInfo?.name || resourceKey,
              resourceUrl: event.request.url,
              resourceKey: resourceKey,
              resourceSize: resourceInfo?.size || 0,
              loaded: resourceInfo?.size || 0,
              status: 'completed'
            });
          }
          return response;
        });
      })
    })
  );
});

// ---------------------------
// Message Event
// Handle skipWaiting and downloadOffline commands
// ---------------------------
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
    return;
  }
  if (event.data === 'downloadOffline') {
    downloadOffline();
    return;
  }
});

/**
 * Fetch with timeout protection using AbortController.
 * Rejects if the fetch takes longer than the specified timeout.
 * @param {Request|string} request
 * @param {number} timeout in milliseconds (default 10000)
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(request, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(request, { signal: controller.signal })
    .finally(() => clearTimeout(id));
}

/**
 * Pre-cache all RESOURCES for offline usage.
 */
async function downloadOffline() {
  var resources = [];
  var contentCache = await caches.open(CACHE_NAME);
  var currentContent = {};
  var origin = self.location.origin;

  for (var request of await contentCache.keys()) {
    var key = request.url.substring(origin.length + 1);
    if (key == "") {
      key = "/";
    }
    currentContent[key] = true;
  }

  for (var resourceKey of Object.keys(RESOURCES)) {
    if (!currentContent[resourceKey]) {
      resources.push(resourceKey);
    }
  }
  return contentCache.addAll(resources);
}

/**
 * Online-first strategy for index.html.
 * Attempts to fetch from network, falls back to cache.
 * @param {FetchEvent} event
 */
function onlineFirst(event) {
  var resourceKey = getResourceKey(event.request);
  var resourceInfo = RESOURCES[resourceKey] || RESOURCES['/'];

  return event.respondWith(
    fetchWithTimeout(event.request)
      .then((response) => {
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, response.clone());

          notifyClients({
            resourceName: resourceInfo?.name || resourceKey,
            resourceUrl: event.request.url,
            resourceKey: resourceKey,
            resourceSize: resourceInfo?.size || 0,
            loaded: resourceInfo?.size || 0,
            status: 'completed'
          });

          return response;
        });
      })
      .catch((error) => {
        return caches.open(CACHE_NAME).then((cache) => {
          return cache.match(event.request).then((response) => {
            if (response != null) {
              notifyClients({
                resourceName: resourceInfo?.name || resourceKey,
                resourceUrl: event.request.url,
                resourceKey: resourceKey,
                resourceSize: resourceInfo?.size || 0,
                loaded: resourceInfo?.size || 0,
                status: 'cached'
              });
              return response;
            }

            notifyClients({
              resourceName: resourceInfo?.name || resourceKey,
              resourceUrl: event.request.url,
              resourceKey: resourceKey,
              resourceSize: resourceInfo?.size || 0,
              loaded: 0,
              status: 'error',
              error: error.message
            });

            throw error;
          });
        });
      })
  );
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
