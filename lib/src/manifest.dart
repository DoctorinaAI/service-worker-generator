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
///
/// Files are categorised from their path and size first, and only the ones
/// that stay in the manifest are read and hashed: an `ignore` entry is
/// dropped anyway, so hashing it (a large video under `assets/`, say) only
/// cost time and memory. [onIgnored] is called with the path and size of
/// every file that was left out as `ignore`.
Future<Map<String, ResourceEntry>> generateManifest({
  required io.Directory directory,
  required FileCategorizer categorizer,
  required Set<String> includeGlobs,
  required Set<String> excludeGlobs,
  void Function(String path, int size)? onIgnored,
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
    final size = file.statSync().size;
    final category = categorizer.categorize(path, size);

    // Skip ignore category from manifest entirely
    if (category == ResourceCategory.ignore) {
      onIgnored?.call(path, size);
      continue;
    }

    manifest[path] = ResourceEntry(
      name: file.uri.pathSegments.last,
      size: size,
      hash: await md5(file),
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
