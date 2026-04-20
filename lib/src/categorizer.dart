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

/// Maximum file size for auto-categorization as optional (512 KB).
const int _optionalMaxSize = 512 * 1024;

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
  'manifest.json',
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
};

/// File extensions that are always cached as optional regardless of size.
///
/// Fonts are declared in `FontManifest.json` and will be fetched by the
/// app on startup — without them Flutter renders tofu boxes instead of
/// icons and text. Icon fonts like MaterialIcons (~1.6 MB) and
/// CupertinoIcons (~250 KB) routinely exceed any reasonable size cap.
const Set<String> _fontExtensions = {'.ttf', '.otf', '.woff', '.woff2', '.eot'};

/// File extensions eligible for optional auto-categorization, size-capped
/// by [_optionalMaxSize]. Larger files fall through to `ignore` so they
/// don't bloat the pre-fetch manifest — the browser's HTTP cache still
/// serves them on repeat loads.
const Set<String> _optionalExtensions = {
  '.json',
  '.webp',
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
  /// needed for the selected renderer — these are categorized as
  /// optional (lazy-cached) since bootstrap prefers CDN.
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

    // CanvasKit variant files are cached lazily — the bootstrap prefers
    // CDN and only falls back to local files, so pre-caching wastes
    // bandwidth on variants the browser will never request.
    if (_canvaskitFiles.contains(path)) return ResourceCategory.optional;

    // Auto-categorize by extension.
    // Fonts: always optional (app needs them regardless of size).
    // Other media: optional only if within size cap.
    final ext = p.extension(path).toLowerCase();
    if (_fontExtensions.contains(ext)) return ResourceCategory.optional;
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
