import 'dart:convert';
import 'dart:io' as io;

import 'package:path/path.dart' as p;

/// Parsed Flutter build configuration.
class FlutterBuildInfo {
  /// Create a Flutter build info.
  const FlutterBuildInfo({
    required this.engineRevision,
    required this.builds,
    this.useLocalCanvasKit = false,
  });

  /// Engine revision hash (e.g., "425cfb54d01a9472b3e81d9e76fd63a4a44cfbcb").
  final String engineRevision;

  /// Build entries from _flutter.buildConfig.builds.
  final List<Map<String, dynamic>> builds;

  /// Whether the app was built with `--no-web-resources-cdn`: Flutter
  /// records `"useLocalCanvasKit":true` in its buildConfig, and the engine
  /// is then served from the local `canvaskit/` directory, not the CDN.
  final bool useLocalCanvasKit;
}

/// Extract Flutter build info from the build directory.
///
/// Parses flutter_bootstrap.js to find _flutter.buildConfig
/// which contains engineRevision, the builds array and, for builds made
/// with `--no-web-resources-cdn`, useLocalCanvasKit.
FlutterBuildInfo extractFlutterBuildInfo(io.Directory buildDir) {
  final bootstrapFile = io.File(p.join(buildDir.path, 'flutter_bootstrap.js'));

  if (!bootstrapFile.existsSync()) {
    throw StateError(
      'flutter_bootstrap.js not found in ${buildDir.path}. '
      'Run "flutter build web" first.',
    );
  }

  final content = bootstrapFile.readAsStringSync();

  final configJson = extractBuildConfigLiteral(content);

  if (configJson == null) {
    throw StateError(
      'Could not find _flutter.buildConfig in ${bootstrapFile.path}. '
      'The file may not come from "flutter build web", or this Flutter '
      'release writes it in a form the generator does not know. '
      'Re-run "flutter build web" and try again.',
    );
  }

  try {
    final config = jsonDecode(configJson) as Map<String, dynamic>;

    final engineRevision = config['engineRevision'] as String? ?? '';
    final buildsRaw = config['builds'] as List<dynamic>? ?? [];

    final builds = buildsRaw
        .whereType<Map<String, dynamic>>()
        .where((b) => b.isNotEmpty)
        .toList();

    return FlutterBuildInfo(
      engineRevision: engineRevision,
      builds: builds,
      useLocalCanvasKit: config['useLocalCanvasKit'] == true,
    );
  } catch (e) {
    throw StateError(
      'Failed to parse buildConfig JSON in ${bootstrapFile.path}: $e',
    );
  }
}

/// A single backslash, the escape character inside a JavaScript string.
const String _backslash = r'\';

/// The object literal assigned to `_flutter.buildConfig` in [content], or
/// `null` when there is none.
///
/// Found by scanning braces rather than by a regular expression. The
/// pattern this replaces (`\{[\s\S]*?\}\s*;`) stopped at the first `}`
/// followed by a `;`, which today's output happens not to contain inside
/// the object — a string value with a `};` in it, or a future release that
/// writes `Object.freeze({...})` or appends a statement on the same line,
/// and extraction silently returns the wrong text.
///
/// A wrapper the assignment is written with (`Object.freeze({…})`) is
/// skipped: only whitespace, identifier characters, dots and an opening
/// parenthesis may stand between the `=` and the literal. A wrapper whose
/// argument is a *string* rather than a literal (`JSON.parse('{…}')`) is
/// not read — the scan stops at the quote and yields nothing, which
/// `parseFlutterBuild` reports as a missing `buildConfig` rather than
/// guessing. Braces inside strings are ignored, escapes included.
String? extractBuildConfigLiteral(String content) {
  final marker = RegExp(r'_flutter\.buildConfig\s*=\s*').firstMatch(content);
  if (marker == null) return null;

  // Walk to the literal, refusing anything that is not a wrapper call.
  final preamble = RegExp(r'[\s\w.(]');
  var start = marker.end;
  while (start < content.length && content[start] != '{') {
    if (!preamble.hasMatch(content[start])) return null;
    start++;
  }
  if (start >= content.length) return null;

  var depth = 0;
  var inString = false;
  var escaped = false;
  String? quote;
  for (var i = start; i < content.length; i++) {
    final char = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char == _backslash) {
        escaped = true;
      } else if (char == quote) {
        inString = false;
      }
      continue;
    }
    switch (char) {
      case '"' || "'":
        inString = true;
        quote = char;
      case '{':
        depth++;
      case '}':
        depth--;
        if (depth == 0) return content.substring(start, i + 1);
    }
  }
  // Unbalanced: a truncated file.
  return null;
}

/// Determine which renderers are configured in the builds.
Set<String> getConfiguredRenderers(FlutterBuildInfo info) => info.builds
    .map((b) => b['renderer'] as String?)
    .whereType<String>()
    .toSet();
