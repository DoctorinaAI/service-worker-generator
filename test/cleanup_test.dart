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
      expect(
        io.File(p.join(tempDir.path, 'version.json')).existsSync(),
        isFalse,
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
      io.File(p.join(tempDir.path, 'version.json')).deleteSync();

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
  });
}
