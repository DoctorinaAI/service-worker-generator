import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:sw/src/cleanup.dart';
import 'package:test/test.dart';

void main() {
  group('cleanup', () {
    late io.Directory tempDir;

    setUp(() {
      tempDir = io.Directory.systemTemp.createTempSync('sw_test_');
      // Create standard Flutter build files
      io.File(
        p.join(tempDir.path, 'index.html'),
      ).writeAsStringSync('<html>{{sw_version}}</html>');
      io.File(
        p.join(tempDir.path, 'flutter_bootstrap.js'),
      ).writeAsStringSync('bootstrap');
      io.File(
        p.join(tempDir.path, 'flutter_service_worker.js'),
      ).writeAsStringSync('sw');
      io.File(p.join(tempDir.path, 'flutter.js')).writeAsStringSync('flutter');
      io.File(
        p.join(tempDir.path, 'version.json'),
      ).writeAsStringSync('{"version":"1"}');
      io.File(p.join(tempDir.path, 'main.dart.js')).writeAsStringSync('main');
      io.File(
        p.join(tempDir.path, 'main.dart.js.map'),
      ).writeAsStringSync('sourcemap');
      io.File(
        p.join(tempDir.path, 'main.dart.js.symbols'),
      ).writeAsStringSync('symbols');
    });

    tearDown(() {
      tempDir.deleteSync(recursive: true);
    });

    test('removes Flutter files', () {
      cleanup(buildDir: tempDir, swVersion: 'v1');

      expect(
        io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
        isFalse,
      );
      expect(
        io.File(p.join(tempDir.path, 'flutter_service_worker.js')).existsSync(),
        isFalse,
      );
      expect(io.File(p.join(tempDir.path, 'flutter.js')).existsSync(), isFalse);
    });

    test('keeps flutter_bootstrap.js while index.html still loads it', () {
      // Without it the page would be blank: the index.html swap was skipped.
      io.File(p.join(tempDir.path, 'index.html')).writeAsStringSync(
        '<html><body><script src="flutter_bootstrap.js" async></script>'
        ' </body></html>',
      );
      cleanup(buildDir: tempDir, swVersion: 'v1');
      expect(
        io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
        isTrue,
      );
      expect(
        io.File(p.join(tempDir.path, 'flutter_service_worker.js')).existsSync(),
        isFalse,
      );
    });

    test('removes flutter_bootstrap.js once index.html loads bootstrap.js', () {
      io.File(p.join(tempDir.path, 'index.html')).writeAsStringSync(
        '<html><body><!-- replaces flutter_bootstrap.js --> '
        '<script src="bootstrap.js" data-sw-bootstrap defer></script> '
        '</body></html>',
      );
      cleanup(buildDir: tempDir, swVersion: 'v1');
      expect(
        io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
        isFalse,
      );
    });

    test('recognises every way a script tag can load flutter_bootstrap', () {
      const tags = [
        "<script type=module src='flutter_bootstrap.js'></script>",
        '<script src=flutter_bootstrap.js async></script>',
        '<script src="/app/flutter_bootstrap.js?v=1"></script>',
        '<SCRIPT SRC="FLUTTER_BOOTSTRAP.JS"></SCRIPT>',
        '<script\n  async\n  src = "flutter_bootstrap.js"></script>',
      ];
      final bootstrap = io.File(p.join(tempDir.path, 'flutter_bootstrap.js'));
      final index = io.File(p.join(tempDir.path, 'index.html'));
      for (final tag in tags) {
        bootstrap.writeAsStringSync('bootstrap');
        index.writeAsStringSync('<html><body>$tag</body></html>');
        cleanup(buildDir: tempDir, swVersion: 'v1');
        expect(bootstrap.existsSync(), isTrue, reason: tag);
      }
    });

    test('a tag that does not load flutter_bootstrap.js does not keep it', () {
      const tags = [
        '<!-- <script src="flutter_bootstrap.js"></script> -->',
        '<!--\n<script src="flutter_bootstrap.js"></script>\n-->',
        '<script data-src="flutter_bootstrap.js"></script>',
        '<script src="my_flutter_bootstrap.js"></script>',
        '<script src="flutter_bootstrap.json"></script>',
      ];
      final bootstrap = io.File(p.join(tempDir.path, 'flutter_bootstrap.js'));
      final index = io.File(p.join(tempDir.path, 'index.html'));
      for (final tag in tags) {
        bootstrap.writeAsStringSync('bootstrap');
        index.writeAsStringSync(
          '<html><body>$tag<script src="bootstrap.js" '
          'data-sw-bootstrap defer></script></body></html>',
        );
        cleanup(buildDir: tempDir, swVersion: 'v1');
        expect(bootstrap.existsSync(), isFalse, reason: tag);
      }
    });

    test('a preload hint alone does not keep flutter_bootstrap.js', () {
      // Only a script tag runs it; a <link> just warms the HTTP cache.
      io.File(p.join(tempDir.path, 'index.html')).writeAsStringSync('''
<html><head>
<link rel="preload" href="flutter_bootstrap.js" as="script">
</head><body>
<script src="bootstrap.js" data-sw-bootstrap defer></script>
</body></html>
''');
      cleanup(buildDir: tempDir, swVersion: 'v1');
      expect(
        io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
        isFalse,
      );
    });

    test('removes flutter_bootstrap.js when there is no index.html', () {
      io.File(p.join(tempDir.path, 'index.html')).deleteSync();
      cleanup(buildDir: tempDir, swVersion: 'v1');
      expect(
        io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).existsSync(),
        isFalse,
      );
    });

    test('applyIndexHtmlVersion reports whether it rewrote the shell', () {
      final index = io.File(p.join(tempDir.path, 'index.html'));
      expect(applyIndexHtmlVersion(tempDir, 'v1'), isTrue);
      expect(index.readAsStringSync(), '<html>v1</html>');
      // Idempotent: nothing left to substitute, so the file is not touched.
      expect(applyIndexHtmlVersion(tempDir, 'v2'), isFalse);
      expect(index.readAsStringSync(), '<html>v1</html>');
      index.deleteSync();
      expect(applyIndexHtmlVersion(tempDir, 'v3'), isFalse);
    });

    test('keeps canvaskit files outside the keep-set subdirectories', () {
      final ckDir = io.Directory(p.join(tempDir.path, 'canvaskit', 'chromium'))
        ..createSync(recursive: true);
      io.File(p.join(ckDir.path, 'canvaskit.js')).writeAsStringSync('js');
      io.File(p.join(ckDir.path, 'canvaskit.wasm')).writeAsStringSync('wasm');
      io.File(
        p.join(tempDir.path, 'canvaskit', 'skwasm.wasm'),
      ).writeAsStringSync('sw');

      cleanup(
        buildDir: tempDir,
        swVersion: 'v1',
        canvaskitKeep: const {
          'canvaskit/chromium/canvaskit.js',
          'canvaskit/chromium/canvaskit.wasm',
        },
      );

      // A kept nested file keeps its directory alive.
      expect(io.File(p.join(ckDir.path, 'canvaskit.js')).existsSync(), isTrue);
      expect(
        io.File(p.join(ckDir.path, 'canvaskit.wasm')).existsSync(),
        isTrue,
      );
      expect(
        io.File(p.join(tempDir.path, 'canvaskit', 'skwasm.wasm')).existsSync(),
        isFalse,
      );
    });

    test('preserves version.json', () {
      cleanup(buildDir: tempDir, swVersion: 'v1');

      expect(
        io.File(p.join(tempDir.path, 'version.json')).existsSync(),
        isTrue,
      );
    });

    test('removes map files by default', () {
      cleanup(buildDir: tempDir, swVersion: 'v1');

      expect(
        io.File(p.join(tempDir.path, 'main.dart.js.map')).existsSync(),
        isFalse,
      );
      expect(
        io.File(p.join(tempDir.path, 'main.dart.js.symbols')).existsSync(),
        isFalse,
      );
    });

    test('keeps map files when keepMaps is true', () {
      cleanup(buildDir: tempDir, swVersion: 'v1', keepMaps: true);

      expect(
        io.File(p.join(tempDir.path, 'main.dart.js.map')).existsSync(),
        isTrue,
      );
      expect(
        io.File(p.join(tempDir.path, 'main.dart.js.symbols')).existsSync(),
        isTrue,
      );
    });

    test('replaces {{sw_version}} in index.html', () {
      cleanup(buildDir: tempDir, swVersion: 'abc123');

      final content = io.File(
        p.join(tempDir.path, 'index.html'),
      ).readAsStringSync();
      expect(content, contains('abc123'));
      expect(content, isNot(contains('{{sw_version}}')));
    });

    test('replaces {{flutter_service_worker_version}} in index.html', () {
      io.File(p.join(tempDir.path, 'index.html')).writeAsStringSync(
        '<script>var v = "{{flutter_service_worker_version}}";</script>',
      );

      cleanup(buildDir: tempDir, swVersion: 'ver42');

      final content = io.File(
        p.join(tempDir.path, 'index.html'),
      ).readAsStringSync();
      expect(content, contains('ver42'));
      expect(content, isNot(contains('{{flutter_service_worker_version}}')));
    });

    test('preserves main.dart.js', () {
      cleanup(buildDir: tempDir, swVersion: 'v1');

      expect(
        io.File(p.join(tempDir.path, 'main.dart.js')).existsSync(),
        isTrue,
      );
    });

    test('handles missing files gracefully', () {
      // Remove all Flutter files before cleanup
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).deleteSync();
      io.File(p.join(tempDir.path, 'flutter_service_worker.js')).deleteSync();
      io.File(p.join(tempDir.path, 'flutter.js')).deleteSync();

      // Should not throw
      cleanup(buildDir: tempDir, swVersion: 'v1');
    });

    test('removes map files in subdirectories', () {
      final subDir = io.Directory(p.join(tempDir.path, 'canvaskit'))
        ..createSync();
      io.File(p.join(subDir.path, 'canvaskit.js.map')).writeAsStringSync('map');

      cleanup(buildDir: tempDir, swVersion: 'v1');

      expect(
        io.File(p.join(subDir.path, 'canvaskit.js.map')).existsSync(),
        isFalse,
      );
    });

    test('removes .last_build_id and .wasm.map', () {
      io.File(p.join(tempDir.path, '.last_build_id')).writeAsStringSync('abc');
      io.File(
        p.join(tempDir.path, 'main.dart.wasm.map'),
      ).writeAsStringSync('wasm-map');

      cleanup(buildDir: tempDir, swVersion: 'v1');

      expect(
        io.File(p.join(tempDir.path, '.last_build_id')).existsSync(),
        isFalse,
      );
      expect(
        io.File(p.join(tempDir.path, 'main.dart.wasm.map')).existsSync(),
        isFalse,
      );
    });

    test('prunes unused canvaskit variants', () {
      final ckDir = io.Directory(p.join(tempDir.path, 'canvaskit'))
        ..createSync();
      final chromiumDir = io.Directory(p.join(ckDir.path, 'chromium'))
        ..createSync();
      io.File(p.join(ckDir.path, 'canvaskit.js')).writeAsStringSync('cjs');
      io.File(p.join(ckDir.path, 'canvaskit.wasm')).writeAsStringSync('cw');
      io.File(
        p.join(chromiumDir.path, 'canvaskit.wasm'),
      ).writeAsStringSync('x');
      io.File(p.join(ckDir.path, 'skwasm.js')).writeAsStringSync('sjs');
      io.File(p.join(ckDir.path, 'skwasm.wasm')).writeAsStringSync('sw');

      cleanup(
        buildDir: tempDir,
        swVersion: 'v1',
        canvaskitKeep: const {'canvaskit/skwasm.js', 'canvaskit/skwasm.wasm'},
      );

      expect(io.File(p.join(ckDir.path, 'skwasm.js')).existsSync(), isTrue);
      expect(io.File(p.join(ckDir.path, 'skwasm.wasm')).existsSync(), isTrue);
      expect(io.File(p.join(ckDir.path, 'canvaskit.js')).existsSync(), isFalse);
      expect(
        io.File(p.join(ckDir.path, 'canvaskit.wasm')).existsSync(),
        isFalse,
      );
      expect(chromiumDir.existsSync(), isFalse);
    });
  });
}
