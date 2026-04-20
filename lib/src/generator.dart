import 'dart:convert';
import 'dart:io' as io;

import 'package:crypto/crypto.dart' as crypto;
import 'package:path/path.dart' as p;

import 'assets/bootstrap_template.dart';
import 'assets/sw_template.dart';
import 'categorizer.dart';
import 'cleanup.dart';
import 'config.dart';
import 'flutter_build.dart';
import 'injector.dart';
import 'manifest.dart';

/// Run the full generation pipeline.
Future<void> generate(GeneratorConfig config) async {
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
  final buildInfo = extractFlutterBuildInfo(buildDir);
  if (buildInfo.engineRevision.isEmpty) {
    throw StateError(
      'Flutter buildConfig is missing engineRevision. '
      'Re-run "flutter build web" to regenerate flutter_bootstrap.js.',
    );
  }
  final revision = buildInfo.engineRevision;
  final shortRevision = revision.length > 10
      ? '${revision.substring(0, 10)}...'
      : revision;
  io.stdout.writeln('  Engine: $shortRevision');
  final renderers = getConfiguredRenderers(buildInfo);
  io.stdout.writeln('  Renderers: ${renderers.join(", ")}');
  io.stdout.writeln('  Builds: ${buildInfo.builds.length}');

  // 3. Determine canvaskit files needed
  final canvaskitFiles = _findCanvaskitFiles(buildDir, renderers);
  io.stdout.writeln('  CanvasKit files: ${canvaskitFiles.length}');

  // 4. Categorize and scan files
  io.stdout.writeln('\nScanning files...');
  final categorizer = FileCategorizer(
    coreOverrides: config.coreGlobs,
    requiredOverrides: config.requiredGlobs,
    optionalOverrides: config.optionalGlobs,
    ignoreOverrides: config.ignoreGlobs,
    canvaskitFiles: canvaskitFiles,
  );

  final manifest = await generateManifest(
    directory: buildDir,
    categorizer: categorizer,
    includeGlobs: config.includeGlobs,
    excludeGlobs: config.excludeGlobs,
  );

  // Derive a deterministic version from the manifest content when the
  // caller did not supply one. Same manifest → same version → browsers
  // skip the SW upgrade dance entirely when nothing changed.
  final effectiveVersion = config.version.isNotEmpty
      ? config.version
      : _hashManifest(manifest);
  io.stdout.writeln('  Version: $effectiveVersion');

  // Print summary by category
  final categoryCounts = <ResourceCategory, int>{};
  final categorySizes = <ResourceCategory, int>{};
  for (final entry in manifest.values) {
    categoryCounts[entry.category] = (categoryCounts[entry.category] ?? 0) + 1;
    categorySizes[entry.category] =
        (categorySizes[entry.category] ?? 0) + entry.size;
  }

  for (final cat in ResourceCategory.values) {
    if (cat == ResourceCategory.ignore) continue;
    final count = categoryCounts[cat] ?? 0;
    final size = categorySizes[cat] ?? 0;
    if (count > 0) {
      io.stdout.writeln('  ${cat.name}: $count files (${_formatBytes(size)})');
    }
  }

  // 5. Inject configs into templates
  io.stdout.writeln('\nGenerating artifacts...');

  final swContent = injectSWConfig(
    template: swTemplate,
    cachePrefix: config.cachePrefix,
    version: effectiveVersion,
    manifest: manifest,
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
  );

  // Prepend Flutter's flutter.js so bootstrap.js is self-contained — no
  // runtime dependency on flutter.js being served separately. Hosts with
  // SPA rewrites (Firebase, etc.) otherwise serve index.html for a missing
  // flutter.js, breaking the loader with "Unexpected token '<'".
  final flutterJsFile = io.File(p.join(buildDir.path, 'flutter.js'));
  if (!flutterJsFile.existsSync()) {
    throw StateError(
      'flutter.js not found in ${buildDir.path}. '
      'Re-run "flutter build web" to regenerate it.',
    );
  }
  final bootstrapContent =
      '${flutterJsFile.readAsStringSync()}\n'
      '$injectedBootstrap';

  // 6. Write output files
  io.File(p.join(buildDir.path, config.swOutput)).writeAsStringSync(swContent);
  io.stdout.writeln('  ${config.swOutput} (${_formatBytes(swContent.length)})');

  io.File(
    p.join(buildDir.path, config.bootstrapOutput),
  ).writeAsStringSync(bootstrapContent);
  io.stdout.writeln(
    '  ${config.bootstrapOutput} '
    '(${_formatBytes(bootstrapContent.length)})',
  );

  // 7. Cleanup
  if (!config.noCleanup) {
    io.stdout.writeln('\nCleaning up...');
    cleanup(
      buildDir: buildDir,
      swVersion: effectiveVersion,
      canvaskitKeep: canvaskitFiles,
      keepMaps: config.keepMaps,
    );
  }

  io.stdout.writeln('\nDone!');
}

/// Find canvaskit variant files needed based on configured renderers.
Set<String> _findCanvaskitFiles(io.Directory buildDir, Set<String> renderers) {
  final canvaskitDir = io.Directory(p.join(buildDir.path, 'canvaskit'));
  if (!canvaskitDir.existsSync()) return const {};

  final files = <String>{};

  for (final renderer in renderers) {
    switch (renderer) {
      case 'canvaskit':
        files.addAll([
          'canvaskit/canvaskit.js',
          'canvaskit/canvaskit.wasm',
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
