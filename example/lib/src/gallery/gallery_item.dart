import 'dart:convert';

import 'package:flutter/foundation.dart';

/// Largest image the generator categorizes as Optional. A bigger one is left
/// out of the worker's manifest, and so out of the cache.
const int optionalImageLimitBytes = 512 * 1024;

/// One picture in the gallery.
@immutable
class GalleryItem {
  /// Creates an item.
  const GalleryItem({
    required this.asset,
    required this.title,
    required this.bytes,
  });

  /// Reads `assets/data/gallery.json`.
  static List<GalleryItem> parseAll(String json) => (jsonDecode(json) as List)
      .cast<Map<String, Object?>>()
      .map(
        (item) => GalleryItem(
          asset: item['asset']! as String,
          title: item['title']! as String,
          bytes: item['bytes']! as int,
        ),
      )
      .toList(growable: false);

  /// Path declared in `pubspec.yaml`.
  final String asset;

  /// Name shown on the tile.
  final String title;

  /// Size of the file.
  final int bytes;

  /// Where Flutter serves the asset, relative to the base href. This is also
  /// the worker's cache key.
  String get cacheKey => 'assets/$asset';

  /// Whether the worker can store this file at all.
  bool get cacheable => bytes <= optionalImageLimitBytes;

  /// File format, as a label.
  String get format {
    final extension = asset.substring(asset.lastIndexOf('.') + 1);
    return extension.toUpperCase();
  }
}

/// [bytes] for a person to read.
String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}
