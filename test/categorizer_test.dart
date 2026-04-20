import 'package:sw/src/categorizer.dart';
import 'package:test/test.dart';

void main() {
  group('FileCategorizer', () {
    late FileCategorizer categorizer;

    setUp(() {
      categorizer = FileCategorizer(
        canvaskitFiles: {'canvaskit/canvaskit.js', 'canvaskit/canvaskit.wasm'},
      );
    });

    group('core', () {
      test('main.dart.js is core', () {
        expect(
          categorizer.categorize('main.dart.js', 1000),
          ResourceCategory.core,
        );
      });

      test('main.dart.wasm is core', () {
        expect(
          categorizer.categorize('main.dart.wasm', 1000),
          ResourceCategory.core,
        );
      });

      test('main.dart.mjs is core', () {
        expect(
          categorizer.categorize('main.dart.mjs', 1000),
          ResourceCategory.core,
        );
      });

      test('support wasm is core', () {
        expect(
          categorizer.categorize('skia.support.wasm', 5000),
          ResourceCategory.core,
        );
      });
    });

    group('required', () {
      test('AssetManifest.json is required', () {
        expect(
          categorizer.categorize('assets/AssetManifest.json', 500),
          ResourceCategory.required,
        );
      });

      test('AssetManifest.bin.json is required', () {
        expect(
          categorizer.categorize('assets/AssetManifest.bin.json', 500),
          ResourceCategory.required,
        );
      });

      test('FontManifest.json is required', () {
        expect(
          categorizer.categorize('assets/FontManifest.json', 200),
          ResourceCategory.required,
        );
      });

      test('manifest.json is required', () {
        expect(
          categorizer.categorize('manifest.json', 960),
          ResourceCategory.required,
        );
      });
    });

    group('ignore', () {
      test('map files are ignored', () {
        expect(
          categorizer.categorize('main.dart.js.map', 100000),
          ResourceCategory.ignore,
        );
      });

      test('symbols files are ignored', () {
        expect(
          categorizer.categorize('main.dart.js.symbols', 50000),
          ResourceCategory.ignore,
        );
      });

      test('NOTICES is ignored', () {
        expect(
          categorizer.categorize('assets/NOTICES', 200000),
          ResourceCategory.ignore,
        );
      });

      test('sw.js is ignored', () {
        expect(categorizer.categorize('sw.js', 5000), ResourceCategory.ignore);
      });

      test('bootstrap.js is ignored', () {
        expect(
          categorizer.categorize('bootstrap.js', 15000),
          ResourceCategory.ignore,
        );
      });

      test('index.html is ignored', () {
        expect(
          categorizer.categorize('index.html', 2000),
          ResourceCategory.ignore,
        );
      });

      test('flutter_bootstrap.js is ignored', () {
        expect(
          categorizer.categorize('flutter_bootstrap.js', 3000),
          ResourceCategory.ignore,
        );
      });

      test('flutter_service_worker.js is ignored', () {
        expect(
          categorizer.categorize('flutter_service_worker.js', 3000),
          ResourceCategory.ignore,
        );
      });

      test('version.json is ignored', () {
        expect(
          categorizer.categorize('version.json', 100),
          ResourceCategory.ignore,
        );
      });

      test('flutter.js is ignored', () {
        expect(
          categorizer.categorize('flutter.js', 50000),
          ResourceCategory.ignore,
        );
      });
    });

    group('optional', () {
      test('canvaskit variant files are optional', () {
        expect(
          categorizer.categorize('canvaskit/canvaskit.js', 500000),
          ResourceCategory.optional,
        );
        expect(
          categorizer.categorize('canvaskit/canvaskit.wasm', 3000000),
          ResourceCategory.optional,
        );
      });

      test('small png is optional', () {
        expect(
          categorizer.categorize('icons/Icon-192.png', 10000),
          ResourceCategory.optional,
        );
      });

      test('small json is optional', () {
        expect(
          categorizer.categorize('assets/data.json', 500),
          ResourceCategory.optional,
        );
      });

      test('small ttf is optional', () {
        expect(
          categorizer.categorize('assets/fonts/Roboto.ttf', 60000),
          ResourceCategory.optional,
        );
      });

      test('small webp is optional', () {
        expect(
          categorizer.categorize('assets/images/bg.webp', 30000),
          ResourceCategory.optional,
        );
      });

      test('png within 512 KB cap is optional', () {
        expect(
          categorizer.categorize('assets/images/hero.png', 200000),
          ResourceCategory.optional,
        );
      });

      test('png above 512 KB cap is ignored', () {
        expect(
          categorizer.categorize('assets/images/hero.png', 600 * 1024),
          ResourceCategory.ignore,
        );
      });

      test('large ttf is optional (fonts bypass size cap)', () {
        expect(
          categorizer.categorize('assets/fonts/CupertinoIcons.ttf', 257628),
          ResourceCategory.optional,
        );
      });

      test('large otf is optional (fonts bypass size cap)', () {
        expect(
          categorizer.categorize(
            'assets/fonts/MaterialIcons-Regular.otf',
            1645184,
          ),
          ResourceCategory.optional,
        );
      });

      test('large woff2 is optional (fonts bypass size cap)', () {
        expect(
          categorizer.categorize('assets/fonts/Inter.woff2', 300000),
          ResourceCategory.optional,
        );
      });

      test('eot is optional regardless of size', () {
        expect(
          categorizer.categorize('assets/fonts/legacy.eot', 500000),
          ResourceCategory.optional,
        );
      });

      test('unknown extension is ignored', () {
        expect(
          categorizer.categorize('assets/data.xml', 500),
          ResourceCategory.ignore,
        );
      });
    });

    group('user overrides', () {
      test('core override adds to defaults', () {
        final c = FileCategorizer(coreOverrides: {'assets/critical/**'});
        expect(
          c.categorize('assets/critical/data.bin', 500000),
          ResourceCategory.core,
        );
        // Default core still works
        expect(c.categorize('main.dart.js', 1000), ResourceCategory.core);
      });

      test('ignore override adds to defaults', () {
        final c = FileCategorizer(ignoreOverrides: {'assets/video/**'});
        expect(
          c.categorize('assets/video/intro.mp4', 5000000),
          ResourceCategory.ignore,
        );
      });

      test('optional override matches files', () {
        final c = FileCategorizer(optionalOverrides: {'assets/extra/**'});
        expect(
          c.categorize('assets/extra/data.bin', 500),
          ResourceCategory.optional,
        );
      });

      test('required override adds to defaults', () {
        final c = FileCategorizer(requiredOverrides: {'assets/config.json'});
        expect(
          c.categorize('assets/config.json', 200),
          ResourceCategory.required,
        );
      });
    });

    group('priority', () {
      test('core takes precedence over ignore', () {
        // main.dart.js matches core default pattern
        expect(
          categorizer.categorize('main.dart.js', 1000),
          ResourceCategory.core,
        );
      });

      test('ignore takes precedence over optional', () {
        // version.json: matches ignore AND has .json extension
        expect(
          categorizer.categorize('version.json', 100),
          ResourceCategory.ignore,
        );
      });
    });
  });
}
