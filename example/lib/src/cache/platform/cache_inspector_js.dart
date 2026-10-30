import 'dart:js_interop';

import 'package:sw_example/src/cache/cache_snapshot.dart';
import 'package:web/web.dart' as web;

/// Prefix of this app's caches: the generator's default.
const String _cachePrefix = 'app-cache';

/// Read the state of the worker and its caches.
///
/// Every part may be unavailable (a private window, an insecure origin), and
/// a demo panel must not take the app down over it, so each one degrades on
/// its own.
Future<CacheSnapshot> readCacheSnapshot() async {
  final scriptUrl = web.window.navigator.serviceWorker.controller?.scriptURL;
  return CacheSnapshot(
    controlled: scriptUrl != null,
    version: scriptUrl == null
        ? null
        : Uri.parse(scriptUrl).queryParameters['v'],
    files: await _storedFiles(),
    usageBytes: await _usageBytes(),
  );
}

Future<Set<String>> _storedFiles() async {
  final files = <String>{};
  try {
    final base = web.document.baseURI;
    final caches = web.window.caches;
    for (final name in (await caches.keys().toDart).toDart) {
      final cacheName = name.toDart;
      if (!cacheName.startsWith(_cachePrefix) ||
          cacheName.endsWith('-manifest') ||
          cacheName.contains('-temp-')) {
        continue;
      }
      final cache = await caches.open(cacheName).toDart;
      for (final request in (await cache.keys().toDart).toDart) {
        final url = request.url;
        files.add(url.startsWith(base) ? url.substring(base.length) : url);
      }
    }
  } on Object {
    // CacheStorage is not available here: nothing to show.
  }
  return files;
}

Future<int?> _usageBytes() async {
  try {
    return (await web.window.navigator.storage.estimate().toDart).usage;
  } on Object {
    return null;
  }
}

/// Delete this app's caches and reload, as if the browser had evicted them.
Future<void> clearCachesAndReload() async {
  try {
    final caches = web.window.caches;
    for (final name in (await caches.keys().toDart).toDart) {
      if (name.toDart.startsWith(_cachePrefix)) {
        await caches.delete(name.toDart).toDart;
      }
    }
  } on Object {
    // Reload anyway: the page is still good.
  }
  web.window.location.reload();
}

/// Open [url] in a new tab.
void openLink(String url) => web.window.open(url, '_blank', 'noopener');
