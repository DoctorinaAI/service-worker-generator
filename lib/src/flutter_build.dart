import 'dart:convert';
import 'dart:io' as io;

import 'package:path/path.dart' as p;

/// Parsed Flutter build configuration.
class FlutterBuildInfo {
  /// Create a Flutter build info.
  const FlutterBuildInfo({required this.engineRevision, required this.builds});

  /// Engine revision hash (e.g., "425cfb54d01a9472b3e81d9e76fd63a4a44cfbcb").
  final String engineRevision;

  /// Build entries from _flutter.buildConfig.builds.
  final List<Map<String, dynamic>> builds;
}

/// Extract Flutter build info from the build directory.
///
/// Parses flutter_bootstrap.js to find _flutter.buildConfig
/// which contains engineRevision and builds array.
FlutterBuildInfo extractFlutterBuildInfo(io.Directory buildDir) {
  final bootstrapFile = io.File(p.join(buildDir.path, 'flutter_bootstrap.js'));

  if (!bootstrapFile.existsSync()) {
    throw StateError(
      'flutter_bootstrap.js not found in ${buildDir.path}. '
      'Run "flutter build web" first.',
    );
  }

  final content = bootstrapFile.readAsStringSync();

  // Extract _flutter.buildConfig = {...};
  final configMatch = RegExp(
    r'_flutter\.buildConfig\s*=\s*(\{[\s\S]*?\})\s*;',
  ).firstMatch(content);

  if (configMatch == null) {
    throw StateError(
      'Could not find _flutter.buildConfig in flutter_bootstrap.js',
    );
  }

  final configJson = configMatch.group(1)!;

  try {
    final config = jsonDecode(configJson) as Map<String, dynamic>;

    final engineRevision = config['engineRevision'] as String? ?? '';
    final buildsRaw = config['builds'] as List<dynamic>? ?? [];

    final builds = buildsRaw
        .whereType<Map<String, dynamic>>()
        .where((b) => b.isNotEmpty)
        .toList();

    return FlutterBuildInfo(engineRevision: engineRevision, builds: builds);
  } catch (e) {
    throw StateError('Failed to parse buildConfig JSON: $e');
  }
}

/// Determine which renderers are configured in the builds.
Set<String> getConfiguredRenderers(FlutterBuildInfo info) => info.builds
    .map((b) => b['renderer'] as String?)
    .whereType<String>()
    .toSet();
