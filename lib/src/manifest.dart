import 'dart:convert';
import 'dart:io' as io;

import 'categorizer.dart';
import 'files.dart';

/// A single resource entry in the manifest.
class ResourceEntry {
  /// Create a resource entry.
  const ResourceEntry({
    required this.name,
    required this.size,
    required this.hash,
    required this.category,
  });

  /// File basename.
  final String name;

  /// File size in bytes.
  final int size;

  /// MD5 hash.
  final String hash;

  /// Caching category.
  final ResourceCategory category;

  /// Convert to a JSON-serializable map.
  Map<String, dynamic> toJson() => {
    'name': name,
    'size': size,
    'hash': hash,
    'category': category.name,
  };
}

/// Generate a resource manifest from files in a directory.
///
/// Returns a map of relative path → [ResourceEntry].
Future<Map<String, ResourceEntry>> generateManifest({
  required io.Directory directory,
  required FileCategorizer categorizer,
  required Set<String> includeGlobs,
  required Set<String> excludeGlobs,
}) async {
  final files = filesInDirectory(
    directory,
    include: includeGlobs,
    exclude: excludeGlobs,
  );

  final manifest = <String, ResourceEntry>{};

  for (final entry in files.entries) {
    final path = entry.key;
    final file = entry.value;
    final stat = file.statSync();
    final size = stat.size;
    final hash = await md5(file);
    final category = categorizer.categorize(path, size);

    // Skip ignore category from manifest entirely
    if (category == ResourceCategory.ignore) continue;

    manifest[path] = ResourceEntry(
      name: file.uri.pathSegments.last,
      size: size,
      hash: hash,
      category: category,
    );
  }

  return manifest;
}

/// Serialize manifest to JSON string.
String manifestToJson(Map<String, ResourceEntry> manifest) {
  final map = <String, dynamic>{};
  for (final entry in manifest.entries) {
    map[entry.key] = entry.value.toJson();
  }
  return jsonEncode(map);
}
