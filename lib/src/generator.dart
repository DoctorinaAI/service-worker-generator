import 'dart:io' as io;

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
  io.stdout.writeln('  Version: ${config.version}');

  // 2. Extract Flutter build info
  io.stdout.writeln('\nParsing Flutter build config...');
  final buildInfo = extractFlutterBuildInfo(buildDir);
  io.stdout.writeln(
    '  Engine: ${buildInfo.engineRevision.substring(0, 10)}...',
  );
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
    version: config.version,
    manifest: manifest,
  );

  final bootstrapContent = injectBootstrapConfig(
    template: bootstrapTemplate,
    engineRevision: buildInfo.engineRevision,
    swVersion: config.version,
    swFilename: config.swOutput,
    builds: buildInfo.builds,
    config: config,
  );

  // 6. Write output files
  final swFile = io.File(p.join(buildDir.path, config.swOutput));
  swFile.writeAsStringSync(swContent);
  io.stdout.writeln('  ${config.swOutput} (${_formatBytes(swContent.length)})');

  final bootstrapFile = io.File(p.join(buildDir.path, config.bootstrapOutput));
  bootstrapFile.writeAsStringSync(bootstrapContent);
  io.stdout.writeln(
    '  ${config.bootstrapOutput} '
    '(${_formatBytes(bootstrapContent.length)})',
  );

  // 7. Cleanup
  if (!config.noCleanup) {
    io.stdout.writeln('\nCleaning up...');
    cleanup(
      buildDir: buildDir,
      swVersion: config.version,
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
  return files.where((f) {
    return io.File(p.join(buildDir.path, f)).existsSync();
  }).toSet();
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
