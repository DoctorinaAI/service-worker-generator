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
        'main.dart.js': const ResourceEntry(
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
        'main.dart.js': const ResourceEntry(
          name: 'main.dart.js',
          size: 1024,
          hash: 'aaa',
          category: ResourceCategory.core,
        ),
        'assets/FontManifest.json': const ResourceEntry(
          name: 'FontManifest.json',
          size: 200,
          hash: 'bbb',
          category: ResourceCategory.required,
        ),
        'icons/icon.png': const ResourceEntry(
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

      const config = GeneratorConfig(
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
      const config = GeneratorConfig(inputDir: 'build/web', version: '1');

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

      const config = GeneratorConfig(inputDir: 'build/web', version: '1');

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

    test('omits uiDefaults when nothing was customised', () {
      const template = 'c="__INJECT_BOOTSTRAP_CONFIG__"';
      const config = GeneratorConfig(inputDir: 'build/web', version: '1');

      final result = injectBootstrapConfig(
        template: template,
        engineRevision: 'rev',
        swVersion: '1',
        swFilename: 'sw.js',
        builds: const [],
        config: config,
      );

      expect(result, isNot(contains('uiDefaults')));
    });

    test('bakes uiDefaults from CLI/YAML config into the bootstrap', () {
      const template = 'c="__INJECT_BOOTSTRAP_CONFIG__"';
      const config = GeneratorConfig(
        inputDir: 'build/web',
        version: '1',
        logo: 'icons/logo.png',
        title: 'My App',
        theme: 'dark',
        color: '#ff0000',
        minProgress: 5,
        maxProgress: 95,
      );

      final result = injectBootstrapConfig(
        template: template,
        engineRevision: 'rev',
        swVersion: '1',
        swFilename: 'sw.js',
        builds: const [],
        config: config,
      );

      expect(result, contains('"uiDefaults":'));
      expect(result, contains('"logo":"icons/logo.png"'));
      expect(result, contains('"title":"My App"'));
      expect(result, contains('"theme":"dark"'));
      expect(result, contains('"color":"#ff0000"'));
      expect(result, contains('"minProgress":5'));
      expect(result, contains('"maxProgress":95'));
    });
  });
}
