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
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).writeAsStringSync(
        '''
"use strict";
(function() {
  var _flutter = {};
  _flutter.buildConfig = {"engineRevision":"abc123def456","builds":[{"compileTarget":"dartdevc","renderer":"canvaskit","mainJsPath":"main.dart.js"}]};
  _flutter.loader.load();
})();
''',
      );

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.engineRevision, 'abc123def456');
      expect(info.builds, hasLength(1));
      expect(info.builds[0]['renderer'], 'canvaskit');
      expect(info.builds[0]['mainJsPath'], 'main.dart.js');
    });

    test('parses multiple builds', () {
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).writeAsStringSync(
        '''
_flutter.buildConfig = {"engineRevision":"rev123","builds":[{"compileTarget":"dart2wasm","renderer":"skwasm","mainWasmPath":"main.dart.wasm"},{"compileTarget":"dartdevc","renderer":"canvaskit","mainJsPath":"main.dart.js"}]};
''',
      );

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
      io.File(
        p.join(tempDir.path, 'flutter_bootstrap.js'),
      ).writeAsStringSync('// empty file');

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

    test('names the parsed file and the fix when buildConfig is missing', () {
      final file = io.File(p.join(tempDir.path, 'flutter_bootstrap.js'))
        ..writeAsStringSync('// empty file');

      expect(
        () => extractFlutterBuildInfo(tempDir),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            allOf(contains(file.path), contains('flutter build web')),
          ),
        ),
      );
    });

    test('throws on a buildConfig that is not valid JSON', () {
      io.File(
        p.join(tempDir.path, 'flutter_bootstrap.js'),
      ).writeAsStringSync("_flutter.buildConfig = {engineRevision: 'abc'};");

      expect(
        () => extractFlutterBuildInfo(tempDir),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            contains('Failed to parse buildConfig JSON'),
          ),
        ),
      );
    });

    test('drops empty and non-object build entries', () {
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).writeAsStringSync(
        '''
_flutter.buildConfig = {"engineRevision":"r","builds":[{}, "x", {"renderer":"skwasm"}]};
''',
      );

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.builds, [
        {'renderer': 'skwasm'},
      ]);
    });

    test('treats a non-boolean useLocalCanvasKit as false', () {
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).writeAsStringSync(
        '''
_flutter.buildConfig = {"engineRevision":"r","builds":[],"useLocalCanvasKit":"true"};
''',
      );

      expect(extractFlutterBuildInfo(tempDir).useLocalCanvasKit, isFalse);
    });

    test('handles missing engineRevision gracefully', () {
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).writeAsStringSync(
        '''
_flutter.buildConfig = {"builds":[{"compileTarget":"dartdevc","renderer":"canvaskit"}]};
''',
      );

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.engineRevision, '');
      expect(info.builds, hasLength(1));
    });

    test('reads useLocalCanvasKit from a --no-web-resources-cdn build', () {
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).writeAsStringSync(
        '''
_flutter.buildConfig = {"engineRevision":"rev123","builds":[{"compileTarget":"dart2wasm","renderer":"skwasm"}],"useLocalCanvasKit":true};
''',
      );

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.useLocalCanvasKit, isTrue);
    });

    test('defaults useLocalCanvasKit to false when Flutter omits it', () {
      io.File(p.join(tempDir.path, 'flutter_bootstrap.js')).writeAsStringSync(
        '''
_flutter.buildConfig = {"engineRevision":"rev123","builds":[{"compileTarget":"dart2wasm","renderer":"skwasm"}]};
''',
      );

      final info = extractFlutterBuildInfo(tempDir);
      expect(info.useLocalCanvasKit, isFalse);
    });
  });

  group('getConfiguredRenderers', () {
    test('extracts renderer names', () {
      const info = FlutterBuildInfo(
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
      const info = FlutterBuildInfo(
        engineRevision: 'abc',
        builds: [
          {'compileTarget': 'dartdevc'},
        ],
      );

      final renderers = getConfiguredRenderers(info);
      expect(renderers, isEmpty);
    });

    test('deduplicates renderers', () {
      const info = FlutterBuildInfo(
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

  /// Audit #30, item 3.7: the literal used to be found with a lazy
  /// `\{[\s\S]*?\}\s*;`, which stops at the first `}` followed by a `;`.
  /// Today's output happens not to contain one inside the object; a future
  /// release, or a string value, easily could.
  group('extractBuildConfigLiteral', () {
    test('takes the whole object, nested braces included', () {
      const source =
          '_flutter.buildConfig = {"a":{"b":{"c":1}},"d":2};\nmore();';
      expect(extractBuildConfigLiteral(source), '{"a":{"b":{"c":1}},"d":2}');
    });

    test('is not cut short by a "};" inside a string', () {
      const source =
          '_flutter.buildConfig = {"note":"a }; in a string","x":1};';
      expect(
        extractBuildConfigLiteral(source),
        '{"note":"a }; in a string","x":1}',
      );
    });

    test('is not cut short by an escaped quote before a brace', () {
      const source = r'_flutter.buildConfig = {"q":"\"};","x":1};';
      expect(extractBuildConfigLiteral(source), r'{"q":"\"};","x":1}');
    });

    test('sees through a wrapper call', () {
      const source = '_flutter.buildConfig = Object.freeze({"x":1});';
      expect(extractBuildConfigLiteral(source), '{"x":1}');
    });

    test('tolerates whitespace and newlines around the assignment', () {
      const source = '_flutter.buildConfig =\n  {\n  "x": 1\n};';
      expect(extractBuildConfigLiteral(source), '{\n  "x": 1\n}');
    });

    test('returns null when there is no buildConfig', () {
      expect(extractBuildConfigLiteral('_flutter.loader.load();'), isNull);
    });

    test('returns null for a truncated object', () {
      expect(
        extractBuildConfigLiteral('_flutter.buildConfig = {"x":1'),
        isNull,
      );
    });

    test('returns null when something other than a wrapper precedes it', () {
      // A future release that computes the config: there is no literal to
      // read, and guessing one would be worse than saying so.
      expect(
        extractBuildConfigLiteral(
          '_flutter.buildConfig = makeIt() || {"x":1};',
        ),
        isNull,
      );
    });
  });
}
