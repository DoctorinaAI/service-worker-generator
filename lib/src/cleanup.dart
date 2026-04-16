import 'dart:io' as io;

import 'package:path/path.dart' as p;

/// Files to remove from Flutter build output.
const List<String> _flutterFilesToRemove = [
  'flutter_bootstrap.js',
  'flutter_service_worker.js',
  'version.json',
];

/// Perform post-generation cleanup on the build directory.
///
/// Removes Flutter's deprecated bootstrap/SW files,
/// optionally removes .js.map files, and updates index.html.
void cleanup({
  required io.Directory buildDir,
  required String swVersion,
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

  // Remove .js.map files unless --keep-maps
  if (!keepMaps) {
    _removeMapFiles(buildDir);
  }

  // Update index.html: replace version placeholders
  _updateIndexHtml(buildDir, swVersion);
}

/// Recursively remove .js.map and .js.symbols files.
void _removeMapFiles(io.Directory dir) {
  final files = dir
      .listSync(recursive: true, followLinks: false)
      .whereType<io.File>()
      .where(
        (f) => f.path.endsWith('.js.map') || f.path.endsWith('.js.symbols'),
      );

  for (final file in files) {
    file.deleteSync();
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
