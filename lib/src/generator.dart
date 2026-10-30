import 'dart:convert';
import 'dart:io' as io;

import 'package:crypto/crypto.dart' as crypto;
import 'package:path/path.dart' as p;

import 'assets/bootstrap_template.dart';
import 'assets/sw_template.dart';
import 'categorizer.dart';
import 'cleanup.dart';
import 'config.dart';
import 'diagnostics.dart';
import 'flutter_build.dart';
import 'injector.dart';
import 'manifest.dart';

/// Manifest key of the app shell — the one entry the generator writes to.
const String _shellKey = 'index.html';

/// Run the full generation pipeline.
///
/// Every check that can fail runs before the first file in the build
/// directory is written, so a failed run leaves the input as it found it
/// and can simply be repeated.
Future<void> generate(GeneratorConfig config) async {
  config.validate();
  final buildDir = io.Directory(config.inputDir);

  // 1. Validate
  if (!buildDir.existsSync()) {
    throw StateError('Build directory not found: ${config.inputDir}');
  }

  final indexHtml = io.File(p.join(buildDir.path, 'index.html'));
  if (!indexHtml.existsSync()) {
    throw StateError('index.html not found in ${config.inputDir}');
  }

  io.stdout.writeln('Generating service worker and bootstrap...');
  io.stdout.writeln('  Input: ${config.inputDir}');

  // 2. Extract Flutter build info
  io.stdout.writeln('\nParsing Flutter build config...');
  _rejectProcessedBuild(buildDir, config, 'flutter_bootstrap.js');
  final buildInfo = extractFlutterBuildInfo(buildDir);
  final revision = buildInfo.engineRevision;
  if (revision.isEmpty) {
    // The bootstrap compares this with the engine of the worker that
    // controls the page to decide whether a deploy can keep running on the
    // old worker until the next reload. Without it, every deploy counts as
    // an engine change.
    io.stderr.writeln(
      'Warning: the Flutter buildConfig has no engineRevision. Every deploy '
      'will take the slow update path: the page waits for the new service '
      'worker to install and take over before the app starts. CanvasKit '
      'will also load from the local canvaskit/ directory, never the CDN. '
      'Re-run "flutter build web" with a released Flutter SDK to record it.',
    );
  }
  final shortRevision = revision.isEmpty
      ? '(unknown)'
      : revision.length > 10
      ? '${revision.substring(0, 10)}...'
      : revision;
  io.stdout.writeln('  Engine: $shortRevision');
  final renderers = getConfiguredRenderers(buildInfo);
  io.stdout.writeln('  Renderers: ${renderers.join(", ")}');
  io.stdout.writeln('  Builds: ${buildInfo.builds.length}');

  // 3. Determine canvaskit files needed
  final canvaskitFiles = _findCanvaskitFiles(buildDir, renderers);
  io.stdout.writeln('  CanvasKit files: ${canvaskitFiles.length}');
  io.stdout.writeln(
    buildInfo.useLocalCanvasKit
        ? '  CanvasKit source: local (--no-web-resources-cdn)'
        : '  CanvasKit source: CDN, falling back to local',
  );

  // 4. Categorize and scan files
  io.stdout.writeln('\nScanning files...');
  final categorizer = FileCategorizer(
    coreOverrides: config.coreGlobs,
    requiredOverrides: config.requiredGlobs,
    optionalOverrides: config.optionalGlobs,
    ignoreOverrides: config.ignoreGlobs,
    canvaskitFiles: canvaskitFiles,
  );

  final ignored = <String, int>{};
  final manifest = await generateManifest(
    directory: buildDir,
    categorizer: categorizer,
    includeGlobs: config.includeGlobs,
    excludeGlobs: config.excludeGlobs,
    onIgnored: (path, size) => ignored[path] = size,
  );

  // Derive a deterministic version from the manifest content when the
  // caller did not supply one. Same manifest → same version → browsers
  // skip the SW upgrade dance entirely when nothing changed.
  final effectiveVersion = config.version.isNotEmpty
      ? config.version
      : _hashManifest(manifest);
  io.stdout.writeln('  Version: $effectiveVersion');

  // Read flutter.js now: a build without it must fail before this run
  // writes anything, or the shell would be stamped with a version that the
  // re-run (with the shell hash changed) could no longer reproduce.
  final bootstrapPrefix = _readFlutterJs(buildDir, config);

  // Stamp the version into the shell *in memory*, and describe the stamped
  // bytes in the manifest. The shell is a manifest entry, so its recorded
  // hash and size must describe the file that actually ships. It is written
  // after the artifacts, as the last change to the input files.
  //
  // Gated on `noCleanup` because rewriting the input tree is exactly what
  // that flag exists to prevent; skipping it leaves the placeholders in
  // place, which the manifest then describes accurately.
  List<int>? stampedShell;
  if (!config.noCleanup) {
    final stamped = stampIndexHtmlVersion(
      indexHtml.readAsStringSync(),
      effectiveVersion,
    );
    if (stamped != null) {
      final bytes = stampedShell = utf8.encode(stamped);
      final shell = manifest[_shellKey];
      if (shell != null) {
        manifest[_shellKey] = ResourceEntry(
          name: shell.name,
          size: bytes.length,
          hash: crypto.md5.convert(bytes).toString(),
          category: shell.category,
        );
      }
    }
  }

  // Print summary by category
  final categoryCounts = <ResourceCategory, int>{};
  final categorySizes = <ResourceCategory, int>{};
  for (final entry in manifest.values) {
    categoryCounts[entry.category] = (categoryCounts[entry.category] ?? 0) + 1;
    categorySizes[entry.category] =
        (categorySizes[entry.category] ?? 0) + entry.size;
  }

  // Ignored files never reach the manifest, so they are counted from the
  // scan itself.
  categoryCounts[ResourceCategory.ignore] = ignored.length;
  categorySizes[ResourceCategory.ignore] = ignored.values.fold(
    0,
    (sum, size) => sum + size,
  );

  for (final cat in ResourceCategory.values) {
    final count = categoryCounts[cat] ?? 0;
    final size = categorySizes[cat] ?? 0;
    if (count > 0) {
      io.stdout.writeln('  ${cat.name}: $count files (${_formatBytes(size)})');
    }
  }

  // Deferred-import parts are fetched when the app first loads a deferred
  // library, often during startup, yet the defaults leave them out of the
  // manifest: the worker neither pre-caches them nor counts them in the
  // progress. Say so instead of leaving it to be found in production.
  final ignoredParts =
      ignored.keys.where((path) => path.endsWith('.part.js')).toList()..sort();
  if (ignoredParts.isNotEmpty) {
    io.stderr.writeln(
      'Warning: ${ignoredParts.length} deferred-import part file(s) '
      '(*.part.js) are in the ignore category, so the service worker does '
      'not cache them. If the app loads them at startup, add them with '
      '--optional="**.part.js" (lazy) or --required="**.part.js" '
      '(pre-cached):\n${formatPathList(ignoredParts)}',
    );
  }

  // 5. Inject configs into templates
  io.stdout.writeln('\nGenerating artifacts...');

  final swContent = injectSWConfig(
    template: swTemplate,
    cachePrefix: config.cachePrefix,
    version: effectiveVersion,
    manifest: manifest,
    engineRevision: buildInfo.engineRevision,
  );

  // Warn when the embedded manifest gets unreasonably large: the entire
  // JSON ships inside sw.js on every install, so a 10 MB+ manifest means
  // every client pays that on upgrade. Usually means Optional categorisation
  // is overly permissive.
  const manifestWarnLimit = 10 * 1024 * 1024;
  if (swContent.length > manifestWarnLimit) {
    io.stderr.writeln(
      'Warning: sw.js is ${_formatBytes(swContent.length)} '
      '(> ${_formatBytes(manifestWarnLimit)}). Consider tightening '
      'optional/ignore globs or removing large assets from the manifest.',
    );
  }

  final injectedBootstrap = injectBootstrapConfig(
    template: bootstrapTemplate,
    engineRevision: buildInfo.engineRevision,
    swVersion: effectiveVersion,
    swFilename: config.swOutput,
    builds: buildInfo.builds,
    config: config,
    useLocalCanvasKit: buildInfo.useLocalCanvasKit,
  );

  final bootstrapContent = '$bootstrapPrefix$injectedBootstrap';

  // 6. Write output files, then the stamped shell.
  _writeOutput(buildDir, config.swOutput, swContent);
  io.stdout.writeln('  ${config.swOutput} (${_formatBytes(swContent.length)})');

  _writeOutput(buildDir, config.bootstrapOutput, bootstrapContent);
  io.stdout.writeln(
    '  ${config.bootstrapOutput} '
    '(${_formatBytes(bootstrapContent.length)})',
  );

  if (stampedShell != null) {
    indexHtml.writeAsBytesSync(stampedShell);
    io.stdout.writeln('  Updated index.html with version $effectiveVersion');
  }

  // 7. Cleanup
  if (!config.noCleanup) {
    io.stdout.writeln('\nCleaning up...');
    cleanup(
      buildDir: buildDir,
      swVersion: effectiveVersion,
      canvaskitKeep: canvaskitFiles,
      keepMaps: config.keepMaps,
      bootstrapOutput: config.bootstrapOutput,
    );
  }

  io.stdout.writeln('\nDone!');
}

/// Write [content] to [name] directly under [buildDir].
///
/// [GeneratorConfig.validate] has rejected names with a directory part, so
/// this never creates directories: a worker served from a subdirectory
/// would never control the app.
void _writeOutput(io.Directory buildDir, String name, String content) {
  io.File(p.join(buildDir.path, name)).writeAsStringSync(content);
}

/// Flutter's `flutter.js`, prepared to open `bootstrap.js`.
///
/// It is prepended so bootstrap.js is self-contained — no runtime
/// dependency on flutter.js being served separately. Hosts with SPA
/// rewrites (Firebase, etc.) otherwise serve index.html for a missing
/// flutter.js, breaking the loader with "Unexpected token '<'".
String _readFlutterJs(io.Directory buildDir, GeneratorConfig config) {
  final flutterJsFile = io.File(p.join(buildDir.path, 'flutter.js'));
  _rejectProcessedBuild(buildDir, config, 'flutter.js');
  if (!flutterJsFile.existsSync()) {
    throw StateError(
      'flutter.js not found in ${buildDir.path}. '
      'Re-run "flutter build web" to regenerate it.',
    );
  }
  // flutter.js keeps its `//# sourceMappingURL=flutter.js.map`, which would
  // point DevTools at a map that is not deployed next to bootstrap.js. The
  // `;` keeps the IIFE that follows from being parsed as a call on the
  // loader's last expression, should a Flutter release drop its own; it
  // goes on a line of its own so a trailing line comment cannot swallow it.
  final flutterJs = flutterJsFile.readAsStringSync().replaceAll(
    RegExp(r'^//# sourceMappingURL=.*$', multiLine: true),
    '',
  );
  return '${flutterJs.trimRight()}\n;\n';
}

/// Throw when [flutterFile] is missing because an earlier run of the
/// generator removed it, rather than because the Flutter build is broken.
///
/// Cleanup deletes Flutter's loader files, so a second run over the same
/// directory (a CI retry, or after editing `sw.yaml`) cannot work: it would
/// derive a version from a shell it already stamped. It must still fail,
/// but with a message that names the actual cause.
void _rejectProcessedBuild(
  io.Directory buildDir,
  GeneratorConfig config,
  String flutterFile,
) {
  bool exists(String name) => io.File(p.join(buildDir.path, name)).existsSync();
  if (exists(flutterFile)) return;
  if (!exists(config.swOutput) || !exists(config.bootstrapOutput)) return;
  throw StateError(
    'This build was already processed: $flutterFile is missing from '
    '${buildDir.path}, and ${config.swOutput} and ${config.bootstrapOutput} '
    'exist. The generator removes Flutter\'s loader files, so it cannot '
    'run twice over the same output. Run "flutter build web" again, then '
    're-run the generator.',
  );
}

/// Renderer names whose CanvasKit files [_findCanvaskitFiles] knows.
const Set<String> _knownRenderers = {'canvaskit', 'skwasm'};

/// Find canvaskit variant files needed based on configured renderers.
Set<String> _findCanvaskitFiles(io.Directory buildDir, Set<String> renderers) {
  // A renderer this generator does not know keeps no engine files: with
  // another renderer configured, pruning deletes the files it would load.
  for (final renderer in renderers.difference(_knownRenderers)) {
    io.stderr.writeln(
      'Warning: unknown renderer "$renderer" in the Flutter buildConfig '
      '(known: ${_knownRenderers.join(", ")}). No canvaskit/ files are kept '
      'for it, so pruning may remove engine files it needs; check the '
      'output or pass --no-cleanup.',
    );
  }

  final canvaskitDir = io.Directory(p.join(buildDir.path, 'canvaskit'));
  if (!canvaskitDir.existsSync()) return const {};

  final files = <String>{};

  for (final renderer in renderers) {
    switch (renderer) {
      case 'canvaskit':
        // Every file getCanvasKitVariant can load, as a pair: Chromium-class
        // browsers use chromium/canvaskit.js and .wasm. Pruning the .js went
        // unnoticed while the engine came from the CDN, but a
        // --no-web-resources-cdn build loads it from here.
        files.addAll([
          'canvaskit/canvaskit.js',
          'canvaskit/canvaskit.wasm',
          'canvaskit/chromium/canvaskit.js',
          'canvaskit/chromium/canvaskit.wasm',
        ]);
      case 'skwasm':
        files.addAll([
          'canvaskit/skwasm.js',
          'canvaskit/skwasm.wasm',
          'canvaskit/skwasm_heavy.js',
          'canvaskit/skwasm_heavy.wasm',
          'canvaskit/wimp.js',
          'canvaskit/wimp.wasm',
        ]);
    }
  }

  // Only include files that actually exist
  return files
      .where((f) => io.File(p.join(buildDir.path, f)).existsSync())
      .toSet();
}

/// Produce a short content-hash identifier for the manifest. Stable across
/// runs as long as the build output is byte-identical, so users who rerun
/// the generator on unchanged inputs get the same SW version (and so their
/// browsers don't treat it as an update).
///
/// The shell is stamped with this value and re-hashed afterwards, which
/// looks circular but is not: the version is derived from the manifest as
/// it was *before* the substitution, and the only run that substitutes is
/// one that also runs `cleanup` — which removes `flutter.js` and so makes a
/// second run on the same directory fail loudly rather than silently derive
/// a different version. Under `--no-cleanup` nothing is
/// rewritten at all.
String _hashManifest(Map<String, ResourceEntry> manifest) {
  // Use the entries' stable metadata (path, hash, size, category). We sort
  // to insulate against Map iteration order changes.
  final keys = manifest.keys.toList()..sort();
  final buffer = StringBuffer();
  for (final key in keys) {
    final entry = manifest[key]!;
    buffer
      ..write(key)
      ..write('|')
      ..write(entry.hash)
      ..write('|')
      ..write(entry.size)
      ..write('|')
      ..write(entry.category.name)
      ..write('\n');
  }
  final digest = crypto.sha256.convert(utf8.encode(buffer.toString()));
  return digest.toString().substring(0, 12);
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
