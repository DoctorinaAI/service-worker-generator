import 'dart:io' as io;

import 'package:path/path.dart' as p;

import 'files.dart';

/// Files to remove from Flutter build output.
const List<String> _flutterFilesToRemove = [
  'flutter_bootstrap.js',
  'flutter_service_worker.js',
  'version.json',
  '.last_build_id',
];

/// Perform post-generation cleanup on the build directory.
///
/// Removes Flutter's deprecated bootstrap/SW files,
/// prunes unused canvaskit variants, optionally removes source-map
/// files, and updates index.html.
///
/// [canvaskitKeep] is the set of canvaskit files (relative to [buildDir])
/// that must be preserved — anything else under `canvaskit/` is deleted.
/// Pass an empty set to skip canvaskit pruning.
void cleanup({
  required io.Directory buildDir,
  required String swVersion,
  Set<String> canvaskitKeep = const {},
  bool keepMaps = false,
}) {
  // Remove Flutter files
  for (final filename in _flutterFilesToRemove) {
    final file = io.File(p.join(buildDir.path, filename));
    if (file.existsSync()) {
      file.deleteSync();
      io.stdout.writeln('  Removed $filename');
    }
  }

  // Remove source-map/symbol files unless --keep-maps
  if (!keepMaps) {
    _removeMapFiles(buildDir);
  }

  // Prune unused canvaskit variants
  if (canvaskitKeep.isNotEmpty) {
    _pruneCanvaskit(buildDir, canvaskitKeep);
  }

  // Update index.html: replace version placeholders
  _updateIndexHtml(buildDir, swVersion);
}

/// Recursively remove `.js.map`, `.js.symbols`, and `.wasm.map` files.
void _removeMapFiles(io.Directory dir) {
  final files = dir
      .listSync(recursive: true, followLinks: false)
      .whereType<io.File>()
      .where(
        (f) =>
            f.path.endsWith('.js.map') ||
            f.path.endsWith('.js.symbols') ||
            f.path.endsWith('.wasm.map'),
      );

  for (final file in files) {
    file.deleteSync();
  }
}

/// Remove files under `canvaskit/` that are not in [keep].
/// Also removes any empty subdirectories left behind.
void _pruneCanvaskit(io.Directory buildDir, Set<String> keep) {
  final canvaskitDir = io.Directory(p.join(buildDir.path, 'canvaskit'));
  if (!canvaskitDir.existsSync()) return;

  var removed = 0;
  final buildUrl = pathToUrl(buildDir.path);
  for (final entity in canvaskitDir.listSync(recursive: true)) {
    if (entity is! io.File) continue;
    final relative = p.url.relative(pathToUrl(entity.path), from: buildUrl);
    if (keep.contains(relative)) continue;
    entity.deleteSync();
    removed++;
  }

  // Remove now-empty directories (deepest first).
  final dirs =
      canvaskitDir
          .listSync(recursive: true, followLinks: false)
          .whereType<io.Directory>()
          .toList()
        ..sort((a, b) => b.path.length.compareTo(a.path.length));
  for (final d in dirs) {
    if (d.listSync().isEmpty) d.deleteSync();
  }

  if (removed > 0) {
    io.stdout.writeln('  Pruned $removed unused canvaskit file(s)');
  }
}

/// Update index.html with version placeholders.
void _updateIndexHtml(io.Directory buildDir, String version) {
  final indexFile = io.File(p.join(buildDir.path, 'index.html'));
  if (!indexFile.existsSync()) return;

  var content = indexFile.readAsStringSync();
  var modified = false;

  // Replace {{sw_version}} placeholder
  if (content.contains('{{sw_version}}')) {
    content = content.replaceAll('{{sw_version}}', version);
    modified = true;
  }

  // Replace Flutter's deprecated placeholder
  if (content.contains('{{flutter_service_worker_version}}')) {
    content = content.replaceAll('{{flutter_service_worker_version}}', version);
    modified = true;
  }

  if (modified) {
    indexFile.writeAsStringSync(content);
    io.stdout.writeln('  Updated index.html with version $version');
  }
}
