import 'package:sw_example/src/cache/cache_snapshot.dart';

/// There is no service worker outside the browser.
Future<CacheSnapshot> readCacheSnapshot() async => const CacheSnapshot();

/// Nothing to clear outside the browser.
Future<void> clearCachesAndReload() async {}

/// Links open only in the browser.
void openLink(String url) {}
