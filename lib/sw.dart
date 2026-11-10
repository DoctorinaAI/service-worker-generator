/// Generate an optimized service worker and bootstrap script for a Flutter
/// Web build.
///
/// The tool is normally run as a command (`dart run sw:generate`); this
/// library is the same thing for a build script that would rather call it
/// in process:
///
/// ```dart
/// import 'package:sw/sw.dart';
///
/// await generate(
///   GeneratorConfig(inputDir: 'build/web', version: '', title: 'My App'),
/// );
/// ```
///
/// Only the pieces a caller needs are exported. Everything else —
/// the categorizer, the manifest builder, the injector, the cleanup step —
/// is an implementation detail of [generate] under `src/`, so it can change
/// without breaking anyone.
library;

export 'src/categorizer.dart' show ResourceCategory;
export 'src/config.dart' show GeneratorConfig;
export 'src/flutter_build.dart' show FlutterBuildInfo;
export 'src/generator.dart' show generate;
export 'src/manifest.dart' show ResourceEntry;
