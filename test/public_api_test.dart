import 'dart:io' as io;

import 'package:sw/sw.dart';
import 'package:test/test.dart';

/// Audit #30, item 3.8: `package:sw/sw.dart` used to export every internal,
/// so renaming a private helper was a breaking change for the package.
///
/// This pins the surface rather than the implementation: the five names a
/// build script needs, and the fact that nothing else is reachable through
/// the barrel. The first test only proves the five are there; the second
/// reads the barrel itself, so an `export` added back fails here.
void main() {
  group('public API', () {
    test('exports exactly these names, each through a show clause', () {
      final exports = io.File(
        'lib/sw.dart',
      ).readAsLinesSync().where((line) => line.startsWith('export ')).toList();
      expect(exports, [
        "export 'src/categorizer.dart' show ResourceCategory;",
        "export 'src/config.dart' show GeneratorConfig;",
        "export 'src/flutter_build.dart' show FlutterBuildInfo;",
        "export 'src/generator.dart' show generate;",
        "export 'src/manifest.dart' show ResourceEntry;",
      ]);
    });

    test('exports what a build script needs', () {
      const config = GeneratorConfig(inputDir: 'build/web', version: '');
      expect(config.inputDir, 'build/web');
      expect(generate, isA<Function>());

      const entry = ResourceEntry(
        name: 'main.dart.js',
        size: 1,
        hash: 'h',
        category: ResourceCategory.core,
      );
      expect(entry.toJson()['category'], 'core');

      const info = FlutterBuildInfo(engineRevision: 'rev', builds: []);
      expect(info.engineRevision, 'rev');
      expect(info.useLocalCanvasKit, isFalse);
    });

    test('validates a configuration built in code', () {
      const bad = GeneratorConfig(
        inputDir: 'build/web',
        version: '',
        swOutput: 'js/sw.js',
      );
      expect(bad.validate, throwsA(isA<FormatException>()));
    });
  });
}
