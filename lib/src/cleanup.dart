import 'dart:convert';
import 'dart:io' as io;

import 'package:path/path.dart' as p;

import 'files.dart';

/// Files to remove from Flutter build output.
///
/// `flutter.js` is embedded into the generated `bootstrap.js` at generation
/// time, so we remove it from the deployed output — leaving it in place
/// would invite hosts with SPA rewrites (e.g. Firebase) to serve `index.html`
/// for a missing `flutter.js`, reintroducing the stale-script trap this
/// generator is meant to avoid.
const List<String> _flutterFilesToRemove = [
  'flutter_bootstrap.js',
  'flutter_service_worker.js',
  'flutter.js',
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
///
/// [bootstrapOutput] is the generated bootstrap's file name, used in the
/// advice printed when index.html still boots through Flutter's loader.
void cleanup({
  required io.Directory buildDir,
  required String swVersion,
  Set<String> canvaskitKeep = const {},
  bool keepMaps = false,
  String bootstrapOutput = 'bootstrap.js',
}) {
  final tag =
      '<script src="$bootstrapOutput" data-sw-bootstrap defer></script>';
  final loader = _indexFlutterLoader(buildDir);

  // A page still loading Flutter's bootstrap goes blank once it is deleted:
  // the step that swaps in an index.html loading bootstrap.js was skipped.
  // Keep the file so the deploy still boots, without the service worker,
  // and say so loudly.
  final keepFlutterBootstrap = loader == _FlutterLoader.loaded;
  if (keepFlutterBootstrap) {
    io.stderr.writeln(
      'Warning: index.html still loads flutter_bootstrap.js, so it was kept '
      'and this page will not use $bootstrapOutput or the service worker. '
      'Load $bootstrapOutput instead: $tag',
    );
  } else if (loader == _FlutterLoader.inlined) {
    // `{{flutter_bootstrap_js}}` makes Flutter paste its whole loader into
    // the page, which then boots the app itself and never runs ours.
    io.stderr.writeln(
      'Warning: index.html contains Flutter\'s loader inline (the '
      '{{flutter_bootstrap_js}} placeholder, expanded by "flutter build '
      'web"), so this page boots without $bootstrapOutput and the service '
      'worker. Replace that <script> block in web/index.html with $tag and '
      'rebuild.',
    );
  }

  // Remove Flutter files
  for (final filename in _flutterFilesToRemove) {
    if (keepFlutterBootstrap && filename == 'flutter_bootstrap.js') continue;
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

  // Update index.html: replace version placeholders. A no-op in the normal
  // pipeline, where the generator already substituted and re-hashed the
  // entry; this call only covers callers that use [cleanup] on its own.
  applyIndexHtmlVersion(buildDir, swVersion);
}

/// How `index.html` boots through Flutter's own loader, if it does.
enum _FlutterLoader {
  /// It does not: the page is free to load the generated bootstrap.
  none,

  /// It loads `flutter_bootstrap.js`, from a script tag or from an inline
  /// script, so that file must stay.
  loaded,

  /// Flutter pasted the loader into an inline script
  /// (`{{flutter_bootstrap_js}}`); the page needs no file, but never runs
  /// the generated bootstrap either.
  inlined,
}

/// Classify how `index.html` in [buildDir] uses Flutter's loader.
_FlutterLoader _indexFlutterLoader(io.Directory buildDir) {
  final index = io.File(p.join(buildDir.path, 'index.html'));
  if (!index.existsSync()) return _FlutterLoader.none;
  // A commented-out tag loads nothing. `src` must be the attribute itself,
  // not the tail of `data-src`, and the file name must be the whole last
  // path segment, not `my_flutter_bootstrap.js` or `flutter_bootstrap.json`.
  final html = index.readAsStringSync().replaceAll(
    RegExp('<!--.*?-->', dotAll: true),
    '',
  );
  if (RegExp(
    r'''<script\b[^>]*[\s"']src\s*=\s*["']?(?:[^"'\s>]*/)?'''
    r'''flutter_bootstrap\.js(?=[?#"'\s>]|$)''',
    caseSensitive: false,
  ).hasMatch(html)) {
    return _FlutterLoader.loaded;
  }

  var inlined = false;
  for (final script in RegExp(
    r'<script\b([^>]*)>([\s\S]*?)</script\s*>',
    caseSensitive: false,
  ).allMatches(html)) {
    final attributes = script.group(1)!;
    if (RegExp(
      r'''[\s"']src\s*=''',
      caseSensitive: false,
    ).hasMatch(attributes)) {
      continue;
    }
    final body = script.group(2)!;
    // What `{{flutter_bootstrap_js}}` expands to: the build config and the
    // call that starts the app.
    if (body.contains('_flutter.buildConfig') ||
        RegExp(r'_flutter\.loader\.load\s*\(').hasMatch(body)) {
      inlined = true;
    } else if (RegExp(
      r'''(?:^|[/"'`])flutter_bootstrap\.js\b''',
    ).hasMatch(body)) {
      // A script that injects flutter_bootstrap.js itself still needs it.
      return _FlutterLoader.loaded;
    }
  }
  return inlined ? _FlutterLoader.inlined : _FlutterLoader.none;
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
  // Links are not followed: a symlinked directory under canvaskit/ would
  // otherwise have its target's files deleted, outside the build.
  for (final entity in canvaskitDir.listSync(
    recursive: true,
    followLinks: false,
  )) {
    final relative = p.url.relative(pathToUrl(entity.path), from: buildUrl);
    if (entity is io.Link) {
      io.stderr.writeln(
        'Warning: left symlink $relative in place; pruning does not follow '
        'or remove links.',
      );
      continue;
    }
    if (entity is! io.File) continue;
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

/// Substitute version placeholders in `index.html`.
///
/// Returns `true` when the file was rewritten. Idempotent: once the
/// placeholders are gone, a second call is a no-op.
///
/// The generator stamps the shell itself, with [stampIndexHtmlVersion],
/// and records the stamped bytes in the manifest; this function covers
/// callers that use [cleanup] on its own. Under `--no-cleanup` the
/// generator skips the substitution and the placeholders survive, which
/// the manifest then describes accurately.
bool applyIndexHtmlVersion(io.Directory buildDir, String version) {
  final indexFile = io.File(p.join(buildDir.path, 'index.html'));
  if (!indexFile.existsSync()) return false;

  final stamped = stampIndexHtmlVersion(indexFile.readAsStringSync(), version);
  if (stamped == null) return false;
  indexFile.writeAsStringSync(stamped);
  io.stdout.writeln('  Updated index.html with version $version');
  return true;
}

/// Escapes a value for HTML text and quoted attribute values alike.
const HtmlEscape _htmlEscape = HtmlEscape(
  HtmlEscapeMode(escapeLtGt: true, escapeQuot: true, escapeApos: true),
);

/// [html] with the `{{sw_version}}` and Flutter's deprecated
/// `{{flutter_service_worker_version}}` placeholders replaced by [version],
/// or `null` when it has neither.
///
/// The version is HTML-escaped (`&`, `<`, `>`, `"` and `'`), so a
/// user-supplied version cannot close the attribute or element it is
/// stamped into. Generated versions are hex digests and come out
/// unchanged.
String? stampIndexHtmlVersion(String html, String version) {
  const placeholders = ['{{sw_version}}', '{{flutter_service_worker_version}}'];
  if (!placeholders.any(html.contains)) return null;
  final escaped = _htmlEscape.convert(version);
  var result = html;
  for (final placeholder in placeholders) {
    result = result.replaceAll(placeholder, escaped);
  }
  return result;
}
