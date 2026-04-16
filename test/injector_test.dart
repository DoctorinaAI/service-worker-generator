import 'package:sw/src/categorizer.dart';
import 'package:sw/src/config.dart';
import 'package:sw/src/injector.dart';
import 'package:sw/src/manifest.dart';
import 'package:test/test.dart';

void main() {
  group('injectSWConfig', () {
    test('replaces placeholder with config JSON', () {
      const template =
          '(function(){var config="__INJECT_SW_CONFIG__";start(config)})();';

      final manifest = {
        'main.dart.js': ResourceEntry(
          name: 'main.dart.js',
          size: 1024,
          hash: 'abc123',
          category: ResourceCategory.core,
        ),
      };

      final result = injectSWConfig(
        template: template,
        cachePrefix: 'test-app',
        version: '12345',
        manifest: manifest,
      );

      expect(result, contains('"cachePrefix":"test-app"'));
      expect(result, contains('"version":"12345"'));
      expect(result, contains('"main.dart.js"'));
      expect(result, contains('"hash":"abc123"'));
      expect(result, contains('"category":"core"'));
      expect(result, isNot(contains('__INJECT_SW_CONFIG__')));
    });

    test('throws if placeholder not found', () {
      expect(
        () => injectSWConfig(
          template: 'no placeholder here',
          cachePrefix: 'test',
          version: '1',
          manifest: {},
        ),
        throwsA(isA<StateError>()),
      );
    });

    test('handles empty manifest', () {
      const template = 'config="__INJECT_SW_CONFIG__"';

      final result = injectSWConfig(
        template: template,
        cachePrefix: 'app',
        version: '1',
        manifest: {},
      );

      expect(result, contains('"manifest":{}'));
    });

    test('handles multiple resources', () {
      const template = 'config="__INJECT_SW_CONFIG__"';

      final manifest = {
        'main.dart.js': ResourceEntry(
          name: 'main.dart.js',
          size: 1024,
          hash: 'aaa',
          category: ResourceCategory.core,
        ),
        'assets/FontManifest.json': ResourceEntry(
          name: 'FontManifest.json',
          size: 200,
          hash: 'bbb',
          category: ResourceCategory.required,
        ),
        'icons/icon.png': ResourceEntry(
          name: 'icon.png',
          size: 5000,
          hash: 'ccc',
          category: ResourceCategory.optional,
        ),
      };

      final result = injectSWConfig(
        template: template,
        cachePrefix: 'test',
        version: '1',
        manifest: manifest,
      );

      expect(result, contains('"core"'));
      expect(result, contains('"required"'));
      expect(result, contains('"optional"'));
    });
  });

  group('injectBootstrapConfig', () {
    test('replaces placeholder with build config JSON', () {
      const template =
          '(function(){var c="__INJECT_BOOTSTRAP_CONFIG__";boot(c)})();';

      final config = GeneratorConfig(
        inputDir: 'build/web',
        version: '12345',
        cachePrefix: 'test',
      );

      final result = injectBootstrapConfig(
        template: template,
        engineRevision: 'abc123def456',
        swVersion: '12345',
        swFilename: 'sw.js',
        builds: [
          {'compileTarget': 'dartdevc', 'renderer': 'canvaskit'},
        ],
        config: config,
      );

      expect(result, contains('"engineRevision":"abc123def456"'));
      expect(result, contains('"swVersion":"12345"'));
      expect(result, contains('"swFilename":"sw.js"'));
      expect(result, contains('"renderer":"canvaskit"'));
      expect(result, isNot(contains('__INJECT_BOOTSTRAP_CONFIG__')));
    });

    test('throws if placeholder not found', () {
      final config = GeneratorConfig(inputDir: 'build/web', version: '1');

      expect(
        () => injectBootstrapConfig(
          template: 'no placeholder',
          engineRevision: 'abc',
          swVersion: '1',
          swFilename: 'sw.js',
          builds: [],
          config: config,
        ),
        throwsA(isA<StateError>()),
      );
    });

    test('handles empty builds list', () {
      const template = 'c="__INJECT_BOOTSTRAP_CONFIG__"';

      final config = GeneratorConfig(inputDir: 'build/web', version: '1');

      final result = injectBootstrapConfig(
        template: template,
        engineRevision: 'rev',
        swVersion: '1',
        swFilename: 'sw.js',
        builds: [],
        config: config,
      );

      expect(result, contains('"builds":[]'));
    });
  });
}
