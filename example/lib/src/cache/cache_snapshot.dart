import 'package:flutter/foundation.dart';

/// What the browser holds for this app at one moment.
@immutable
class CacheSnapshot {
  /// Creates a snapshot.
  const CacheSnapshot({
    this.controlled = false,
    this.version,
    this.files = const <String>{},
    this.usageBytes,
  });

  /// Whether a service worker controls this page.
  final bool controlled;

  /// Version in the controlling worker's URL, if it has one.
  final String? version;

  /// Stored files, as paths relative to the base href.
  final Set<String> files;

  /// Storage the origin uses, when the browser reports it.
  final int? usageBytes;

  @override
  bool operator ==(Object other) =>
      other is CacheSnapshot &&
      other.controlled == controlled &&
      other.version == version &&
      other.usageBytes == usageBytes &&
      setEquals(other.files, files);

  @override
  int get hashCode =>
      Object.hash(controlled, version, usageBytes, files.length);
}
