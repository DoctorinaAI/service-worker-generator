import 'package:glob/glob.dart' as glob;
import 'package:path/path.dart' as p;

/// Resource category for caching strategy.
enum ResourceCategory {
  /// Essential for app startup.
  core,

  /// Needed early: manifests, font manifests.
  required,

  /// Lightweight files cached lazily.
  optional,

  /// Large assets, debug files — not cached.
  ignore,
}

/// Maximum file size for auto-categorization as optional (64 KB).
const int _optionalMaxSize = 64 * 1024;

/// Default patterns for each category.
const Set<String> _defaultCorePatterns = {
  'main.dart.js',
  'main.dart.wasm',
  'main.dart.mjs',
  '*.support.wasm',
};

const Set<String> _defaultRequiredPatterns = {
  'assets/AssetManifest*.json',
  'assets/FontManifest.json',
};

const Set<String> _defaultIgnorePatterns = {
  '*.map',
  '*.symbols',
  'assets/NOTICES',
  'sw.js',
  'bootstrap.js',
  'index.html',
  'flutter_bootstrap.js',
  'flutter_service_worker.js',
  'flutter.js',
  'version.json',
};

/// File extensions eligible for optional auto-categorization.
const Set<String> _optionalExtensions = {
  '.json',
  '.webp',
  '.ttf',
  '.woff',
  '.woff2',
  '.otf',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.gif',
  '.ico',
};

/// Categorize files based on default rules and user overrides.
class FileCategorizer {
  /// Create a file categorizer.
  ///
  /// [coreOverrides], [requiredOverrides], [optionalOverrides],
  /// [ignoreOverrides] are additional glob patterns from the user.
  ///
  /// [canvaskitFiles] are the specific canvaskit variant files
  /// needed for the selected renderer — these are categorized as core.
  FileCategorizer({
    Set<String> coreOverrides = const {},
    Set<String> requiredOverrides = const {},
    Set<String> optionalOverrides = const {},
    Set<String> ignoreOverrides = const {},
    Set<String> canvaskitFiles = const {},
  }) : _coreGlobs = _toGlobs({..._defaultCorePatterns, ...coreOverrides}),
       _requiredGlobs = _toGlobs({
         ..._defaultRequiredPatterns,
         ...requiredOverrides,
       }),
       _optionalGlobs = _toGlobs(optionalOverrides),
       _ignoreGlobs = _toGlobs({..._defaultIgnorePatterns, ...ignoreOverrides}),
       _canvaskitFiles = canvaskitFiles;
  final List<glob.Glob> _coreGlobs;
  final List<glob.Glob> _requiredGlobs;
  final List<glob.Glob> _optionalGlobs;
  final List<glob.Glob> _ignoreGlobs;
  final Set<String> _canvaskitFiles;

  /// Categorize a file by its path and size.
  ResourceCategory categorize(String path, int size) {
    // User overrides take precedence
    // (in order: core, required, ignore, optional)
    if (_coreGlobs.any((g) => g.matches(path))) return ResourceCategory.core;
    if (_requiredGlobs.any((g) => g.matches(path))) {
      return ResourceCategory.required;
    }
    if (_ignoreGlobs.any((g) => g.matches(path))) {
      return ResourceCategory.ignore;
    }
    if (_optionalGlobs.any((g) => g.matches(path))) {
      return ResourceCategory.optional;
    }

    // CanvasKit variant files are core
    if (_canvaskitFiles.contains(path)) return ResourceCategory.core;

    // Auto-categorize by extension and size
    final ext = p.extension(path).toLowerCase();
    if (_optionalExtensions.contains(ext) && size <= _optionalMaxSize) {
      return ResourceCategory.optional;
    }

    // Everything else is ignored
    return ResourceCategory.ignore;
  }

  static List<glob.Glob> _toGlobs(Set<String> patterns) => patterns
      .map((e) => glob.Glob(e, context: p.url, recursive: true))
      .toList(growable: false);
}
