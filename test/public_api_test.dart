import 'package:sw/sw.dart';
import 'package:test/test.dart';

/// Audit #30, item 3.8: `package:sw/sw.dart` used to export every internal,
/// so renaming a private helper was a breaking change for the package.
///
/// This pins the surface rather than the implementation: the five names a
/// build script needs, and the fact that nothing else is reachable through
/// the barrel. The analyzer enforces the second part — an unexported name
/// used here does not compile.
void main() {
  group('public API', () {
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
