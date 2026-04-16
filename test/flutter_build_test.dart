import 'dart:io' as io;

import 'package:path/path.dart' as p;
import 'package:sw/src/flutter_build.dart';
import 'package:test/test.dart';

void main() {
  group('extractFlutterBuildInfo', () {
    late io.Directory tempDir;

    setUp(() {
      tempDir = io.Directory.systemTemp.createTempSync('sw_test_');
    });

    tearDown(() {
      tempDir.deleteSync(recursive: true);
    });

    test('parses valid flutter_bootstrap.js', () {
      final bootstrapFile = io.File(
        p.join(tempDir.path, 'flutter_bootstrap.js'),
      );
      bootstrapFile.writeAsStringSync('''
"use strict";
(function() {
  var _flutter = {};
  _flutter.buildConfig = {"engineRevision":"abc123def456","builds":[{"compileTarget":"dartdevc","renderer":"canvaskit","mainJsPath":"main.dart.js"}]};
  _flutter.loader.load();
})();
''');

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.engineRevision, 'abc123def456');
      expect(info.builds, hasLength(1));
      expect(info.builds[0]['renderer'], 'canvaskit');
      expect(info.builds[0]['mainJsPath'], 'main.dart.js');
    });

    test('parses multiple builds', () {
      final bootstrapFile = io.File(
        p.join(tempDir.path, 'flutter_bootstrap.js'),
      );
      bootstrapFile.writeAsStringSync('''
_flutter.buildConfig = {"engineRevision":"rev123","builds":[{"compileTarget":"dart2wasm","renderer":"skwasm","mainWasmPath":"main.dart.wasm"},{"compileTarget":"dartdevc","renderer":"canvaskit","mainJsPath":"main.dart.js"}]};
''');

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.engineRevision, 'rev123');
      expect(info.builds, hasLength(2));
      expect(info.builds[0]['renderer'], 'skwasm');
      expect(info.builds[1]['renderer'], 'canvaskit');
    });

    test('throws if flutter_bootstrap.js not found', () {
      expect(
        () => extractFlutterBuildInfo(tempDir),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('flutter_bootstrap.js not found'),
          ),
        ),
      );
    });

    test('throws if buildConfig not found in file', () {
      final bootstrapFile = io.File(
        p.join(tempDir.path, 'flutter_bootstrap.js'),
      );
      bootstrapFile.writeAsStringSync('// empty file');

      expect(
        () => extractFlutterBuildInfo(tempDir),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('Could not find _flutter.buildConfig'),
          ),
        ),
      );
    });

    test('handles missing engineRevision gracefully', () {
      final bootstrapFile = io.File(
        p.join(tempDir.path, 'flutter_bootstrap.js'),
      );
      bootstrapFile.writeAsStringSync('''
_flutter.buildConfig = {"builds":[{"compileTarget":"dartdevc","renderer":"canvaskit"}]};
''');

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.engineRevision, '');
      expect(info.builds, hasLength(1));
    });
  });

  group('getConfiguredRenderers', () {
    test('extracts renderer names', () {
      final info = FlutterBuildInfo(
        engineRevision: 'abc',
        builds: [
          {'renderer': 'canvaskit'},
          {'renderer': 'skwasm'},
        ],
      );

      final renderers = getConfiguredRenderers(info);
      expect(renderers, containsAll(['canvaskit', 'skwasm']));
      expect(renderers, hasLength(2));
    });

    test('handles builds without renderer', () {
      final info = FlutterBuildInfo(
        engineRevision: 'abc',
        builds: [
          {'compileTarget': 'dartdevc'},
        ],
      );

      final renderers = getConfiguredRenderers(info);
      expect(renderers, isEmpty);
    });

    test('deduplicates renderers', () {
      final info = FlutterBuildInfo(
        engineRevision: 'abc',
        builds: [
          {'renderer': 'canvaskit'},
          {'renderer': 'canvaskit'},
        ],
      );

      final renderers = getConfiguredRenderers(info);
      expect(renderers, hasLength(1));
    });
  });
}
